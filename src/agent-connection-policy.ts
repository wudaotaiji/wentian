import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { agentNotExcluded } from './agent-exclusion-policy.js';
import { maintenanceControlStatus } from './maintenance-controls.js';

export type ConnectionMode = 'free' | 'local' | 'native';
export interface AgentConnection {
  maintenanceDeferred?: boolean;
  maintenanceDeferredKind?: 'permission' | 'model';
  mode: ConnectionMode; model: string; provider?: string; baseUrl?:string;source?:'free'|'wentian'|'other';
  status: 'verified' | 'failed' | 'pending'; checkedAt: string; expiresAt: string;
  fingerprint: string; policyHash: string; cliVersion?: string; reason?: string;
  attempts?: Array<{ model: string; mode?:ConnectionMode; provider?:string; baseUrl?:string; status: 'verified' | 'failed'; reason?: string; phase?:'connection'|'work'; checkedAt?:string; retryAt?:string }>;
  discoveryWarning?:string;
  stage?: 'cli' | 'settings' | 'discovery' | 'probe' | 'rollback';
}
export interface ConnectionPolicy {
  revision: number;
  enabled: boolean; cacheTtlMs: number; retryAfterMs: number; probeTimeoutMs: number;
  localBaseUrl: string; localModel: string; maxCandidates: number;
}
export const managedAgentIds = ['ollama', 'lmstudio', 'goose', 'crush', 'kilo', 'opencode', 'hermes', 'claude', 'openclaw', 'cline', 'codex'];

/** 管理者が有効化した無料優先方針を、常駐・CLIの両方で同じ設定から読み込みます。 */
export function connectionPolicy(): ConnectionPolicy {
  return { revision: 9, enabled: maintenanceControlStatus().connection.allowed, cacheTtlMs: 86_400_000,
    retryAfterMs: 60_000, probeTimeoutMs: 180_000,
    localBaseUrl: process.env.WENTIAN_LOCAL_LLM_BASE_URL || process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1',
    localModel: process.env.WENTIAN_LOCAL_LLM_MODEL || 'local-model', maxCandidates: 2 };
}
export function connectionStorePath(): string {
  return process.env.WENTIAN_AGENT_CONNECTION_CACHE || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'agent-connections.json');
}
export function readAgentConnections(): Record<string, AgentConnection> {
  try { return existsSync(connectionStorePath()) ? JSON.parse(readFileSync(connectionStorePath(), 'utf8')).agents || {} : {}; } catch { return {}; }
}

/** 応答成功の有効期限を越えたモデルや、未検証モデルを通常実行へ渡しません。 */
export function managedConnection(agent: string): AgentConnection | undefined {
  if (!connectionPolicy().enabled) return undefined;
  const entry = readAgentConnections()[agent];
  return entry?.status === 'verified' && Date.parse(entry.expiresAt) > Date.now() ? entry : undefined;
}

/** 同一Agentの無料モデルに限定し、有料モデルを修復候補へ混入させません。 */
export function isFreeAgentModel(agent: string, model: string): boolean {
  if (agent === 'opencode') return /^opencode\/[a-z0-9._-]+-free$/.test(model);
  if (agent === 'kilo') return model === 'kilo/kilo-auto/free' || /^kilo\/[a-z0-9/._-]+:free$/.test(model);
  if (agent === 'crush') return /^opencode-zen\/[a-z0-9._-]+-free$/.test(model);
  if (agent === 'cline') return /^cline-free\/[a-z0-9._-]+$/.test(model);
  return false;
}

/** CLIだけ復帰しても、接続検証に失敗したAgentは利用候補へ戻しません。 */
export function connectionAllowsExecution(agent: { id: string; connection?: AgentConnection; registration?: string; excluded?: boolean }): boolean {
  if (!agentNotExcluded(agent)) return false;
  if (!connectionPolicy().enabled) return true;
  const stored = readAgentConnections()[agent.id];
  const entry = agent.connection?.status !== 'verified' && agent.connection ? agent.connection : stored || agent.connection;
  if (stored && agent.connection?.status === 'verified' && stored.model !== agent.connection.model) return false;
  if (!entry) return agent.id !== 'codex' && (agent.registration !== 'built_in' || !managedAgentIds.includes(agent.id));
  return entry.status === 'verified' && Date.parse(entry.expiresAt) > Date.now();
}

/** 会話はCLIの生存と接続確認で判断し、ファイル操作の検証状態とは分離します。 */
export function conversationAllowsExecution(agent: { id: string; liveState?: string; connection?: AgentConnection; registration?: string; excluded?: boolean }): boolean {
  return agent.liveState === 'healthy' && connectionAllowsExecution(agent);
}
