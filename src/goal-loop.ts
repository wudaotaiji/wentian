/**
 * Goal Loop: 5層アーキテクチャ L3 (Ralph Wiggum式自動継続ループ)
 * 設計参照: docs/ARCHITECTURE.md
 *
 * 1TODO = 1会話 = 1回の executePlannedTurn 相当を実行し、
 * 成功/失敗/中断に応じて Goal Store を更新しながら完了まで自動継続します。
 *
 * - Memory Layer (L2) はループ先頭で毎イテレーション組み立て、conversation 先頭に注入
 * - 各 TODO は短い sub-conversation として実行 (履歴が肥大化しない)
 * - SIGINT 1回目で status='paused' に保存して終了、2回目で強制終了
 * - maxConsecutiveFailures / maxTotalAttempts / maxWallClockHours のいずれかで status='aborted'
 */
import type { AgentPlan } from './agent-planner.js';
import { createAgentPlan } from './agent-planner.js';
import { buildMemoryLayer } from './memory-layer.js';
import type { GoalStatus, GoalStore, GoalTodo } from './goal-store.js';
import { activateTodo, formatGoalProgress, isGoalFinished, loadGoal, markDone, markFailed, pickNextTodo, saveGoal, updateTodo } from './goal-store.js';
import { checkpointComplete, checkpointRollback, checkpointStart, type CheckpointResult } from './git-checkpoint.js';
import { auditGoal, shouldAuditGoal, type AuditAgent } from './goal-audit.js';
import { reconcileGoalTransactions, txComplete, txFail, txStart, txTouch } from './goal-transaction.js';
import type { CompactorConversationMessage } from './agent-compactor.js';
import { verifyDelivery, type DeliveryVerification } from './delivery-verification.js';
import { consumeGoalPause } from './goal-store.js';

export interface GoalLoopOptions {
  remainingTokens?: number;
  remainingCostUsd?: number;
  /** ホスト側検証の差し替え口。モデルの出力からは設定できません。 */
  verifyDelivery?: typeof verifyDelivery;
  cwd: string;
  server: string;
  model: string;
  forceWeb: boolean;
  /** 1TODOの最大内部ターン数。超えたらブロックして次へ */
  maxInnerTurns?: number;
  /** デバッグログを emit するか */
  debug?: boolean;
  /** SIGINT受信ハンドラを差し込む (テスト用) */
  signal?: AbortSignal;
  /** tick毎に呼ばれる進捗ログ */
  onTick?: (line: string) => void;
  /** TODO実行時のサブ会話構築用Planner互換関数 (テストでモックできる) */
  runOneTodo?: RunOneTodoFn;
  /** L5: 外部Agent監査 (省略時は監査なし) */
  auditAgent?: AuditAgent;
  /** L5: 監査頻度 (デフォルト5) */
  auditEvery?: number;
  /** 自己修正の前後を比較し、改善を確認できた変更だけを採用する品質ゲート。 */
  qualityGate?: GoalQualityGate;
}

export interface GoalQualityGate {
  captureBaseline(cwd: string, signal?: AbortSignal): Promise<unknown>;
  evaluate(cwd: string, baseline: unknown, signal?: AbortSignal): Promise<{ passed: boolean; summary: string; reportPath?: string }>;
}

export interface RunOneTodoInput {
  todo: GoalTodo;
  goal: GoalStore;
  memoryMessages: CompactorConversationMessage[];
  options: GoalLoopOptions;
}

export type RunOneTodoFn = (input: RunOneTodoInput) => Promise<RunOneTodoResult>;

export interface RunOneTodoResult {
  costUsd?: number;
  replans?: number;
  usage?: GoalTodo['usage'];
  ok: boolean;
  /** 成功時のチェックポイント (Phase 4 でgit commit SHAを返す) */
  checkpoint?: string | null;
  /** 成功時のサマリ (commit message等) */
  summary?: string;
  /** 失敗時のエラーメッセージ */
  error?: string;
  /** 失敗詳細 (デバッグ用) */
  detail?: string;
}

