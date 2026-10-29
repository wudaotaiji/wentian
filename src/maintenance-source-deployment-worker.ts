import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { connectionPolicy, connectionStorePath } from './agent-connection-policy.js';
import { agentNotExcluded } from './agent-exclusion-policy.js';
import { readMaintenanceSettings } from './agent-maintenance-settings.js';
import { readDaemonRecord, startDaemon, stopDaemon, type DaemonRecord } from './cli-runtime.js';
import { executionAccessSummary } from './execution-governance.js';
import { maintenanceResourceState, measureMaintenanceResources } from './maintenance-resources.js';
import { assertOrdinaryPath, atomicOrdinaryWrite } from './safe-file.js';
import { DeploymentPreflightError, deployVerifiedMaintenanceCandidate, validateSourceDeployment } from './maintenance-source-deployment.js';
import { writeAgentDeploymentStatus, writeMaintenanceDeploymentStatus, type AgentDeploymentStatus } from './maintenance-deployment-status.js';

/** 親Daemonとは別プロセスで配備・再起動・失敗時の復元を監督します。 */
async function run(): Promise<void> {
  const agent = process.argv[2], candidateId = process.argv[3];
  if (!agent || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent)) throw new Error('配備対象Agentが不正です。');
  validateSourceDeployment({ candidateId });
  const root = path.resolve(process.env.WENTIAN_INSTALL_ROOT || process.cwd());
  const reports = process.env.WENTIAN_AI_MAINTENANCE_ROOT || path.join(path.dirname(connectionStorePath()), 'ai-maintenance');
  const staging = path.join(reports, 'proposals', agent), proposal = path.join(staging, candidateId);
  const lockPath = path.join(root, '.wentian', 'runtime', 'maintenance-deploy.lock');
  await assertOrdinaryPath(lockPath); await assertOrdinaryPath(proposal);
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { agent?: string; candidateId?: string };
  if (lock.agent !== agent || lock.candidateId !== candidateId) throw new Error('配備ロックを確認できません。');
  let preserveLock = false, markedPending = false;
  try {
    const job = JSON.parse(await readFile(path.join(proposal, 'deployment-job.json'), 'utf8')) as { version: number; agent: string; candidateId: string; root: string; daemon: DaemonRecord };
    const current = await readDaemonRecord();
    if (job.version !== 1 || job.agent !== agent || job.candidateId !== candidateId || path.resolve(job.root) !== root
      || !current || !job.daemon || current.pid !== job.daemon.pid || current.startedAt !== job.daemon.startedAt || current.port !== job.daemon.port || current.hostname !== job.daemon.hostname) throw new Error('配備開始時のDaemonを確認できません。');
    const original = job.daemon;
    const host = ['0.0.0.0', '::'].includes(original.hostname) ? '127.0.0.1' : original.hostname;
    const hostForUrl = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const healthy = async () => { try { const response = await fetch(`http://${hostForUrl}:${original.port}/health`, { signal: AbortSignal.timeout(10000) }); return response.ok && (await response.json() as { ok?: unknown }).ok === true; } catch { return false; } };
    const authorized = async () => {
      try {
        const access = executionAccessSummary(), resources = maintenanceResourceState(await measureMaintenanceResources());
        return readMaintenanceSettings().enabled && connectionPolicy().enabled && agentNotExcluded({ id: agent }) && access.maintenanceDefault
          && !access.revokedAgents.includes(agent) && (resources === 'normal' || resources === 'warning');
      } catch { return false; }
    };
    const result = await deployVerifiedMaintenanceCandidate({ candidateId }, staging, root, { authorized, healthy,
      stop: async () => { await stopDaemon(); }, start: async () => { await startDaemon(original.port, original.hostname); },
      markPending: async () => { markedPending = true; await writeMaintenanceDeploymentStatus({ status: 'pending', at: new Date().toISOString(), candidateId }); } });
    preserveLock = result.status === 'recovery_required';
    if (markedPending) await writeMaintenanceDeploymentStatus({ status: result.status === 'deployed_pending_agent_verification' ? 'deployed' : result.status === 'rolled_back' ? 'rolled_back' : 'recovery_required', at: new Date().toISOString(), candidateId });
    await writeAgentDeploymentStatus(agent, { status: result.status as AgentDeploymentStatus['status'], at: new Date().toISOString(), candidateId, ...(result.reason ? { reason: result.reason } : {}) });
  } catch (error) {
    preserveLock = !(error instanceof DeploymentPreflightError);
    if (markedPending) await writeMaintenanceDeploymentStatus({ status: 'recovery_required', at: new Date().toISOString(), candidateId }).catch(() => undefined);
    await writeAgentDeploymentStatus(agent, { status: preserveLock ? 'recovery_required' : 'unconfirmed', at: new Date().toISOString(), candidateId,
      reason: preserveLock ? '配備の監督状態を確認できません。' : (error as DeploymentPreflightError).message }).catch(() => undefined);
    await atomicOrdinaryWrite(path.join(proposal, 'deployment.json'), JSON.stringify({ status: preserveLock ? 'recovery_required' : 'unconfirmed', reason: preserveLock ? '自動配備の監督状態を確認できません。配備台帳と稼働状態を確認してください。' : (error as DeploymentPreflightError).message, at: new Date().toISOString() }) + '\n').catch(() => undefined);
  } finally {
    // 他の配備が作成したロックは削除せず、自分のロックだけを解放します。
    if (!preserveLock) try { const current = JSON.parse(await readFile(lockPath, 'utf8')) as typeof lock; if (current.agent === agent && current.candidateId === candidateId) await unlink(lockPath); } catch { /* ロック確認失敗は保持します。 */ }
  }
}

void run().catch(() => { process.exitCode = 1; });
