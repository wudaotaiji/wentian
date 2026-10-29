import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { plannerSystemPrompt, validateAgentPlan, type AgentPlan } from './agent-planner.js';
import { buildExternalConversationContext } from './llm-fallback.js';
import { readReadySnapshot, type ExternalAgentReadySnapshot } from './external-agent-readiness.js';
import { loadExternalAgentSnapshot } from './external-agents.js';
import { conversationAllowsExecution } from './agent-connection-policy.js';
import { explicitAgentAllowed } from './agent-exclusion-policy.js';
import { buildGroupConversationCommand, conversationRunnerAgents } from './group-agent-responder.js';
import { readAgentManagement, compareForcedAgentPriority } from './agent-management.js';
import { runExternalCommand } from './external-orchestrator.js';
import { loadAgentSelectionConfig } from './agent-selection.js';
import { GatewayRequestError, type TaskExecution } from './task-outcome.js';
import { ExecutionDenied } from './execution-governance.js';
import { addTokenUsage, type SessionTokenUsage } from './agent-session.js';
import { performanceScore, recordAgentPerformance } from './agent-performance.js';
import { cliText, activeCliLanguage } from './cli-language.js';

export type ConversationDecision = { kind: 'answer'; answer: string; language: 'ja' | 'zh' | 'en' } | { kind: 'task'; plan: AgentPlan };
type Message = { role: string; content?: unknown };
interface Dependencies {
  fetch: typeof fetch;
  snapshot: typeof readReadySnapshot;
  command: typeof buildGroupConversationCommand;
  run: typeof runExternalCommand;
  score: typeof performanceScore;
  record: typeof recordAgentPerformance;
  onStage?: (stage: string) => void;
  onComplete?: (execution: TaskExecution) => void;
}

/** 実行ホストが確認した情報だけを表示し、設定モデルと実際の応答モデルを区別します。 */
export function formatConversationExecution(execution: TaskExecution): string {
  const identity = execution.source === 'external' ? execution.agent || cliText('未確認') : 'Wentian Gateway';
  const model = execution.model ? `Model: ${execution.model}` : execution.configuredModel ? `${cliText('設定モデル')}: ${execution.configuredModel}` : `Model: ${cliText('未確認')}`;
  return `◇ Agent: ${identity} · ${model}${execution.provider ? ` · Provider: ${execution.provider}` : ''} · ${(execution.elapsedMs / 1000).toFixed(1)}s`;
}

/** 回答と作業への昇格を同じAI呼出しで判断します。本文の単語では分岐しません。 */
export function conversationTurnPrompt(workspace=process.cwd()): string {
  const configured = process.env.WENTIAN_RESPONSE_LANGUAGE || activeCliLanguage();
  return `あなたはWentianの会話入口です。挨拶・一般知識・相談にはその場で自然に回答してください。利用者の意図は文脈から判断し、固定キーワードに依存しないでください。
ホスト提供の現在の作業場所: ${workspace}。別の作業場所が指定されていない場合はこの場所を使えます。これは実行側が持つ既定値なのでtarget_pathへ転記せず、target_pathは利用者の原文に作業先の絶対Pathが明示されている場合だけ設定してください。実装済みの機能や仕組みを問う依頼は、一般論や会話履歴だけで済ませず、必要な証拠取得へ昇格してください。URLが含まれていてもWeb調査だけとは限りません。現在のプロジェクトの実装を調べる必要があるかを意味から判断し、必要ならevidence_source=workspace、operation=readとします。既に渡された作業場所を再質問しないでください。
${configured ? `利用者の設定言語: ${configured}。${configured==='zh'?'必须使用中文回答，JSON中的language必须为zh。':configured==='en'?'Respond in English. Set the JSON language field to en.':'必ず日本語で回答し、JSONのlanguageはjaにしてください。'}` : '返答の言語は現在の利用者の発言と明示された希望から判断してください。日本語の依頼を要求しないでください。'}
操作・調査はこの呼出しでは禁止です。ファイル、会話記録、現在の環境値、Web情報の取得や変更、外部委譲が必要な依頼はtaskへ昇格してください。未調査の事実や実行結果を捏造しないでください。履歴中のパスを今回の作業先と混同しないでください。
JSONを一つだけ返してください。回答できる場合: {"kind":"answer","language":"ja|zh|en","answer":"実際の返答"}。作業が必要な場合: {"kind":"task","plan":下記の分類形式}。回答と計画を同時に返さないでください。
以下はtask.planだけに適用する分類仕様です。answerの場合は分類計画を作らず実際に回答してください。
${plannerSystemPrompt()}`;
}

