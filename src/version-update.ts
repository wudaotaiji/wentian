import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processAlive, readDaemonRecord, startDaemon, stopDaemon } from './cli-runtime.js';

export interface VersionUpdatePlan {
  installRoot: string; currentVersion: string; branch: string; currentCommit: string;
  remoteCommit?: string; relation: 'current' | 'local_ahead' | 'update_available' | 'unknown'; updateAvailable: boolean; clean: boolean; changes: string[]; checkedAt: string;
  canApply: boolean; reason?: string;
}

export interface VersionUpdateApproval { token: string; targetCommit: string; expiresAt: number; }

interface UpdateManifest extends Record<string, unknown> { status: 'running' | 'completed' | 'rolled_back' | 'failed'; steps: Array<{ name: string; success: boolean; detail: string }> }

function run(executable: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  if (process.platform === 'win32' && executable === 'npm.cmd') {
    if (!args.every(value => /^[a-z-]+$/.test(value))) throw new Error('Unsupported npm arguments');
    return run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], cwd, timeoutMs);
  }
  return new Promise((resolve, reject) => execFile(executable, args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`${executable} ${args.join(' ')}: ${String(stderr || stdout || error.message).trim()}`)) : resolve(String(stdout).trim())));
}

const git = (args: string[], cwd: string, timeoutMs?: number) => run('git', args, cwd, timeoutMs ?? 5_000);
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';

