import { buildReadySnapshot, readReadySnapshot, saveReadySnapshot, type ExternalAgentReadinessManager, type ExternalAgentReadySnapshot, type AgentMaintenanceStatus } from './external-agent-readiness.js';
import { loadExternalAgentSnapshot, type ExternalAgentStatus } from './external-agents.js';
import { maintainAgentConnections, connectionStatusUpdate } from './agent-connection-maintenance.js';
import { maintainAgentsWithAI } from './agent-ai-maintenance.js';
import { connectionPolicy, managedAgentIds, readAgentConnections } from './agent-connection-policy.js';
import { readWorkEvidence } from './agent-work-policy.js';
import { agentNotExcluded } from './agent-exclusion-policy.js';
import { markAgentRecovered } from './agent-performance.js';
import { redactTrainingText } from './training-data.js';
import { readMaintenanceSettings, saveMaintenanceSettings, validateMaintenanceSettings, type AgentMaintenanceSettings } from './agent-maintenance-settings.js';
import { withMaintenanceResources, measureMaintenanceResources, maintenanceResourceState, MaintenanceResourcePause, resourceRetryDelay,latestResourceMeasurement } from './maintenance-resources.js';

/** 自動保守・手動確認・停止を同じ直列キューで管理します。停止は設定保存後に子処理へ伝播します。 */
export function createAgentMaintenanceManager(options: { intervalMs?: number; onError?: (error: unknown) => void; maintainConnections?: boolean } = {}, dependencies: {
  loadSnapshot?: typeof loadExternalAgentSnapshot; maintain?: typeof maintainAgentConnections;
  saveSnapshot?: typeof saveReadySnapshot;
  resources?: typeof measureMaintenanceResources;
} = {}): ExternalAgentReadinessManager {
  let settings: AgentMaintenanceSettings;
  let configError: string | undefined;
  try { settings = readMaintenanceSettings(); }
  catch (error) { configError = (error as Error).message; settings = { enabled: false, intervalMs: 300_000, retryIntervalMs: 30_000, autoInstall: false, verifyWork: true }; }
  if (options.intervalMs) settings.intervalMs = Math.max(10_000, options.intervalMs);
  const disabled = () => options.maintainConnections === false || !connectionPolicy().enabled;
  let latest: ExternalAgentReadySnapshot | undefined;
  let closed = false;
  let initialized = false;
  let resourcePaused = false;
  let resourceFailures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  let reading: Promise<ExternalAgentReadySnapshot> | undefined;
  let allPending = false;
  const pending = new Set<string>();
  let runtime: Partial<AgentMaintenanceStatus> = {};
  let writing: Promise<unknown> = Promise.resolve();
  let configuring: Promise<unknown> = Promise.resolve();
  const load = dependencies.loadSnapshot || loadExternalAgentSnapshot;
  const save = () => {
    // 行操作と進捗通知の保存を直列化し、古い非同期保存で最新状態を上書きしません。
    writing = writing.catch(() => {}).then(() => latest && (dependencies.saveSnapshot || saveReadySnapshot)(latest));
    return writing.then(() => {});
  };
  const status = (): AgentMaintenanceStatus => ({ settings: { ...settings }, state: disabled() ? 'disabled' : configError ? 'error' : running ? controller?.signal.aborted ? 'stopping' : 'running' : settings.enabled ? initialized ? runtime.lastError ? 'error' : 'waiting' : 'starting' : 'stopped',
    reason: disabled() ? '実行許可設定または起動オプションで接続保守が無効です。' : configError || (!settings.enabled ? '自動保守は停止しています。手動確認は個別に実行できます。' : undefined),
    ...runtime, resourcePaused, constraints: { connectionDisabled: disabled(), autoInstallDisabled: process.env.WENTIAN_AGENT_AUTO_INSTALL === 'false' }, pendingAgents: allPending ? ['all'] : [...pending],
    targets: (latest?.agents || []).filter(agent => managedAgentIds.includes(agent.id) && agentNotExcluded(agent)).map(agent => agent.id),
    excludedAgents: (latest?.agents || []).filter(agent => !agentNotExcluded(agent)).map(agent => agent.id) });
  const refresh = (): Promise<ExternalAgentReadySnapshot> => reading ||= load({ probeLive: false }).then(async snapshot => {
    const saved = readAgentConnections(), evidence = readWorkEvidence();
    snapshot.agents = snapshot.agents.map(agent => saved[agent.id] ? connectionStatusUpdate(agent, saved[agent.id], evidence[agent.id]) : agent);
    latest = buildReadySnapshot(snapshot, settings.intervalMs);
    await save();
    return latest;
  }).finally(() => { reading = undefined; });
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; delete runtime.nextRunAt; };
  const reportError = (error: unknown) => {
    // CLI引数や接続先を管理APIへ漏らさず、詳細は既存の保守証跡で確認します。
    runtime.lastError = '保守サイクルが完了しませんでした。保守証跡と実行ログを確認してください。';
    options.onError?.(new Error(redactTrainingText(String((error as Error)?.stack || error)).slice(-12000)));
  };
  const schedule = () => {
    clearTimer();
    if (closed || disabled() || configError || (!settings.enabled && !(resourcePaused && (allPending || pending.size))) || running) return;
    const failed = latest?.agents.some(agent => managedAgentIds.includes(agent.id) && agentNotExcluded(agent) && agent.state !== 'available');
    const delay = resourcePaused ? resourceRetryDelay(resourceFailures, settings.retryIntervalMs) : runtime.lastError || failed ? settings.retryIntervalMs : settings.intervalMs;
    runtime.resourceRetryCount = resourceFailures;
    runtime.nextRunAt = new Date(Date.now() + delay).toISOString();
    timer = setTimeout(() => { timer = undefined; delete runtime.nextRunAt; if (settings.enabled) allPending = true; kick(); }, delay);
    timer.unref?.();
  };
  const kick = () => {
    if (!initialized || closed || disabled() || configError || running || (!allPending && !pending.size)) return;
    if (resourcePaused && timer) return;
    clearTimer();
    const targets = allPending ? undefined : new Set(pending);
    allPending = false; pending.clear();
    const cycle = controller = new AbortController();
    runtime = { startedAt: new Date().toISOString(), resources: runtime.resources };
    running = Promise.resolve().then(() => withMaintenanceResources(async guardedSignal => {
      // 資源監視の停止も、通常の停止操作と同じAbortSignalで子処理へ伝えます。
      const abort = () => cycle.abort(guardedSignal.reason);
      guardedSignal.addEventListener('abort', abort, { once: true });
      try {
      runtime.stage = 'CLI確認';
      const snapshot = await load({ probeLive: true, signal: cycle.signal });
      cycle.signal.throwIfAborted();
      const connections = readAgentConnections(), evidence = readWorkEvidence();
      snapshot.agents = snapshot.agents.map(agent => connections[agent.id] ? connectionStatusUpdate(agent, connections[agent.id], evidence[agent.id]) : agent);
      latest = buildReadySnapshot(snapshot, settings.intervalMs);
      await save();
      // 保存待ちの間に停止された場合、すでに中断済みのSignalで子処理を起動しません。
      cycle.signal.throwIfAborted();
      const candidates = snapshot.agents.filter(agent => managedAgentIds.includes(agent.id) && agentNotExcluded(agent) && (!targets || targets.has(agent.id)));
      runtime.stage = 'AI保守の判断';
      const maintained = await (dependencies.maintain || maintainAgentsWithAI)(candidates, async agent => {
        cycle.signal.throwIfAborted();
        runtime.currentAgent = agent.id;
        runtime.stage = agent.stateLabel;
        if (latest) latest = buildReadySnapshot({ ...latest, agents: latest.agents.map(item => item.id === agent.id ? agent : item) }, settings.intervalMs);
        await save();
        if (agent.connection?.status === 'verified') await markAgentRecovered(agent.id);
      }, cycle.signal, { autoInstall: settings.autoInstall, verifyWork: settings.verifyWork, resources: dependencies.resources, onActivity: ids => { runtime.activeAgents = ids; } });
      cycle.signal.throwIfAborted();
      if (latest) latest = buildReadySnapshot({ ...latest, agents: latest.agents.map(agent => maintained.find(item => item.id === agent.id) || agent) }, settings.intervalMs);
      await save();
      resourceFailures = 0;
      } finally { guardedSignal.removeEventListener('abort', abort); }
    }, cycle.signal, dependencies.resources, (state, value) => {
      const previous = runtime.resources?.state;
      // 再開も共通の90%未満判定に従い、警告域だけでは停止を継続しません。
      runtime.resources = { state, usage: value,...(dependencies.resources?{checkedAt:new Date().toISOString()}:latestResourceMeasurement()) };
      if (state !== 'normal' && previous !== state) console.warn(state === 'warning' ? '資源使用率が80%以上です。保守の負荷に注意してください。' : '資源高負荷または計測不能のため保守を一時停止します。');
      resourcePaused = false;
    })).catch(error => {
      if (error instanceof MaintenanceResourcePause) {
        resourcePaused = true; resourceFailures++; runtime.lastError = error.message;
        // 手動一回確認も失ったままにせず、負荷回復後へ延期します。
        if (targets) for (const id of targets) pending.add(id); else allPending = true;
      }
      else if (!cycle.signal.aborted) reportError(error);
    }).finally(() => {
      runtime.finishedAt = new Date().toISOString();
      delete runtime.currentAgent; delete runtime.stage; delete runtime.activeAgents;
      running = undefined; controller = undefined;
      if (closed) return;
      if (!resourcePaused && (allPending || pending.size)) kick(); else schedule();
    });
  };
  const request = (id?: string) => {
    if (closed || disabled() || configError) throw new Error('接続保守が無効、または設定に問題があります。');
    if (id) {
      if (!managedAgentIds.includes(id)) throw new Error('接続保守に対応していないAgentです。');
      pending.add(id);
    } else allPending = true;
    // 再確認の連打で資源停止の待機時間を迂回しません。
    if (resourcePaused && timer) return;
    kick();
  };
  const ready = readReadySnapshot().then(cached => { if (!latest && cached) latest = cached; }).catch(reportError).finally(() => {
    initialized = true;
    if (closed) return;
    if (!disabled() && !configError && settings.enabled) allPending = true;
    kick();
    if (!running) schedule();
  });
  let resourceReading:Promise<AgentMaintenanceStatus>|undefined;
  return { current: () => latest, refresh, maintenanceStatus: status,
    // 表示の再計測だけを行い、保守の停止・再試行間隔・実行許可は変更しません。
    refreshResourceStatus:()=>resourceReading ||= (async()=>{
      const value=await (dependencies.resources||measureMaintenanceResources)().catch(()=>undefined);
      if(!closed)runtime.resources={state:maintenanceResourceState(value),usage:value,...(dependencies.resources?{checkedAt:new Date().toISOString()}:latestResourceMeasurement())};
      return status();
    })().finally(()=>{resourceReading=undefined;}),
    updateAgent: async agent => {
      if (!latest) await refresh();
      latest = buildReadySnapshot({ ...latest!, agents: latest!.agents.some(item => item.id === agent.id) ? latest!.agents.map(item => item.id === agent.id ? agent : item) : [...latest!.agents, agent] }, settings.intervalMs);
      await save();
    },
    requestMaintenance: request,
    reloadMaintenanceControls: async () => {
      if (closed) return;
      if (disabled()) { clearTimer(); allPending=false;pending.clear();controller?.abort();await running; }
      else if (settings.enabled) { allPending=true;kick();if(!running)schedule(); }
    },
    // 旧API呼出しは手動確認へ統合し、自動保守の対象を狭めません。
    enableConnectionMaintenance: request,
    cancelAgentMaintenance: id => { pending.delete(id); if (runtime.currentAgent === id || runtime.activeAgents?.includes(id)) controller?.abort(); },
    configureMaintenance: patch => {
      const result = configuring.catch(() => {}).then(async () => {
        const changes = validateMaintenanceSettings(patch);
        if (changes.enabled === true && disabled()) throw new Error('実行許可設定または起動オプションで接続保守が無効です。');
        if (changes.autoInstall === true && process.env.WENTIAN_AGENT_AUTO_INSTALL === 'false') throw new Error('環境設定でCLI自動導入が無効です。');
        const next = { ...settings, ...changes };
        await saveMaintenanceSettings(next);
        settings = next; configError = undefined;
        if (!settings.enabled || !resourcePaused) clearTimer();
        if (!settings.enabled) { allPending = false; pending.clear(); controller?.abort(); }
        else { allPending = true; kick(); }
        return status();
      });
      configuring = result;
      return result;
    },
    stop: async () => { closed = true; clearTimer(); allPending = false; pending.clear(); controller?.abort(); await ready; await running; await reading; await writing; await resourceReading; },
  };
}
