import { AgentGroupStore, GroupBusyError, type AgentGroup, type GroupAutonomyPauseReason, type GroupDiscussionStopReason, type GroupResponder } from './agent-group.js';

/**
 * 自律討論（Autonomous Discussion）は Gateway 常駐で動きます。
 * 画面を閉じても、有効化されたグループのAI参加者だけで議論を続けます。
 * 停止条件は合意成立・周回上限・時間上限・人間の発言・停止操作です。
 */
export interface GroupAutonomyManagerInput {
  workspace: string;
  respond: GroupResponder;
  studyRoot?: (groupId?: string) => Promise<string | undefined>;
  intervalMs?: number;
  onError?: (error: unknown, groupId?: string) => void;
  store?: AgentGroupStore;
}

export interface GroupAutonomyManager {
  start(): void;
  stop(): Promise<void>;
  /** 人間の投稿時に自動実行を止め、実行中なら終了まで待ちます。 */
  humanActivity(id: string): Promise<void>;
  resumeAfterHuman(id: string): Promise<void>;
  /** 停止操作として自動実行を止めます。実行中なら終了まで待ちます。 */
  stopGroup(id: string): Promise<void>;
  /** 一度だけ実行します（検証用・手動起動用）。 */
  runOnce(id: string): Promise<void>;
}

/** 最初の議題がないグループには、題名から論点を提起させます。 */
function agendaFor(group: AgentGroup): string {
  if (group.autonomy?.mode === 'continuous' && group.messages.length) return '前回の議論・合意と残る検証事項を踏まえ、次に価値のある新しい論点を自分たちで選んでください。同じ結論や挨拶を繰り返さず、他の参加者の案を具体化し、未実施の作業を実施済みと扱わないでください。';
  return group.messages.length
    ? 'これまでの会話と未解決点を踏まえ、次に取り組むべき具体的な論点を検討し、他の参加者の案へ応答してください。'
    : `グループ「${group.title}」の目的に沿って、最初に検討すべき論点を提起してください。`;
}

/** 停止理由を、次回の自動実行を止める理由へ対応付けます。 */
function pauseReason(stop: GroupDiscussionStopReason | undefined): GroupAutonomyPauseReason {
  if (stop === 'deliverable' || stop === 'needs_human' || stop === 'stagnation') return stop;
  if (stop === 'consensus' || stop === 'round_limit' || stop === 'time_limit' || stop === 'human' || stop === 'disabled') return stop;
  return 'error';
}

export function startGroupAutonomy(input: GroupAutonomyManagerInput): GroupAutonomyManager {
  const store = input.store || new AgentGroupStore(input.workspace);
  const intervalMs = input.intervalMs ?? 15000;
  const onError = input.onError || (() => undefined);
  const runs = new Map<string, Promise<void>>();
  // グループごとの停止要求（人間の発言・停止操作）を保持し、各発言の前に確認します。
  const stopRequests = new Map<string, GroupDiscussionStopReason>();
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;

  async function run(id: string): Promise<void> {
    const existing = runs.get(id);
    if (existing) return existing;
    const promise = (async () => {
      let stopReason: GroupDiscussionStopReason | undefined;
      try {
        let before = await store.load(id);
        if (!before.autonomy?.enabled || before.autonomy.paused || (before.autonomy.nextRunAt && Date.parse(before.autonomy.nextRunAt) > Date.now()) || before.federation || before.discussion?.status === 'running') return;
        await store.recoverStaleAutonomyRun(id, (before.autonomy.maxMinutes + 5) * 60000);
        before = await store.load(id);
        if (!before.autonomy?.enabled || before.autonomy.paused || before.humanReply?.status === 'running') return;
        // 会話専用の応答だけを使い、Actionモードでも勝手にファイル操作しません。
        const group = before.autonomy?.workflow !== 'free' ? await store.outcome(id, before.messages.filter(m => m.kind === 'human').at(-1)?.content.slice(0,4000) || before.title, input.respond, { maxRounds: before.autonomy.maxRounds, maxMinutes: before.autonomy.maxMinutes, root: () => input.studyRoot?.(id) || Promise.resolve(undefined), shouldStop: () => stopRequests.get(id) }) : await store.discuss(id, agendaFor(before), 1, input.respond, undefined, {
          untilConsensus: true, maxRounds: before.autonomy.maxRounds, maxMinutes: before.autonomy.maxMinutes,
          injectPrompt: false, shouldStop: () => stopRequests.get(id),
        });
        stopReason = group.discussion?.stopReason;
      } catch (error) {
        // 正常な人間への返答・手動討論が先にロックした場合は、次回巡回で再確認します。
        if (error instanceof GroupBusyError) return;
        // 失敗理由を記録し、管理者が再開するまで自動実行を停止します。
        await store.pauseAutonomy(id, 'error', error instanceof Error ? error.message : String(error)).catch(() => undefined);
        onError(error, id);
        return;
      } finally {
        stopRequests.delete(id);
      }
      await store.completeAutonomyCycle(id, pauseReason(stopReason)).catch(error => onError(error, id));
    })().finally(() => { runs.delete(id); });
    runs.set(id, promise);
    return promise;
  }

  async function tick(): Promise<void> {
    let groups: AgentGroup[];
    try { groups = await store.list(); } catch (error) { onError(error); return; }
    for (const group of groups) {
      if (group.federation || !group.autonomy?.enabled || group.autonomy.paused) continue;
      if (runs.has(group.id)) continue;
      // 前回プロセスが落ちて残った実行中状態は、十分に古ければ中断として記録し直します。
      if (group.discussion?.status === 'running' || group.humanReply?.status === 'running') {
        await store.recoverStaleAutonomyRun(group.id, (group.autonomy.maxMinutes + 5) * 60000).catch(error => onError(error, group.id));
        continue;
      }
      if (!group.members.some(member => member.kind !== 'human')) continue;
      void run(group.id).catch(error => onError(error, group.id));
    }
  }

  function start(): void {
    if (timer) return;
    const poll = () => { if (!pending) pending = tick().catch(onError).finally(() => { pending = undefined; }); };
    timer = setInterval(poll, intervalMs);
    timer.unref?.();
    // 初回巡回も追跡し、起動直後の停止が未完了の巡回を追い越さないようにします。
    poll();
  }

  async function waitForStop(id: string, reason: GroupDiscussionStopReason): Promise<void> {
    const active = runs.get(id);
    if (!active) {
      await store.pauseAutonomy(id, reason).catch(() => undefined);
      return;
    }
    stopRequests.set(id, reason);
    try { await active; } catch { /* run() 側で記録済み */ }
  }

  return {
    start,
    async stop() {
      if (timer) { clearInterval(timer); timer = undefined; }
      await pending;
      // 進行中の自律討論は人間の発言と同じ扱いで止め、保存を待ってから終了します。
      const activeIds = [...runs.keys()];
      await Promise.all(activeIds.map(id => waitForStop(id, 'disabled')));
      // 継続モードはサーバー再起動後も有効です。利用者による無効化は解除しません。
      await Promise.all(activeIds.map(id => store.resumeAfterShutdown(id)));
    },
    humanActivity: id => waitForStop(id, 'human'),
    resumeAfterHuman: id => store.resumeAfterHuman(id),
    stopGroup: id => waitForStop(id, 'disabled'),
    runOnce: run,
  };
}