export function installRoot(): string { return path.resolve(process.env.WENTIAN_INSTALL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..')); }

/** Remoteを変更せず参照し、現在版・作業ツリー・更新可能性を計画として返します。 */
export async function createVersionUpdatePlan(root = installRoot()): Promise<VersionUpdatePlan> {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version?: string };
  const [branch, currentCommit, status] = await Promise.all([git(['branch', '--show-current'], root), git(['rev-parse', 'HEAD'], root), git(['status', '--porcelain'], root)]);
  const changes = status ? status.split(/\r?\n/).filter(Boolean) : [];
  let remoteCommit: string | undefined; let remoteError: string | undefined;
  try { remoteCommit = (await git(['ls-remote', 'origin', `refs/heads/${branch}`], root, 5_000)).split(/\s+/)[0] || undefined; }
  catch (error) { remoteError = error instanceof Error ? error.message : String(error); }
  if (!remoteCommit && !remoteError) remoteError = 'Remote branch was not found.';
  let relation: VersionUpdatePlan['relation'] = !remoteCommit ? 'unknown' : remoteCommit === currentCommit ? 'current' : 'update_available';
  if (remoteCommit && remoteCommit !== currentCommit) {
    // Remote Commitがローカル履歴に存在し、HEADの祖先ならローカル側が先行しています。
    try { await git(['merge-base', '--is-ancestor', remoteCommit, currentCommit], root); relation = 'local_ahead'; } catch { /* 未取得またはRemote側更新のため、適用時のff-onlyで最終検証します。 */ }
  }
  const updateAvailable = relation === 'update_available';
  const clean = changes.length === 0;
  const reason = !clean ? '未コミット変更があるため更新できません。Commitまたは退避してください。' : remoteError ? `Remote確認に失敗しました: ${remoteError}` : relation === 'local_ahead' ? 'ローカルCommitがRemoteより先行しています。更新ではなくPush対象です。' : !updateAvailable ? '現在のCommitはRemote最新版と一致しています。' : undefined;
  return { installRoot: root, currentVersion: packageJson.version || 'unknown', branch, currentCommit, remoteCommit, relation, updateAvailable, clean, changes, checkedAt: new Date().toISOString(), canApply: clean && updateAvailable, reason };
}

export function issueVersionUpdateApproval(plan: VersionUpdatePlan): VersionUpdateApproval {
  if (!plan.canApply || !plan.remoteCommit) throw new Error(plan.reason || '更新を実行できません。');
  return { token: randomUUID(), targetCommit: plan.remoteCommit, expiresAt: Date.now() + 60_000 };
}

/** 更新・検証・Daemon再起動を行い、失敗時は更新前Commitへ戻します。 */
export async function applyVersionUpdate(approval: VersionUpdateApproval, suppliedToken: string, emit: (text: string) => void, root = installRoot()): Promise<{ manifestPath: string; version: string; commit: string }> {
  if (suppliedToken !== approval.token || Date.now() > approval.expiresAt) throw new Error('更新Tokenが無効または期限切れです。もう一度/updateを実行してください。');
  const plan = await createVersionUpdatePlan(root);
  if (!plan.clean) throw new Error(plan.reason);
  if (plan.remoteCommit !== approval.targetCommit) throw new Error('確認後にRemote最新版が変わりました。もう一度/updateを実行してください。');
  const runtimeDirectory = path.join(root, '.wentian', 'updates');
  await mkdir(runtimeDirectory, { recursive: true });
  const manifestPath = path.join(runtimeDirectory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${approval.targetCommit.slice(0, 8)}.json`);
  const manifest: UpdateManifest = { status: 'running', startedAt: new Date().toISOString(), fromCommit: plan.currentCommit, targetCommit: approval.targetCommit, fromVersion: plan.currentVersion, steps: [] };
  const save = () => writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const step = async (name: string, operation: () => Promise<string>) => { emit(`• ${name}`); try { const detail = await operation(); manifest.steps.push({ name, success: true, detail: detail.slice(-2000) }); await save(); } catch (error) { manifest.steps.push({ name, success: false, detail: error instanceof Error ? error.message : String(error) }); await save(); throw error; } };
  await save();
  const daemon = await readDaemonRecord(); const daemonWasRunning = Boolean(daemon && processAlive(daemon.pid));
  try {
    await step('Remote更新を取得', () => git(['fetch', '--no-tags', 'origin', plan.branch], root, 120_000));
    const fetched = await git(['rev-parse', 'FETCH_HEAD'], root);
    if (fetched !== approval.targetCommit) throw new Error('取得したCommitが承認対象と一致しません。');
    await step('Fast-forward更新を適用', () => git(['merge', '--ff-only', approval.targetCommit], root));
    await step('依存関係を固定Lockfileから復元', () => run(npmExecutable, ['ci'], root, 300_000));
    await step('TypeScript型検査', () => run(npmExecutable, ['run', 'build'], root, 180_000));
    await step('全自動テスト', () => run(npmExecutable, ['test'], root, 300_000));
    if (daemonWasRunning && daemon) await step('Gateway Daemonを再起動', async () => { await stopDaemon(); return JSON.stringify(await startDaemon(daemon.port, daemon.hostname)); });
    const updatedPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    manifest.status = 'completed'; manifest.completedAt = new Date().toISOString(); manifest.toVersion = updatedPackage.version; await save();
    return { manifestPath, version: updatedPackage.version || 'unknown', commit: approval.targetCommit };
  } catch (error) {
    emit('• 更新に失敗したためRollbackを開始します。');
    try {
      const rollbackStatus = await git(['status', '--porcelain'], root);
      if (rollbackStatus) throw new Error(`更新開始後に作業ツリー変更を検出したため、自動resetを中止しました。変更を保護したまま手動確認が必要です: ${rollbackStatus.split(/\r?\n/).slice(0, 20).join(' / ')}`);
      await git(['reset', '--hard', plan.currentCommit], root);
      await run(npmExecutable, ['ci'], root, 300_000);
      if (daemonWasRunning && daemon && !(await readDaemonRecord())) await startDaemon(daemon.port, daemon.hostname);
      manifest.status = 'rolled_back'; manifest.rollbackCompletedAt = new Date().toISOString();
    } catch (rollbackError) { manifest.status = 'failed'; manifest.rollbackError = rollbackError instanceof Error ? rollbackError.message : String(rollbackError); }
    manifest.error = error instanceof Error ? error.message : String(error); await save(); throw new Error(`Version更新に失敗しました。状態=${manifest.status}。Manifest: ${manifestPath}`);
  }
}

export function formatVersionUpdatePlan(plan: VersionUpdatePlan, approval?: VersionUpdateApproval): string {
  return [`Version Update（バージョン更新 / Version Update）`, `  current version: ${plan.currentVersion}`, `  branch: ${plan.branch}`, `  current commit: ${plan.currentCommit}`, `  remote commit: ${plan.remoteCommit || '取得失敗'}`, `  relation: ${plan.relation}`, `  update available: ${plan.updateAvailable}`, `  worktree clean: ${plan.clean}`, ...(plan.changes.length ? ['  changes:', ...plan.changes.slice(0, 20).map(value => `    ${value}`)] : []), `  result: ${plan.reason || '更新可能'}`, ...(approval ? [`  approval token: ${approval.token}`, `  expires: ${new Date(approval.expiresAt).toISOString()}`, `  実行: /update apply ${approval.token}`] : [])].join('\n');
}
