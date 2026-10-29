import { readFileSync } from 'node:fs';
import path from 'node:path';
import { connectionStorePath } from './agent-connection-policy.js';
import { atomicOrdinaryWrite } from './safe-file.js';

export interface MaintenanceDeploymentStatus { status: 'pending' | 'deployed' | 'rolled_back' | 'recovery_required'; at: string; candidateId: string }
export interface AgentDeploymentStatus { status: 'deployment_started' | 'deployed_pending_agent_verification' | 'rolled_back' | 'unconfirmed' | 'recovery_required'; at: string; candidateId: string; reason?: string }
const statusPath = () => path.join(process.env.WENTIAN_AI_MAINTENANCE_ROOT || path.join(path.dirname(connectionStorePath()), 'ai-maintenance'), 'deployment-status', 'current.json');
const agentStatusPath = (agent: string) => {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent)) throw new Error('Agent識別子が不正です。');
  return path.join(path.dirname(statusPath()), `${agent}.json`);
};

/** 共有アダプター変更後は、全Agentについて変更後の接続・実作業証跡を要求します。 */
export function maintenanceDeploymentCutoff(): number | undefined {
  let value: MaintenanceDeploymentStatus;
  try { value = JSON.parse(readFileSync(statusPath(), 'utf8')) as MaintenanceDeploymentStatus; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return Number.POSITIVE_INFINITY; }
  if (!value || !['pending', 'deployed', 'rolled_back', 'recovery_required'].includes(value.status)) return Number.POSITIVE_INFINITY;
  if (value.status === 'rolled_back') return undefined;
  if (value.status === 'pending' || value.status === 'recovery_required') return Number.POSITIVE_INFINITY;
  const time = Date.parse(value.at);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

export async function writeMaintenanceDeploymentStatus(value: MaintenanceDeploymentStatus): Promise<void> {
  await atomicOrdinaryWrite(statusPath(), JSON.stringify(value) + '\n');
}

/** 独立監督の実結果を、次のAI保守サイクルへ根拠として引き継ぎます。 */
export function readAgentDeploymentStatus(agent: string): AgentDeploymentStatus | undefined {
  try {
    const value = JSON.parse(readFileSync(agentStatusPath(agent), 'utf8')) as AgentDeploymentStatus;
    if (!value || !['deployment_started', 'deployed_pending_agent_verification', 'rolled_back', 'unconfirmed', 'recovery_required'].includes(value.status)
      || typeof value.at !== 'string' || typeof value.candidateId !== 'string' || (value.reason !== undefined && typeof value.reason !== 'string')) throw new Error('形式不正');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { status: 'recovery_required', at: new Date().toISOString(), candidateId: '', reason: '配備状態を確認できません。' };
  }
}
export async function writeAgentDeploymentStatus(agent: string, value: AgentDeploymentStatus): Promise<void> {
  await atomicOrdinaryWrite(agentStatusPath(agent), JSON.stringify(value) + '\n');
}
