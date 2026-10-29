import { spawn } from 'node:child_process';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOrdinaryPath, atomicOrdinaryWrite } from './safe-file.js';
import { readDaemonRecord } from './cli-runtime.js';
import { validateSourceDeployment, type SourceDeployment } from './maintenance-source-deployment.js';
import { writeAgentDeploymentStatus } from './maintenance-deployment-status.js';

/** Daemonの停止後も生存する独立監督プロセスへ、検証済み候補の配備を引き継ぎます。 */
export async function launchMaintenanceSourceDeployment(input: SourceDeployment, stagingRoot: string, agent: string, signal?: AbortSignal): Promise<unknown> {
  const request = validateSourceDeployment(input);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agent)) throw new Error('配備対象Agentが不正です。');
  signal?.throwIfAborted();
  const daemon = await readDaemonRecord();
  if (!daemon || daemon.pid !== process.pid) throw new Error('独立監督によるDaemon配備を開始できません。');
  const root = path.resolve(process.env.WENTIAN_INSTALL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const runtime = path.join(root, '.wentian', 'runtime'), lockPath = path.join(runtime, 'maintenance-deploy.lock');
  await assertOrdinaryPath(lockPath); await mkdir(runtime, { recursive: true });
  const lock = await open(lockPath, 'wx', 0o600);
  let launched = false;
  try {
    const job = path.join(stagingRoot, request.candidateId, 'deployment-job.json');
    await atomicOrdinaryWrite(job, JSON.stringify({ version: 1, candidateId: request.candidateId, agent, root, daemon }) + '\n');
    await writeAgentDeploymentStatus(agent, { status: 'deployment_started', at: new Date().toISOString(), candidateId: request.candidateId });
    await lock.writeFile(JSON.stringify({ candidateId: request.candidateId, agent, createdAt: new Date().toISOString() }));
    await lock.close();
    signal?.throwIfAborted();
    const worker = path.join(root, 'src', 'maintenance-source-deployment-worker.ts');
    // Bun Daemonでは現在のBunでTypeScriptを直接起動し、Node Daemonではtsxを使用します。
    const bun = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
    const child = spawn(process.execPath, bun ? [worker, agent, request.candidateId] : ['--import', 'tsx', worker, agent, request.candidateId],
      { cwd: root, detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, WENTIAN_INSTALL_ROOT: root } });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); launched = true;
    return { status: 'deployment_started', candidateId: request.candidateId };
  } finally {
    await lock.close().catch(() => undefined);
    if (!launched) {
      await writeAgentDeploymentStatus(agent, { status: 'unconfirmed', at: new Date().toISOString(), candidateId: request.candidateId, reason: '独立監督を起動できませんでした。' }).catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