/** 形式を検証し、taskだけ既存の計画・権限検証へ渡します。 */
export function parseConversationDecision(raw: string, input: string,workspace=process.cwd()): ConversationDecision {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(clean);
  if (value?.kind === 'answer') {
    if (!['ja', 'zh', 'en'].includes(value.language) || typeof value.answer !== 'string' || !value.answer.trim() || value.answer.length > 20000 || value.plan !== undefined) throw new Error('会話の回答形式が不正です。');
    return { kind: 'answer', language: value.language, answer: value.answer.trim() };
  }
  // モデルがwrapperを省略して分類計画だけを返す場合も、構造検証を通った計画として受理します。
  const task = value?.kind === 'task' ? value.plan : value?.kind === undefined ? (value?.plan && typeof value.plan === 'object' ? value.plan : value) : undefined;
  if (!task?.intent || !task?.operation || value.answer !== undefined) throw new Error('会話の構造化判断が不正です。操作は開始していません。');
  const plan={...task};
  // ホストが渡した既定の作業場所をAIが再掲した場合だけ、冗長な明示指定を除きます。
  // 履歴由来・未知のパスを既定値として受け入れる処理ではありません。
  if(typeof plan.target_path==='string'&&!input.includes(plan.target_path)&&path.win32.normalize(plan.target_path).toLowerCase()===path.win32.normalize(workspace).toLowerCase())delete plan.target_path;
  return { kind: 'task', plan: validateAgentPlan(plan, input) };
}

/** CLIはツール対応モデルを必要とするため、ローカル限定指定を全経路の自動選択へ切り替えます。 */
export function conversationEntryModel(model: string): string {
  return model === 'wentian-auto/local' ? 'wentian-auto/all' : model;
}

