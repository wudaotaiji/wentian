import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { AGENT_CATALOG, probeAgentCli } from './agent-marketplace.js';
import { loadManualAgents } from './manual-agent-registry.js';
import type { AgentConnection } from './agent-connection-policy.js';
import type { AgentWorkEvidence } from './agent-work-policy.js';
import { agentRegistered } from './agent-exclusion-policy.js';
import type {AgentInstallation} from './agent-install-maintenance.js';

export type ExternalAgentState = 'available' | 'candidate' | 'needs_recheck' | 'unavailable';

export interface ExternalAgentStatus {
  /** 使用可否はCLI生存状態と別に管理します。 */
  excluded?: boolean;
  executionAccess?:{maintenance:boolean;revoked:boolean;policyError?:boolean};
  priority?: number;
  forceUse?: boolean;
  manualModel?: boolean;
  healthCheckCommand?: string;
  healthCheckLabel?: string;
  id: string;
  name: string;
  state: ExternalAgentState;
  stateLabel: string;
  note: string;
  lastObservedAt?: string;
  /** 会話候補の選択と同じ性能評価。冷却など非有限値はnullで返します。 */
  currentScore?: number | null;
  scoreCoolingDown?: boolean;
  ageHours?: number;
  freshWithin24Hours: boolean;
  evidence?: string;
  cli?: string;
  version?: string;
  liveState?: 'healthy' | 'not_installed' | 'probe_failed';
  latencyMs?: number;
  probeError?: string;
  registration?: 'built_in' | 'manual';
  /** CLIの生存とは別に、接続設定と実モデルの応答結果を保持します。 */
  connection?: AgentConnection;
  workEvidence?: AgentWorkEvidence;
  installation?: AgentInstallation;
}

export interface ExternalAgentSnapshot {
  source: string;
  cacheUpdatedAt?: string;
  cacheAgeHours?: number;
  cacheFreshWithin24Hours: boolean;
  agents: ExternalAgentStatus[];
  summary: Record<ExternalAgentState, number> & { total: number };
  warning?: string;
  availabilityBlockers?: Record<'paused'|'cli'|'permission'|'model'|'connection'|'work', number>;
}

type Run = Record<string, any>;

/** 保存先は明示指定、環境変数、ユーザーのホーム（Home）の順に解決します。 */
export function agentOrchestrationDirectory(directory?: string): string {
  return path.resolve(directory?.trim() || process.env.WENTIAN_AGENT_ORCHESTRATION_DIR?.trim()
    || path.join(process.platform === 'win32' ? process.env.USERPROFILE || homedir() : homedir(), '.agent_orchestration'));
}

/** 初回だけ空の記録を作成します。排他的作成で既存の生存確認履歴を上書きしません。 */
async function readHealthCache(directory: string): Promise<[string, Stats]> {
  const summaryPath = path.join(directory, 'summary.json');
  try {
    return [await readFile(summaryPath, 'utf8'), await stat(summaryPath)];
  } catch (error) {
    // 未作成だけを初期化し、権限不足や不正な配置は呼び出し元へ警告として返します。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(summaryPath, JSON.stringify({ runs: [] }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    } catch (creationError) {
      // 別の要求が先に作成した場合は、その記録を読み直します。
      if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError;
    }
    return [await readFile(summaryPath, 'utf8'), await stat(summaryPath)];
  }
}

const REGISTRY = [
  { id: 'ollama', name: 'Ollama（Wentianツール対応）' },
  { id: 'lmstudio', name: 'LM Studio（Wentianツール対応）' },
  { id: 'goose', name: 'goose（グース）' },
  { id: 'crush', name: 'crush（クラッシュ）' },
  { id: 'kilo', name: 'Kilo（キロ）' },
  { id: 'opencode', name: 'OpenCode（オープンコード）' },
  { id: 'hermes', name: 'Hermes（ヘルメス）' },
  { id: 'claude', name: 'Claude（クロード）' },
  { id: 'openclaw', name: 'OpenClaw（オープンクロー）' },
  { id: 'cline', name: 'Cline（クライン）' },
] as const;

