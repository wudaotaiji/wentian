import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicOrdinaryWrite, assertOrdinaryPath } from './safe-file.js';
import { publishTaskWorkspace, type TaskWorkspace } from './task-workspace.js';

// 初期の自動配備はAgent接続・導入のアダプターだけに限定します。
const deployable = new Set(['src/agent-connection-maintenance.ts', 'src/agent-install-maintenance.ts', 'src/agent-native-models.ts', 'src/agent-marketplace.ts', 'src/agent-runtime.ts', 'src/agent-model-selection.ts']);
export function isAutomaticallyDeployableSource(source: unknown): boolean { return typeof source === 'string' && deployable.has(source); }
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export interface SourceDeployment { candidateId: string }
export class DeploymentPreflightError extends Error {}

export function validateSourceDeployment(value: unknown): SourceDeployment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自動配備の指定が不正です。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'candidateId') || typeof input.candidateId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.candidateId)) throw new Error('自動配備の指定が不正です。');
  return { candidateId: input.candidateId };
}

interface DeploymentReceipt { version: 1; status: 'candidate_verified'; candidateId: string; source: string; beforeHash: string; afterHash: string; test: string; testHash: string; workspace: string; installRoot: string }
export interface DeploymentDependencies {
  authorized: () => Promise<boolean>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  healthy: () => Promise<boolean>;
  markPending?: () => Promise<void>;
}

/** 検証済みコピーと現在の原本、利用者による未コミット変更を配備直前に再照合します。 */
export async function deployVerifiedMaintenanceCandidate(input: SourceDeployment, stagingRoot: string, rootInput: string, dependencies: DeploymentDependencies): Promise<{ status: string; reason?: string }> {
  let applyStarted = false;
  try {
  const request = validateSourceDeployment(input);
  const root = await realpath(rootInput), proposal = path.join(stagingRoot, request.candidateId);
  await assertOrdinaryPath(proposal);
  const receipt = JSON.parse(await readFile(path.join(proposal, 'verified.json'), 'utf8')) as DeploymentReceipt;
  if (receipt.version !== 1 || receipt.status !== 'candidate_verified' || receipt.candidateId !== request.candidateId || !isAutomaticallyDeployableSource(receipt.source)
    || !/^[a-f0-9]{64}$/.test(receipt.beforeHash) || !/^[a-f0-9]{64}$/.test(receipt.afterHash) || !/^[a-f0-9]{64}$/.test(receipt.testHash)
    || !/^src\/[a-zA-Z0-9_.\/-]+\.test\.ts$/.test(receipt.test) || receipt.test.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))
    || await realpath(receipt.installRoot) !== root) throw new Error('配備できる検証証跡を確認できません。');
  const workspace = await realpath(receipt.workspace), relative = path.relative(await realpath(os.tmpdir()), workspace);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !/^wentian-task-[a-zA-Z0-9]+$/.test(relative)) throw new Error('検証場所が専用一時領域外です。');
  const originalPath = path.join(root, receipt.source), stagedPath = path.join(workspace, receipt.source), stagedTest = path.join(workspace, receipt.test);
  await assertOrdinaryPath(originalPath); await assertOrdinaryPath(stagedPath); await assertOrdinaryPath(stagedTest);
  const original = await readFile(originalPath), candidate = await readFile(stagedPath);
  if (digest(original) !== receipt.beforeHash || digest(candidate) !== receipt.afterHash || digest(await readFile(stagedTest)) !== receipt.testHash) throw new Error('検証後に原本・候補・テストが変更されました。');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  const git = await promisify(execFile)('git', ['status', '--porcelain', '--', receipt.source], { cwd: root, env, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  if (git.stdout.trim()) throw new Error('対象ソースに利用者の未コミット変更があるため自動配備しません。');
  if (!await dependencies.authorized()) throw new Error('保守の停止・取消または資源状態のため自動配備できません。');
  if (!await dependencies.healthy()) throw new Error('配備前の稼働状態を確認できません。');
  const task = { source: root, directory: workspace } as TaskWorkspace;
  applyStarted = true;
  const result = await publishTaskWorkspace(task, [{ path: receipt.source, kind: 'modified', beforeHash: receipt.beforeHash, afterHash: receipt.afterHash }]);
  if (result.status !== 'published') { if (!result.recoveryRequired) applyStarted = false; throw new Error(`ソースの競合検査または反映に失敗しました: ${result.note}`); }
  let daemonStopped = false, restarted = false;
  try {
    if (!await dependencies.authorized()) throw new Error('配備中に保守が停止されました。');
    if (digest(await readFile(originalPath)) !== receipt.afterHash) throw new Error('再起動前にソースが変更されました。');
    await dependencies.markPending?.();
    if (!await dependencies.authorized()) throw new Error('再起動前に保守が停止されました。');
    // 停止失敗時も待受喪失の可能性があるため、復元後の起動確認を必須にします。
    daemonStopped = true; await dependencies.stop();
    if (digest(await readFile(originalPath)) !== receipt.afterHash) throw new Error('停止中にソースが変更されました。');
    await dependencies.start(); daemonStopped = false; restarted = true;
    if (!await dependencies.healthy()) throw new Error('再起動後の稼働確認に失敗しました。');
    if (digest(await readFile(originalPath)) !== receipt.afterHash) throw new Error('再起動中にソースが変更されました。');
    const outcome = { status: 'deployed_pending_agent_verification' };
    await atomicOrdinaryWrite(path.join(proposal, 'deployment.json'), JSON.stringify({ ...outcome, at: new Date().toISOString(), journalPath: result.journalPath }) + '\n');
    return outcome;
  } catch (error) {
    // 復元は配備した内容がまだ残っている場合だけ行い、その後の利用者変更を上書きしません。
    const current = await readFile(originalPath);
    if (digest(current) !== receipt.afterHash) {
      const outcome = { status: 'recovery_required', reason: '配備後に対象が変更されたため自動復元できません。' };
      await atomicOrdinaryWrite(path.join(proposal, 'deployment.json'), JSON.stringify({ ...outcome, at: new Date().toISOString() }) + '\n');
      return outcome;
    }
    if (restarted) {
      try { await dependencies.stop(); daemonStopped = true; }
      catch {
        const outcome = { status: 'recovery_required', reason: '新しいDaemonを停止できないため自動復元できません。' };
        await atomicOrdinaryWrite(path.join(proposal, 'deployment.json'), JSON.stringify({ ...outcome, at: new Date().toISOString() }) + '\n');
        return outcome;
      }
    }
    await atomicOrdinaryWrite(originalPath, original);
    if (daemonStopped) { try { await dependencies.start(); daemonStopped = false; } catch { /* 復元後の起動失敗は台帳へ残します。 */ } }
    const outcome = { status: daemonStopped ? 'recovery_required' : 'rolled_back', reason: daemonStopped ? '元ソースへ復元しましたがDaemonを再起動できません。' : '配備に失敗したため元ソースへ復元しました。' };
    await atomicOrdinaryWrite(path.join(proposal, 'deployment.json'), JSON.stringify({ ...outcome, at: new Date().toISOString() }) + '\n');
    return outcome;
  }
  } catch (error) {
    if (!applyStarted) throw new DeploymentPreflightError(error instanceof Error ? error.message : '配備前の確認に失敗しました。');
    throw error;
  }
}