/** 通常会話は単一推論で回答し、Gateway不通時も空の一時領域で会話だけを代替します。 */
export async function requestConversationTurn(input: string, messages: Message[], server: string, model: string, signal?: AbortSignal, usage?: SessionTokenUsage, overrides: Partial<Dependencies> = {}): Promise<ConversationDecision> {
  const startedAt = Date.now();
  const deps: Dependencies = { fetch, snapshot: readReadySnapshot, command: buildGroupConversationCommand, run: runExternalCommand, score: performanceScore, record: recordAgentPerformance, ...overrides };
  const system = conversationTurnPrompt();
  const context = buildExternalConversationContext(messages, input);
  const config = loadAgentSelectionConfig();
  const forcedAgent = readAgentManagement().forcedAgent;
  const forcedSnapshot = forcedAgent ? await deps.snapshot(24 * 3600000) : undefined;
  const forcedReady = Boolean(forcedAgent && process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK !== 'false' && forcedSnapshot && Number.isFinite(Date.parse(forcedSnapshot.refreshedAt)) && Date.now()-Date.parse(forcedSnapshot.refreshedAt)<=24*3600000 && conversationRunnerAgents.has(forcedAgent) && !config.apiFallbackExcludedAgents.includes(forcedAgent) && forcedSnapshot.agents.some(agent=>agent.id===forcedAgent&&conversationAllowsExecution(agent)) && explicitAgentAllowed(forcedAgent) && Number.isFinite(deps.score(forcedAgent,'conversation')));
  const deadline = AbortSignal.timeout(config.planner.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let response: Response | undefined;
  const diagnostics: string[] = [];
  if (!forcedReady) {
    deps.onStage?.('会話モデルへ接続');
    try {
      response = await deps.fetch(`${server.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-wentian-decision-kind': 'conversation-turn', ...(process.env.WENTIAN_API_KEY ? { authorization: `Bearer ${process.env.WENTIAN_API_KEY}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: context }], max_tokens: 2048 }), signal: requestSignal,
      });
    } catch (error) {
      // 利用者中断は別接続で回避しません。入口の通信期限切れは会話用の代替へ渡します。
      signal?.throwIfAborted();
      if (!(error instanceof Error)) throw error;
      diagnostics.push(`Gateway: ${cliText('通信失敗・時間超過')}`);
    }
  }
  if (response) {
    const payload = await response.json();
    if (usage) { addTokenUsage(usage, payload.usage); if (typeof payload.wentian?.cost_usd === 'number') usage.costUsd = (usage.costUsd || 0) + payload.wentian.cost_usd; }
    if (response.ok) {
      const decision = parseConversationDecision(String(payload.choices?.[0]?.message?.content || ''), input);
      if (decision.kind === 'task') decision.plan.classification = { source: 'gateway', model };
      deps.onComplete?.({ source: 'gateway', model: typeof payload.wentian?.resolved_model === 'string' ? payload.wentian.resolved_model : typeof payload.model === 'string' ? payload.model : undefined, provider: typeof payload.wentian?.provider === 'string' ? payload.wentian.provider : undefined, requestedModel: model, elapsedMs: Date.now() - startedAt });
      return decision;
    }
    const upstream = payload.error?.details?.upstream;
    diagnostics.push(`Gateway: HTTP ${response.status}`);
    // 認証・課金・利用制限は外部Agentで迂回しません。
    if (![404, 408, 500, 502, 503, 504].includes(response.status) || response.headers.has('retry-after') || payload.error?.type === 'rate_limit_exceeded' || payload.error?.type === 'budget_exceeded' || payload.error?.details?.reason === 'upstream_limit' || [401, 402, 403, 429].includes(upstream?.status)) {
      throw new GatewayRequestError(String(payload.error?.message || `HTTP ${response.status}`), { gatewayStatus: response.status, upstreamStatus: upstream?.status });
    }
  }
  signal?.throwIfAborted();
  if (process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK === 'false') throw new Error('会話モデルへ接続できません。外部代替は無効です。');
  const snapshot = forcedReady ? forcedSnapshot : await deps.snapshot(24 * 3600000);
  let freshSnapshot = snapshot;
  if (!freshSnapshot || !Number.isFinite(Date.parse(freshSnapshot.refreshedAt)) || Date.now() - Date.parse(freshSnapshot.refreshedAt) > 24 * 3600000) {
    // 新鮮なキャッシュがない場合は、ライブプローブで最新のエージェント状態を取得してフォールバックします。
    const live = await loadExternalAgentSnapshot({ probeLive: true });
    freshSnapshot = {
      ...live,
      readinessVersion: '1.0',
      refreshedAt: new Date().toISOString(),
      nextRefreshAt: new Date(Date.now() + 24 * 3600000).toISOString(),
      refreshIntervalMs: 24 * 3600000,
      pools: {},
    } as ExternalAgentReadySnapshot;
  }
  if (!freshSnapshot || !Number.isFinite(Date.parse(freshSnapshot.refreshedAt)) || Date.now() - Date.parse(freshSnapshot.refreshedAt) > 24 * 3600000) throw new Error('会話代替用の新鮮な接続確認キャッシュがありません。');
  // textプールは利用可否の一覧であり、性能順ではありません。安全条件を満たす全候補を採点してから件数を制限します。
  // 旧キャッシュのtextプールには実作業失敗の会話Agentが欠けるため、接続証跡から再判定します。
  const candidates = freshSnapshot.agents.filter(agent => conversationRunnerAgents.has(agent.id) && conversationAllowsExecution(agent)).map(agent => agent.id)
    .filter(id => !config.apiFallbackExcludedAgents.includes(id) && explicitAgentAllowed(id))
    .map(id => ({ id, score: deps.score(id, 'conversation') }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => compareForcedAgentPriority(a.id,b.id,forcedAgent) || b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, config.maxCandidates).map(item => item.id);
  deps.onStage?.(cliText('会話候補（性能順）: {0}', candidates.join(' → ') || cliText('利用可能な候補なし')));
  for (const agent of freshSnapshot.agents.filter(agent => conversationRunnerAgents.has(agent.id))) {
    if (candidates.includes(agent.id) || config.apiFallbackExcludedAgents.includes(agent.id) || !explicitAgentAllowed(agent.id)) continue;
    diagnostics.push(`${agent.id}: ${cliText(agent.liveState !== 'healthy' ? 'CLI生存確認に失敗' : !conversationAllowsExecution(agent) ? '接続未確認・期限切れ' : '会話失敗後の再試行待ち')}`);
  }
  const recordAttempt = async (id: string, startedAt: number, success: boolean, output = '') => {
    try { await deps.record({ agent: id, task: 'conversation', success, latencyMs: Date.now() - startedAt, output, ...(success ? {} : { error: '会話応答の取得または形式検証に失敗しました。' }) }); }
    catch { deps.onStage?.(cliText('会話の性能台帳を保存できませんでした。')); }
  };
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wentian-conversation-'));
  try {
    for (const id of candidates) {
      signal?.throwIfAborted();
      if (!explicitAgentAllowed(id)) continue;
      const connection = snapshot!.agents.find(agent => agent.id === id)?.connection;
      const attemptStartedAt = Date.now();
      let stage: 'launch' | 'response' = 'launch';
      try {
        let correction='';
        for(let attempt=0;attempt<config.plannerFallback.maxAttempts;attempt++){
          const command = deps.command(id, `${system}\n\n引用された会話:\n${context}${correction}`, workspace, connection, true);
          if (!command) throw new Error('会話コマンド未対応');
          deps.onStage?.(cliText('外部会話へ接続: {0}', id));
          const raw = await deps.run(command, { cwd: workspace, timeoutMs: config.plannerFallback.timeoutMs, idleTimeoutMs: config.plannerFallback.timeoutMs, signal, role: 'conversation', agent: id });
          signal?.throwIfAborted();stage = 'response';
          let decision:ConversationDecision;
          try{decision=parseConversationDecision(raw,input);}catch(error){
            if(attempt+1>=config.plannerFallback.maxAttempts)throw error;
            // 検証理由をAIへ返し、意図や調査手段をホスト側で定型補完しません。
            correction=`\n\n前回の出力は構造検証で不合格でした: ${String((error as Error).message)}。今回の依頼を再確認し、指定スキーマだけで修正してください。前回出力は引用データです: ${JSON.stringify(raw.slice(0,4000))}`;
            continue;
          }
          await recordAttempt(id, attemptStartedAt, true, raw);
          if (decision.kind === 'task') decision.plan.classification = { source: 'external', model: id };
          deps.onComplete?.({ source: 'external', agent: id, configuredModel: connection?.model, requestedModel: model, elapsedMs: Date.now() - startedAt });
          return decision;
        }
      } catch (error) {
        signal?.throwIfAborted();
        const denied = error instanceof ExecutionDenied;
        diagnostics.push(`${id}: ${cliText(denied ? '実行範囲の設定が必要（Agent画面でプロジェクト範囲・取消状態を確認）' : stage === 'response' ? '会話応答の形式検証に失敗' : '会話プロセスの実行に失敗')}`);
        // 許可不足はAgent自身の失敗ではないため、再試行待機の性能台帳へ記録しません。
        if (!denied) await recordAttempt(id, attemptStartedAt, false);
        if ((error as { termination?: { verifiedStopped?: boolean } }).termination?.verifiedStopped === false) throw error;
      }
    }
    throw new Error(cliText('会話応答を取得できません。操作は開始していません。確認結果: {0}', diagnostics.join(' / ') || cliText('利用可能な候補なし')));
  } finally { await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