const labels: Record<ExternalAgentState, string> = {
  available: '利用可能', candidate: '利用候補', needs_recheck: '要再確認', unavailable: '利用不可・要設定修正',
};

function observedAt(run: Run): string | undefined {
  return run.observed_time || run.completed_at || run.started_at || run.created_at || (run.observed_date ? `${run.observed_date}T00:00:00+09:00` : undefined);
}

function agentEntry(run: Run, id: string): Record<string, any> | undefined {
  if (String(run.agent || '').toLowerCase() === id) return run;
  return Array.isArray(run.agents) ? run.agents.find((agent: any) => String(agent?.name || '').toLowerCase() === id) : undefined;
}

function evidenceText(run: Run, entry: Record<string, any>): string {
  const result = String(entry.result || entry.health_check || run.status || '記録あり');
  return `${run.run_id || run.purpose || '記録'}: ${result}`;
}

function classify(id: string, run: Run | undefined, entry: Record<string, any> | undefined, fresh: boolean): Pick<ExternalAgentStatus, 'state' | 'note'> {
  if (!run || !entry) return { state: 'needs_recheck', note: '生存確認記録が見つかりません。' };
  const result = `${entry.result || ''} ${entry.health_check || ''} ${entry.reason || ''}`.toLowerCase();
  if (id === 'cline' && /(unavailable|failed|context|tool_call_not_applied)/.test(result)) return { state: 'unavailable', note: 'Context Limit（コンテキスト上限 / Context Limit）超過またはTool Call未適用です。設定・モデル・CLI実行方式の修正後に再確認が必要です。' };
  if (id === 'kilo') return { state: 'candidate', note: '利用時はモデル kilo/kilo-auto/free の明示が必要です。' };
  if (/(unavailable|failed|stopped|no_progress|not_retried)/.test(result)) return { state: 'needs_recheck', note: entry.reason || '直近の実作業が成功していないため再確認が必要です。' };
  if (!fresh) return { state: 'needs_recheck', note: '最新の正常確認から24時間以上経過しています。' };
  if (id === 'goose') return { state: 'available', note: '直近の設計レビュー成功記録があります。' };
  if (id === 'crush') return { state: 'available', note: '直近の読み取り専用レビュー成功記録があります。' };
  return { state: 'available', note: '直近24時間以内に正常確認済みです。' };
}