export interface GoalLoopResult {
  goal: GoalStore;
  /** ループを抜けた理由 */
  reason: 'completed' | 'aborted' | 'paused' | 'no-todo' | 'error';
  totalTicks: number;
}

/** 1TODOを実行するヘルパーを生成します。cli.tsのexecutePlannedTurnをラップしてテストで差し替え可能にします。 */
export function buildExecutePlannedTurnRunner(executePlannedTurn: (input: {
  server: string; model: string; prompt: string; forceWeb: boolean;
  images: never[]; conversation: CompactorConversationMessage[]; onTick: (line: string) => void;
}) => Promise<void>): RunOneTodoFn {
  return async (input) => {
    const { todo, goal, memoryMessages, options } = input;
    const conversation: CompactorConversationMessage[] = [
      ...memoryMessages,
      { role: 'user', content: goalTextPrompt(goal, todo) },
    ];
    try {
      await executePlannedTurn({
        server: options.server, model: options.model,
        prompt: goalTextPrompt(goal, todo), forceWeb: options.forceWeb,
        images: [], conversation,
        onTick: line => options.onTick?.(line),
      });
      const lastAssistant = [...conversation].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string');
      if (!lastAssistant) return { ok: false, error: 'assistant応答が空', detail: 'no assistant message' };
      return { ok: true, checkpoint: null, summary: typeof lastAssistant.content === 'string' ? lastAssistant.content.slice(0, 200) : '完了' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

function goalTextPrompt(goal: GoalStore, todo: GoalTodo): string {
  return [
    `Goal: ${goal.title}`,
    `Description: ${goal.description}`,
    ``,
    `TODO [${todo.id}]: ${todo.title}`,
    todo.description ? `Details: ${todo.description}` : '',
    todo.dependsOn.length ? `Depends on: ${todo.dependsOn.join(', ')}` : '',
    ``,
    `このTODOを完遂してください。完了したら「DONE: <一行サマリ>」で報告してください。`,
    `エラーや人間判断が必要なら「BLOCKED: <理由>」で報告してください。`,
  ].filter(Boolean).join('\n');
}

/**
 * Goal Loop を開始し、完走/中断/aborted のいずれかまで自動で回します。
 * 1イテレーション = Memory Layer 再注入 → pickNextTodo → TODO実行 → markDone/markFailed。
 */
export async function runGoalLoop(goalId: string, options: GoalLoopOptions): Promise<GoalLoopResult> {
  let goal: GoalStore = await loadGoal(goalId);
  if (goal.status === 'completed') return { goal, reason: 'completed', totalTicks: 0 };
  const emit = (line: string) => options.onTick?.(line);
  // 明示注入がなければプロジェクト固定設定を自動検出します。設定不備は安全側で開始前に拒否します。
  const qualityGate = options.qualityGate ?? await (await import('./self-evolution-gate.js')).SelfEvolutionGate.loadIfConfigured(options.cwd);
  // Phase 7: 電源断後のactive TODO整合 (txが start/checkpoint/running なら rolled-back, done/failed なら recovered)
  if (goal.status === 'active' || goal.status === 'paused') {
    const reconcile = await reconcileGoalTransactions(goal, options.cwd).catch(error => {
      emit(`[Goal Loop] tx.reconcile失敗 (継続): ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (reconcile && reconcile.reconciled > 0) {
      emit(`[Goal Loop] tx.reconcile: ${reconcile.reconciled}件整合 (recovered=${reconcile.recovered}, rolledBack=${reconcile.rolledBack})`);
      for (const d of reconcile.details) emit(`  - [${d.todoId}] ${d.action} (checkpoint=${d.checkpointSha || 'none'})`);
    }
    // reconcile 後に status を再評価 (active だったものが pending に戻った等)
    if (goal.status === 'paused') {
      // resume意図
    }
  }
  if (goal.status === 'paused') {
    // paused から active へ戻す際、active 状態で残ったTODOは pending へ戻して再試行可能にする
    for (const todo of goal.todos) {
      if (todo.status === 'active') {
        todo.status = 'pending';
        todo.lastError = 'resumed from paused';
      }
    }
    goal.status = 'active';
    await saveGoal(goal);
  }
  const startedAt = Date.now();
  const previousRuntimeMs = goal.metrics.elapsedRuntimeMs ?? 0;
  const runOne = options.runOneTodo;
  if (!runOne) throw new Error('runOneTodo 実装が指定されていません。cli.tsのexecutePlannedTurnを buildExecutePlannedTurnRunner でラップして渡してください。');
  const maxWallMs = Math.max(0,goal.stop.maxWallClockHours * 60 * 60 * 1000 - previousRuntimeMs);
  let tick = 0;

  // 中断ハンドラ (SIGINT)
  let interruptedOnce = false;
  let inFlightAbort: Promise<void> | undefined;
  const onAbort = async () => {
    if (interruptedOnce) {
      // 2回目は早期return (3回目以降のprocess.exitは要件外)
      return;
    }
    interruptedOnce = true;
    emit('[Goal Loop] 中断を検出しました。現在のTODOをpendingへ戻して保存します。');
    const reloaded = await loadGoal(goalId);
    for (const todo of reloaded.todos) {
      if (todo.status === 'active') {
        todo.status = 'pending';
        todo.lastError = 'human interrupted';
      }
    }
    reloaded.status = 'paused';
    reloaded.metrics.consecutiveFailures += 1;
    await saveGoal(reloaded);
    goal = reloaded;
    emit(`[Goal Loop] status=paused で保存しました。再開: wentian agent --goal ${reloaded.id}`);
  };
  if (options.signal) {
    if (options.signal.aborted) { await onAbort(); return { goal, reason: 'paused', totalTicks: tick }; }
    options.signal.addEventListener('abort', () => { inFlightAbort = onAbort().catch(() => undefined); });
  }

  while (true) {
    // status が active 以外になったらループを抜ける
    const currentStatus = goal.status as GoalStatus;
    if (currentStatus !== 'active') {
      let reason: GoalLoopResult['reason'] = 'paused';
      if (currentStatus === 'completed') reason = 'completed';
      else if (currentStatus === 'aborted') reason = 'aborted';
      return { goal, reason, totalTicks: tick };
    }
    if (Date.now() - startedAt > maxWallMs) {
      goal.metrics.elapsedRuntimeMs = previousRuntimeMs + Date.now() - startedAt;
      goal.status = 'aborted'; await saveGoal(goal);
      emit(`[Goal Loop] maxWallClockHours (${goal.stop.maxWallClockHours}h) 到達 → aborted`);
      return { goal, reason: 'aborted', totalTicks: tick };
    }
    if (goal.metrics.totalAttempts >= goal.stop.maxTotalAttempts) {
      goal.status = 'aborted'; await saveGoal(goal);
      emit(`[Goal Loop] maxTotalAttempts (${goal.stop.maxTotalAttempts}) 到達 → aborted`);
      return { goal, reason: 'aborted', totalTicks: tick };
    }
    if (isGoalFinished(goal)) {
      goal.status = 'completed'; await saveGoal(goal);
      emit(`[Goal Loop] 全TODO完了 → status=completed`);
      return { goal, reason: 'completed', totalTicks: tick };
    }
    const next = pickNextTodo(goal);
    if (!next) {
      emit(`[Goal Loop] 次に着手できるTODOがありません (pending/active なし)`);
      return { goal, reason: 'no-todo', totalTicks: tick };
    }
    const budgetReason = (goal.metrics.totalTokens ?? 0) >= (goal.stop.maxTokens ?? 500_000) ? 'トークン数（Tokens）' :
      goal.stop.maxCostUsd !== undefined && (goal.metrics.totalCostUsd ?? 0) >= goal.stop.maxCostUsd ? '費用（Cost）' :
      (goal.metrics.totalReplans ?? 0) > (goal.stop.maxReplans ?? 3) ? '再計画回数（Replans）' : undefined;
    if (budgetReason) { goal.status = 'aborted'; await saveGoal(goal); emit(`実行予算（Execution Budget）の${budgetReason}上限に到達したため停止しました。`); return { goal, reason: 'aborted', totalTicks: tick }; }

    if (await consumeGoalPause(goalId)) {
      goal.status = 'paused'; await saveGoal(goal);
      return { goal, reason: 'paused', totalTicks: tick };
    }
    // 実行中にAgentが条件を書き換えても検証対象が変わらないようコピーします。
    const acceptance = structuredClone(next.acceptance || []);
    tick += 1;
    // active化 + checkpointStart (L4) + txStart (Phase 7)
    await activateTodo(goal, next.id);
    const startHead = await checkpointStart(goal, next, options.cwd, { allowFailure: true });
    await txStart(goal, next, options.cwd);
    emit(`[Goal Loop] tick=${tick} ${formatGoalProgress(goal)}`);
    emit(`[Goal Loop] 着手: [${next.id}] ${next.title} (startHead=${startHead || 'no-git'})`);

    // Memory Layer 注入 (compact除外付き)
    const memoryMessages = await buildMemoryLayer({ cwd: options.cwd, goal });

    // 1TODO実行前に固定評価のベースラインを取得します。取得できない場合は変更を開始しません。
    let baseline: unknown;
    let result: RunOneTodoResult;
    try {
      baseline = qualityGate ? await qualityGate.captureBaseline(options.cwd, options.signal) : undefined;
      const remainingTokens = Math.max(0, (goal.stop.maxTokens ?? 500_000) - (goal.metrics.totalTokens ?? 0));
      const remainingCostUsd = goal.stop.maxCostUsd === undefined ? undefined : Math.max(0, goal.stop.maxCostUsd - (goal.metrics.totalCostUsd ?? 0));
      // 実時間上限を実行中のFetch・外部プロセス（Process）にも伝播します。
      const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(maxWallMs - (Date.now() - startedAt))));
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      result = await runOne({ todo: next, goal, memoryMessages, options: { ...options, signal, remainingTokens, remainingCostUsd } });
    } catch (error) {
      result = { ok: false, error: `品質ゲートのベースライン取得に失敗しました: ${error instanceof Error ? error.message : String(error)}` };
    }

    goal.metrics.elapsedRuntimeMs = previousRuntimeMs + Date.now() - startedAt;
    if (result.usage) { next.usage = result.usage; goal.metrics.totalTokens = (goal.metrics.totalTokens ?? 0) + Math.max(0, result.usage.total); }
    if (result.costUsd !== undefined) goal.metrics.totalCostUsd = (goal.metrics.totalCostUsd ?? 0) + Math.max(0, result.costUsd);
    goal.metrics.totalReplans = (goal.metrics.totalReplans ?? 0) + Math.max(0, result.replans ?? (next.attempts > 1 ? 1 : 0));
    if (goal.stop.maxCostUsd !== undefined && result.costUsd === undefined) {
      goal.status = 'aborted'; next.status = 'blocked'; next.lastError = '費用上限が指定されていますが実行先の費用を確認できません。'; await saveGoal(goal);
      emit(next.lastError); return { goal, reason: 'aborted', totalTicks: tick };
    }
    // Agentが成功を報告しても、固定評価が不合格なら通常の失敗経路でロールバックします。
    if (result.ok && qualityGate) {
      try {
        const evaluation = await qualityGate.evaluate(options.cwd, baseline, options.signal);
        emit(`[Goal Loop] 品質ゲート: ${evaluation.passed ? 'passed' : 'failed'} ${evaluation.summary}`);
        if (evaluation.reportPath) emit(`  report: ${evaluation.reportPath}`);
        if (!evaluation.passed) result = { ok: false, error: `品質ゲート不合格: ${evaluation.summary}` };
      } catch (error) {
        result = { ok: false, error: `品質ゲート実行失敗: ${error instanceof Error ? error.message : String(error)}` };
      }
    }

    if (result.ok) {
      let verification: DeliveryVerification;
      try { verification = await (options.verifyDelivery || verifyDelivery)(options.cwd, acceptance); }
      catch (error) { verification = { status: 'failed', checkedAt: new Date().toISOString(), evidence: [], summary: String(error) }; }
      next.verification = verification;
      next.acceptance = acceptance;
      if (verification.status !== 'passed') {
        // 証拠不足は成功にも自動再試行にもせず、成果物を残して人間の確認を待ちます。
        next.status = 'blocked'; next.lastError = verification.summary;
        goal.blocked = goal.blocked.filter(item => item.todoId !== next.id);
        goal.blocked.push({ todoId: next.id, reason: verification.summary, since: verification.checkedAt });
        goal.metrics.blockedCount = goal.blocked.length;
        goal.status = 'paused';
        await txComplete(goal, next.id); await saveGoal(goal);
        emit(`[Goal Loop] 検証待ち: ${verification.summary}`);
        return { goal, reason: 'paused', totalTicks: tick };
      }
      emit(`[Goal Loop] 成果検証: ${verification.summary}`);
    }

    if (result.ok) {
      // 成功時: checkpointComplete でcommit (L4) → txComplete → markDone
      const checkpoint: CheckpointResult = await checkpointComplete(goal, next, result.summary || next.title, options.cwd, { allowFailure: true });
      await txTouch(goal, next.id, 'done');
      await markDone(goal, next.id, checkpoint.sha);
      await txComplete(goal, next.id);
      emit(`[Goal Loop] ✓ 完了: [${next.id}] ${next.title} (checkpoint=${checkpoint.sha || 'none'})`);
      if (result.summary) emit(`  summary: ${result.summary.slice(0, 160)}`);
      emit(`  ${checkpoint.message}`);
    } else {
      // 失敗時: checkpointRollback (L4) → txFail → markFailed
      const rollback = await checkpointRollback(goal, next, result.error || 'unknown', options.cwd, { allowFailure: true });
      await txFail(goal, next.id, result.error || 'unknown');
      const consecutive = await markFailed(goal, next.id, result.error || 'unknown');
      emit(`[Goal Loop] ✗ 失敗: [${next.id}] ${next.title} (consecutive=${consecutive}/${goal.stop.maxConsecutiveFailures})`);
      if (result.detail) emit(`  detail: ${result.detail.slice(0, 200)}`);
      emit(`  ${rollback.message}`);
      if ((goal.status as GoalStatus) === 'aborted') {
        emit(`[Goal Loop] consecutiveFailures 上限到達 → status=aborted`);
        return { goal, reason: 'aborted', totalTicks: tick };
      }
    }

    if (await consumeGoalPause(goalId)) {
      goal.status = 'paused'; await saveGoal(goal);
      return { goal, reason: 'paused', totalTicks: tick };
    }

    // L5: 監査 (5TODO毎 or 連続失敗>=2)
    if (options.auditAgent) {
      const completedSince = goal.metrics.completedCount % (options.auditEvery || 5);
      const check = shouldAuditGoal(goal, completedSince === 0 ? (options.auditEvery || 5) : completedSince, { auditEvery: options.auditEvery || 5 });
      if (check.run) {
        const trigger: 'periodic' | 'consecutive-failures' = check.reason.startsWith('consecutive') ? 'consecutive-failures' : 'periodic';
        emit(`[Goal Loop] L5監査を起動 (${check.reason})`);
        try {
          const audit = await auditGoal(goal, { cwd: options.cwd, agent: options.auditAgent, trigger });
          emit(`[Goal Loop] L5監査 verdict=${audit.verdict} reason=${audit.reason}`);
          emit(`  report: ${audit.reportPath}`);
          if (audit.verdict === 'block') {
            goal.status = 'paused';
            goal.metrics.consecutiveFailures = 0;
            await saveGoal(goal);
            emit(`[Goal Loop] L5監査で block → status=paused で停止`);
            return { goal, reason: 'paused', totalTicks: tick };
          }
        } catch (error) {
          emit(`[Goal Loop] L5監査失敗 (継続): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    // 人間中断チェック (listener非同期発火を待たず同期確認)
    if (options.signal?.aborted) {
      if (inFlightAbort) await inFlightAbort;
      else if (!interruptedOnce) await onAbort();
      return { goal, reason: 'paused', totalTicks: tick };
    }
  }
}
