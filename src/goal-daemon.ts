/**
 * Goal Daemon: 5層アーキテクチャ拡張 Phase 6。
 * 設計参照: docs/ARCHITECTURE.md
 *
 * `wentian agent --goal start <id>` で `runGoalLoop` を detach 起動し、
 * TTY終了後も動き続ける。`--goal status/stop` で操作。
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { goalsRoot, loadGoal, listGoals, type GoalStore } from './goal-store.js';

export interface GoalDaemonRecord {
  version: '1.0';
  goalId: string;
  pid: number;
  startedAt: string;
  logPath: string;
  status: 'running' | 'stopping' | 'dead';
  auditAgent?: string;
}

function daemonPath(goalId: string): string {
  return path.join(goalsRoot(), goalId, 'daemon.json');
}

function logPath(goalId: string): string {
  return path.join(goalsRoot(), goalId, 'daemon.log');
}

function tsxCli(): string {
  // ESM対応: このファイルの絶対パスから cli.ts への相対パスを計算
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'src', 'cli.ts');
}

function runtimeRoot(): string {
  return process.env.WENTIAN_GOAL_PATH || path.join(process.cwd(), '.wentian', 'goals');
}

/** OSに問い合わせ、存在しないPIDを実行中として扱わないようにします。 */
export async function isPidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface StartGoalDaemonInput {
  server?: string;
  model?: string;
  goalId: string;
  auditAgent?: 'hermes' | 'claude' | 'kilo' | 'mock';
  autoResume?: boolean;
  /** 環境変数 (cwd等) */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface StartGoalDaemonResult {
  pid: number;
  logPath: string;
  daemonPath: string;
  alreadyRunning: boolean;
}

/** Goal Loopをデタッチ起動。既存Daemonが動いていればその情報を返す。 */
export async function startGoalDaemon(input: StartGoalDaemonInput): Promise<StartGoalDaemonResult> {
  const existing = await readDaemonRecord(input.goalId).catch(() => undefined);
  if (existing && existing.status === 'running' && await isPidAlive(existing.pid)) {
    return { pid: existing.pid, logPath: existing.logPath, daemonPath: daemonPath(input.goalId), alreadyRunning: true };
  }
  // stale record 削除
  if (existing) await unlink(daemonPath(input.goalId)).catch(() => undefined);
  // ディレクトリ準備
  const dir = path.join(goalsRoot(), input.goalId);
  await mkdir(dir, { recursive: true });
  const lp = logPath(input.goalId);
  // ログファイルを開く (append mode)
  const { open } = await import('node:fs/promises');
  const logHandle = await open(lp, 'a');
  const cliEntry = tsxCli();
  const runtimeArgs = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ? [] : ['--import', pathToFileURL(path.resolve(path.dirname(cliEntry), '../node_modules/tsx/dist/loader.mjs')).href];
  const args = [...runtimeArgs, cliEntry, 'agent', '--goal', 'worker', '--goal-id', input.goalId];
  if (input.server) args.push('--server', input.server);
  if (input.model) args.push('--model', input.model);
  if (input.auditAgent) args.push('--audit-agent', input.auditAgent);
  if (input.autoResume) args.push('--auto-resume');
  const child = spawn(process.execPath, args, {
    cwd: input.cwd || process.cwd(),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
    env: { ...process.env, ...input.env, WENTIAN_GOAL_PATH: path.resolve(goalsRoot()), WENTIAN_GOAL_WORKER: '1' },
  });
  child.unref();
  // 子プロセス側には複製済みのファイル記述子が渡るため、親側のHandleは直ちに閉じます。
  // 明示的に閉じることでNode.jsのGC任せによるDEP0137警告と長時間運用時のHandle枯渇を防ぎます。
  await logHandle.close();
  // 起動直後に死んだ場合はエラー
  await new Promise(resolve => setTimeout(resolve, 500));
  if (!(await isPidAlive(child.pid || -1))) {
    throw new Error(`Goal Daemon (PID ${child.pid}) は起動直後に終了しました。ログを確認してください: ${lp}`);
  }
  const record: GoalDaemonRecord = {
    version: '1.0', goalId: input.goalId, pid: child.pid || -1, startedAt: new Date().toISOString(),
    logPath: lp, status: 'running', auditAgent: input.auditAgent,
  };
  await writeFile(daemonPath(input.goalId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { pid: child.pid || -1, logPath: lp, daemonPath: daemonPath(input.goalId), alreadyRunning: false };
}

/** Daemonの起動記録を読み込みます。存在しなければ undefined。 */
export async function readDaemonRecord(goalId: string): Promise<GoalDaemonRecord | undefined> {
  try {
    const raw = await readFile(daemonPath(goalId), 'utf8');
    const parsed = JSON.parse(raw) as GoalDaemonRecord;
    if (parsed.version !== '1.0' || parsed.goalId !== goalId) return undefined;
    return parsed;
  } catch { return undefined; }
}

/** Daemonを停止します。SIGTERM (Windows: taskkill)、30秒待ってSIGKILL。 */
export async function stopGoalDaemon(goalId: string, options: { timeoutMs?: number } = {}): Promise<{ stopped: boolean; pid: number | null; message: string }> {
  const record = await readDaemonRecord(goalId);
  if (!record) return { stopped: false, pid: null, message: '起動記録がありません。' };
  if (!(await isPidAlive(record.pid))) {
    await writeFile(daemonPath(goalId), `${JSON.stringify({ ...record, status: 'dead' }, null, 2)}\n`, 'utf8');
    return { stopped: true, pid: record.pid, message: `PID ${record.pid} は既に停止しています。` };
  }
  // まず graceful
  if (process.platform === 'win32') {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      await exec('taskkill', ['/PID', String(record.pid), '/T'], { windowsHide: true, timeout: 5000 });
    } catch (error) {
      // taskkill失敗 → force
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const exec = promisify(execFile);
        await exec('taskkill', ['/F', '/PID', String(record.pid), '/T'], { windowsHide: true, timeout: 5000 });
      } catch { /* ignore */ }
    }
  } else {
    try { process.kill(record.pid, 'SIGTERM'); } catch { /* ignore */ }
  }
  // 30秒待つ
  const timeout = options.timeoutMs || 30_000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!(await isPidAlive(record.pid))) {
      await writeFile(daemonPath(goalId), `${JSON.stringify({ ...record, status: 'dead' }, null, 2)}\n`, 'utf8');
      return { stopped: true, pid: record.pid, message: `PID ${record.pid} を停止しました。` };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  // 強制終了
  if (process.platform === 'win32') {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      await exec('taskkill', ['/F', '/PID', String(record.pid), '/T'], { windowsHide: true, timeout: 5000 });
    } catch { /* ignore */ }
  } else {
    try { process.kill(record.pid, 'SIGKILL'); } catch { /* ignore */ }
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
  await writeFile(daemonPath(goalId), `${JSON.stringify({ ...record, status: 'dead' }, null, 2)}\n`, 'utf8');
  return { stopped: true, pid: record.pid, message: `PID ${record.pid} を強制停止しました。` };
}

/** 稼働中のGoal Daemon一覧を返します。 */
export async function listRunningDaemons(): Promise<Array<{ goalId: string; pid: number; startedAt: string; logPath: string }>> {
  let goalIds: string[] = []; try { goalIds = await listGoals().then(gs => gs.map(g => g.id)); } catch { return []; }
  const result: Array<{ goalId: string; pid: number; startedAt: string; logPath: string }> = [];
  for (const goalId of goalIds) {
    const rec = await readDaemonRecord(goalId);
    if (!rec || rec.status !== 'running') continue;
    if (!(await isPidAlive(rec.pid))) continue;
    result.push({ goalId, pid: rec.pid, startedAt: rec.startedAt, logPath: rec.logPath });
  }
  return result;
}

/** Daemon稼働状況の文字列を返します。status表示用。 */
export async function formatDaemonStatus(goal: GoalStore): Promise<string> {
  const rec = await readDaemonRecord(goal.id);
  if (!rec) return `[${goal.id}] daemon: 未起動`;
  const alive = await isPidAlive(rec.pid);
  const status = alive ? 'running' : rec.status;
  return [
    `[${goal.id}] daemon: ${status}`,
    `  pid: ${rec.pid}${alive ? '' : ' (死んでいる可能性)'}`,
    `  startedAt: ${rec.startedAt}`,
    `  logPath: ${rec.logPath}`,
    `  auditAgent: ${rec.auditAgent || '(なし)'}`,
  ].join('\n');
}