/** 既存のHealth Check Cacheを読み、実行を伴わない外部エージェント一覧へ正規化します。 */
export async function loadExternalAgentSnapshot(options: { directory?: string; now?: Date; probeLive?: boolean; probe?: typeof probeAgentCli; signal?: AbortSignal } = {}): Promise<ExternalAgentSnapshot> {
  // 起動時に全CLIを同時起動せず、直列で確認します。停止後は次のCLIを起動しません。
  let probing: Promise<unknown> = Promise.resolve();
  const probe = (cli: string) => {
    const next = probing.then(() => { options.signal?.throwIfAborted(); return (options.probe || probeAgentCli)({ cli }, options.signal); });
    probing = next;
    return next;
  };
  const directory = agentOrchestrationDirectory(options.directory);
  const summaryPath = path.join(directory, 'summary.json');
  const now = options.now || new Date();
  try {
    const [text, fileStat] = await readHealthCache(directory);
    const payload = JSON.parse(text) as { runs?: Run[] };
    const runs = Array.isArray(payload.runs) ? payload.runs : [];
    const cacheAgeHours = Math.max(0, (now.getTime() - fileStat.mtime.getTime()) / 3_600_000);
    const manual = await loadManualAgents();
    const registry = [...REGISTRY.map(value => ({ ...value, cli: AGENT_CATALOG.find(item => item.id === value.id)?.cli || value.id, registration: 'built_in' as const })), ...manual.filter(value => !REGISTRY.some(item => item.id === value.id)).map(value => ({ ...value, registration: 'manual' as const }))];
    const agents = await Promise.all(registry.filter(agent => agentRegistered(agent.id)).map(async ({ id, name, cli, registration }) => {
      let selected: { run: Run; entry: Record<string, any>; at?: string } | undefined;
      for (const run of runs) {
        const entry = agentEntry(run, id);
        if (!entry) continue;
        const at = observedAt(run);
        if (!selected || (at && (!selected.at || Date.parse(at) > Date.parse(selected.at)))) selected = { run, entry, at };
      }
      // 日付しかない最新記録がキャッシュ更新日と同日なら、ファイル更新時刻を鮮度判定に利用します。
      let timestamp = selected?.at;
      if (timestamp && /^\d{4}-\d{2}-\d{2}T00:00:00/.test(timestamp) && timestamp.slice(0, 10) === fileStat.mtime.toISOString().slice(0, 10)) timestamp = fileStat.mtime.toISOString();
      const ageHours = timestamp ? Math.max(0, (now.getTime() - Date.parse(timestamp)) / 3_600_000) : undefined;
      const fresh = ageHours !== undefined && ageHours <= 24;
      if (options.probeLive === false) {
        const cached = classify(id, selected?.run, selected?.entry, fresh);
        return { id, name, cli, registration, ...cached, stateLabel: labels[cached.state], lastObservedAt: timestamp, ageHours, freshWithin24Hours: fresh, evidence: selected ? evidenceText(selected.run, selected.entry) : '生存確認記録なし' };
      }
      const live = await probe(cli);
      const state: ExternalAgentState = live.liveState === 'healthy' ? 'available' : live.liveState === 'not_installed' ? 'unavailable' : 'needs_recheck';
      const note = live.liveState === 'healthy' ? 'CLIのリアルタイム生存確認に成功しました。' : live.liveState === 'not_installed' ? 'CLIがローカルで検出できません。' : 'CLIは検出しましたが生存確認に失敗しました。';
      return { id, name, cli, registration, state, note, stateLabel: labels[state], lastObservedAt: live.checkedAt, ageHours: 0, freshWithin24Hours: true, evidence: selected ? evidenceText(selected.run, selected.entry) : 'リアルタイムCLI検査', version: live.version, liveState: live.liveState, latencyMs: live.latencyMs, probeError: live.probeError };
    }));
    const summary = { available: 0, candidate: 0, needs_recheck: 0, unavailable: 0, total: agents.length };
    for (const agent of agents) summary[agent.state]++;
    return { source: summaryPath, cacheUpdatedAt: fileStat.mtime.toISOString(), cacheAgeHours, cacheFreshWithin24Hours: runs.length > 0 && cacheAgeHours <= 24, agents, summary };
  } catch (error) {
    options.signal?.throwIfAborted();
    const manual = await loadManualAgents().catch(() => []);
    const registry = [...REGISTRY.map(value => ({ ...value, cli: AGENT_CATALOG.find(item => item.id === value.id)?.cli || value.id, registration: 'built_in' as const })), ...manual.filter(value => !REGISTRY.some(item => item.id === value.id)).map(value => ({ ...value, registration: 'manual' as const }))];
    const registered = registry.filter(agent => agentRegistered(agent.id));
    const agents = options.probeLive === false
      ? registered.map(({ id, name, cli, registration }) => ({ id, name, cli, registration, state: 'needs_recheck' as const, stateLabel: labels.needs_recheck, note: 'Health Check Cacheを読み取れないため再確認が必要です。', freshWithin24Hours: false }))
      : await Promise.all(registered.map(async ({ id, name, cli, registration }) => { const live = await probe(cli); const state: ExternalAgentState = live.liveState === 'healthy' ? 'available' : live.liveState === 'not_installed' ? 'unavailable' : 'needs_recheck'; return { id, name, cli, registration, state, stateLabel: labels[state], note: live.liveState === 'healthy' ? 'CLIのリアルタイム生存確認に成功しました。' : 'CLIのリアルタイム生存確認に成功していません。', lastObservedAt: live.checkedAt, freshWithin24Hours: true, version: live.version, liveState: live.liveState }; }));
    const summary = { available: 0, candidate: 0, needs_recheck: 0, unavailable: 0, total: agents.length };
    for (const agent of agents) summary[agent.state]++;
    return { source: summaryPath, cacheFreshWithin24Hours: false, agents, summary, warning: error instanceof Error ? error.message : String(error) };
  }
}
