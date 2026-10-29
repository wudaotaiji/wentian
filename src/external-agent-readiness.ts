import { createAgentMaintenanceManager } from './agent-maintenance-manager.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadExternalAgentSnapshot, type ExternalAgentSnapshot, type ExternalAgentStatus } from './external-agents.js';
import { connectionAllowsExecution, conversationAllowsExecution } from './agent-connection-policy.js';
import { maintainAgentConnections } from './agent-connection-maintenance.js';
import { readWorkEvidence, workAllowsExecution } from './agent-work-policy.js';
import { codexImageVerified } from './codex-image-evidence.js';
import { agentNotExcluded } from './agent-exclusion-policy.js';
import type { AgentMaintenanceSettings } from './agent-maintenance-settings.js';

export type AgentWorkCategory = 'image' | 'text' | 'reading' | 'coding' | 'testing' | 'verification';

export interface ExternalAgentReadySnapshot extends ExternalAgentSnapshot {
  readinessVersion: '1.0';
  refreshedAt: string;
  nextRefreshAt: string;
  refreshIntervalMs: number;
  pools: Record<AgentWorkCategory, string[]>;
}

const categories: Record<string, AgentWorkCategory[]> = {
  ollama: ['text','coding','testing','verification'],
  lmstudio: ['text','coding','testing','verification'],
  codex: ['image','text','coding','testing','verification'],
  goose: ['text', 'coding', 'testing', 'verification'],
  crush: ['text', 'testing', 'verification'],
  kilo: ['text', 'coding', 'testing', 'verification'],
  opencode: ['text', 'coding', 'testing', 'verification'],
  hermes: ['image', 'text', 'coding', 'testing', 'verification'],
  claude: ['image', 'text', 'coding', 'testing', 'verification'],
  openclaw: ['image', 'text', 'coding', 'testing', 'verification'],
  // Clineはtool_callが標準出力に出るだけで適用されない環境があるため、制作・試験ではなく静的レビューへ限定します。
  cline: ['text', 'verification'],
};

export function readinessCachePath(): string {
  return process.env.WENTIAN_AGENT_READY_CACHE || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'external-agent-readiness.json');
}

/** 実測で利用可能なAgentを、事前定義した作業能力ごとの待機候補群へ分類します。 */
export function buildReadySnapshot(snapshot: ExternalAgentSnapshot, intervalMs: number, now = new Date()): ExternalAgentReadySnapshot {
  const ready = snapshot.agents.filter(agent => agent.state === 'available' && agent.liveState === 'healthy' && connectionAllowsExecution(agent));
  const evidence = readWorkEvidence();
  snapshot = { ...snapshot, agents: snapshot.agents.map(agent => ({ ...agent, workEvidence: evidence[agent.id] || agent.workEvidence })) };
  const pools = Object.fromEntries((['image', 'text', 'reading', 'coding', 'testing', 'verification'] as AgentWorkCategory[]).map(category => [category, (category === 'text' ? snapshot.agents.filter(conversationAllowsExecution) : ready.filter(agent => category === 'image' ? agent.id === 'codex' && codexImageVerified() : (category === 'reading' || (categories[agent.id] || ['text']).includes(category)) && workAllowsExecution(agent, category, now.getTime()))).map(agent => agent.id)])) as Record<AgentWorkCategory, string[]>;
  const summary = { available: 0, candidate: 0, needs_recheck: 0, unavailable: 0, total: snapshot.agents.length };
  for (const agent of snapshot.agents) summary[agent.state]++;
  return { ...snapshot, summary, readinessVersion: '1.0', refreshedAt: now.toISOString(), nextRefreshAt: new Date(now.getTime() + intervalMs).toISOString(), refreshIntervalMs: intervalMs, pools };
}

/** CLIとDaemonの別プロセス間で共有できるよう、SnapshotをAtomic（原子的 / Atomic）に保存します。 */
export async function saveReadySnapshot(snapshot: ExternalAgentReadySnapshot): Promise<void> {
  const target = readinessCachePath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  await renameWithRetry(temporary, target);
}

export async function readReadySnapshot(maxAgeMs?: number): Promise<ExternalAgentReadySnapshot | undefined> {
  try {
    const parsed = JSON.parse(await readFile(readinessCachePath(), 'utf8')) as ExternalAgentReadySnapshot;
    if (parsed.readinessVersion !== '1.0' || !parsed.refreshedAt || !parsed.pools) return undefined;
    if (maxAgeMs !== undefined && Date.now() - Date.parse(parsed.refreshedAt) > maxAgeMs) return undefined;
    return parsed;
  } catch { return undefined; }
}

export interface ExternalAgentReadinessManager {
  current(): ExternalAgentReadySnapshot | undefined;
  refresh(): Promise<ExternalAgentReadySnapshot>;
  updateAgent(agent: ExternalAgentStatus): Promise<void>;
  stop(): Promise<void>;
  enableConnectionMaintenance(agentId?: string): void;
  maintenanceStatus(): AgentMaintenanceStatus;
  refreshResourceStatus?(): Promise<AgentMaintenanceStatus>;
  configureMaintenance(patch: unknown): Promise<AgentMaintenanceStatus>;
  requestMaintenance(agentId?: string): void;
  reloadMaintenanceControls?(): void | Promise<void>;
  cancelAgentMaintenance(agentId: string): void;
}

export interface AgentMaintenanceStatus {
  resourcePaused?:boolean;
  resourceRetryCount?: number;
  resources?: { state: import('./maintenance-resources.js').MaintenanceResourceState; usage?: import('./maintenance-resources.js').MaintenanceResources } & Partial<import('./maintenance-resources.js').ResourceMeasurementInfo>;
  settings: AgentMaintenanceSettings;
  state: 'starting' | 'running' | 'stopping' | 'waiting' | 'stopped' | 'disabled' | 'error';
  reason?: string;
  currentAgent?: string;
  activeAgents?: string[];
  stage?: string;
  startedAt?: string;
  finishedAt?: string;
  nextRunAt?: string;
  pendingAgents: string[];
  targets: string[];
  excludedAgents: string[];
  lastError?: string;
  constraints: { connectionDisabled: boolean; autoInstallDisabled: boolean };
}

/** 未導入判定も一時的な負キャッシュとして扱い、常駐ループの再確認対象に含めます。 */
export function agentsNeedingRepair(agents: ExternalAgentStatus[]): ExternalAgentStatus[] {
  return agents.filter(agent => agentNotExcluded(agent) && (agent.liveState !== 'healthy' || !connectionAllowsExecution(agent)));
}

/** Gateway内で生存確認を定期実行し、要求到着前からReady Poolを温めておきます。 */
export function startExternalAgentReadinessManager(options: { intervalMs?: number; onError?: (error: unknown) => void; maintainConnections?: boolean } = {}, dependencies: {
  loadSnapshot?: typeof loadExternalAgentSnapshot; maintain?: typeof maintainAgentConnections;
} = {}): ExternalAgentReadinessManager {
  return createAgentMaintenanceManager(options, dependencies);
}
/** Orchestrator用に、Daemonが用意した新鮮な待機Snapshotを優先して返します。 */
export async function readyAgentsOrFallback(maxAgeMs = 600_000): Promise<ExternalAgentStatus[]> {
  return (await readReadySnapshot(maxAgeMs))?.agents || (await loadExternalAgentSnapshot({ probeLive: false })).agents;
}
