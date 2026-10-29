import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Timing = { at: string } | { everyMs: number } | { daily: string; timezone: string };
export interface ScheduledTask {
  id: string; prompt: string; workspace: string; server: string; model: string;
  timing: Timing; enabled: boolean; nextRunAt: string; createdAt: string;
  running?: { pid: number; startedAt: string };
  lastRun?: { startedAt: string; finishedAt: string; status: 'completed' | 'failed' | 'interrupted'; error?: string; logPath?: string };
}
export interface ScheduleInput { prompt: string; timing: Timing; workspace?: string; server?: string; model?: string }
export type ScheduleRunner = (task: ScheduledTask) => Promise<{ logPath?: string }>;

/** ローカルの予約を永続化します。環境変数で共有先を固定することもできます。 */
export function scheduleRoot(): string { return path.resolve(process.env.WENTIAN_SCHEDULE_ROOT || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian/schedules')); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } }

/** Windowsの一時的なアクセス競合だけを限定再試行します。恒久的な権限エラーは最後に呼び出し元へ返します。 */
export async function retryScheduleLock<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(String((error as NodeJS.ErrnoException).code)) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}

/** 毎日指定時刻を、IANAタイムゾーン（Time Zone）の現地時刻で検索します。夏時間にも対応します。 */
export function nextDaily(time: string, timezone: string, after: number, followingDay = false): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('毎日の時刻は HH:mm 形式で指定してください。');
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const currentDate = dateFormatter.format(new Date(after));
  const start = Math.floor(after / 60000) * 60000 + 60000;
  for (let value = start; value < start + 49 * 3600000; value += 60000) {
    // 夏時間終了で同じ時刻が2回現れても、毎日予約は現地日付ごとに1回だけ実行します。
    if (formatter.format(new Date(value)) === time && (!followingDay || dateFormatter.format(new Date(value)) !== currentDate)) return value;
  }
  throw new Error('次回実行時刻を計算できません。');
}

/** 日時はUTCオフセット付きに限定し、端末ごとの時差による誤実行を防ぎます。 */
function firstRun(timing: Timing, now: number): number {
  if ('at' in timing) {
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(timing.at) || !Number.isFinite(Date.parse(timing.at)) || Date.parse(timing.at) <= now) throw new Error('未来の日時をタイムゾーン付きISO形式で指定してください。');
    return Date.parse(timing.at);
  }
  if ('everyMs' in timing) {
    if (!Number.isSafeInteger(timing.everyMs) || timing.everyMs < 1000) throw new Error('実行間隔は1秒以上の整数ミリ秒で指定してください。');
    const value = now + timing.everyMs;
    if (!Number.isFinite(new Date(value).getTime())) throw new Error('実行間隔が大きすぎます。');
    return value;
  }
  return nextDaily(timing.daily, timing.timezone, now);
}

export class TaskScheduler {
  constructor(readonly root = scheduleRoot(), readonly runner: ScheduleRunner = runScheduledAgent) {}
  private async read(): Promise<ScheduledTask[]> {
    try { return JSON.parse(await readFile(path.join(this.root, 'tasks.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  /** 排他ロック（Lock）と原子的な置換で、CLIと複数Gatewayの同時更新を直列化します。 */
  private async change<T>(fn: (tasks: ScheduledTask[]) => T): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const lock = path.join(this.root, 'store.lock');
    let handle;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { handle = await retryScheduleLock(() => open(lock, 'wx')); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const owner = Number(await readFile(lock, 'utf8').catch(() => ''));
        // 強制終了後のロックだけ回収します。空の作成途中ロックは回収しません。
        if (owner > 0 && !alive(owner)) await unlink(lock).catch(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (!handle) throw new Error('予約ストアが使用中です。再実行してください。');
    const temp = path.join(this.root, `${randomUUID()}.tmp`);
    try {
      // 所有者PIDの書き込み失敗時にも、取得済みハンドルとロックを必ず解放します。
      await handle.writeFile(String(process.pid));
      const tasks = await this.read(); const result = fn(tasks);
      const output = await open(temp, 'wx');
      try { await output.writeFile(JSON.stringify(tasks, null, 2)); await output.sync(); } finally { await output.close(); }
      // Windowsの一時ファイルロック（File Lock）を限定再試行し、予約台帳を原子的に更新する。
      await renameWithRetry(temp, path.join(this.root, 'tasks.json')); return result;
    } finally {
      await unlink(temp).catch(() => undefined);
      await handle.close();
      // 他ワーカーの読み取りやウイルス対策ソフトによる一時的な削除拒否を吸収します。
      await retryScheduleLock(() => unlink(lock));
    }
  }
  async list(): Promise<ScheduledTask[]> { return this.read(); }
  async add(input: ScheduleInput, now = Date.now()): Promise<ScheduledTask> {
    if (!input.prompt?.trim()) throw new Error('実行する依頼文を指定してください。');
    const task: ScheduledTask = { id: randomUUID(), prompt: input.prompt.trim(), timing: input.timing,
      workspace: path.resolve(input.workspace || process.cwd()), server: input.server || 'http://127.0.0.1:8787', model: input.model || 'wentian-auto/local',
      enabled: true, nextRunAt: new Date(firstRun(input.timing, now)).toISOString(), createdAt: new Date(now).toISOString() };
    return this.change(tasks => { tasks.push(task); return task; });
  }
  async manage(id: string, action: 'pause' | 'resume' | 'remove', now = Date.now()): Promise<void> {
    await this.change(tasks => {
      const task = tasks.find(item => item.id === id); if (!task) throw new Error('予約IDが見つかりません。');
      if (action === 'remove') { if (task.running && alive(task.running.pid)) throw new Error('実行中の予約は削除できません。'); tasks.splice(tasks.indexOf(task), 1); }
      else { task.enabled = action === 'resume'; if (task.enabled) task.nextRunAt = new Date(firstRun(task.timing, now)).toISOString(); }
    });
  }
  /** 実行前に次回時刻を保存します。停止中の取りこぼしは1回に集約し、同一予約の重複実行を防ぎます。 */
  async tick(now = Date.now()): Promise<void> {
    for (const candidate of await this.list()) {
      const task = await this.change(tasks => {
        const item = tasks.find(row => row.id === candidate.id); if (!item) return;
        if (item.running) {
          if (alive(item.running.pid)) return;
          item.lastRun = { startedAt: item.running.startedAt, finishedAt: new Date(now).toISOString(), status: 'interrupted', error: '前回の実行プロセスが終了しました。自動再試行はしません。' };
          delete item.running;
        }
        if (!item.enabled || Date.parse(item.nextRunAt) > now) return;
        item.running = { pid: process.pid, startedAt: new Date(now).toISOString() };
        if ('at' in item.timing) item.enabled = false;
        else if ('daily' in item.timing) item.nextRunAt = new Date(nextDaily(item.timing.daily, item.timing.timezone, now, true)).toISOString();
        else {
          const previous = Date.parse(item.nextRunAt);
          item.nextRunAt = new Date(previous + (Math.floor((now - previous) / item.timing.everyMs) + 1) * item.timing.everyMs).toISOString();
        }
        return structuredClone(item);
      });
      if (!task) continue;
      let result: ScheduledTask['lastRun'];
      try { const output = await this.runner(task); result = { startedAt: task.running!.startedAt, finishedAt: new Date().toISOString(), status: 'completed', ...output }; }
      catch (error) { result = { startedAt: task.running!.startedAt, finishedAt: new Date().toISOString(), status: 'failed', error: String(error) }; }
      await this.change(tasks => { const item = tasks.find(row => row.id === task.id); if (item) { delete item.running; item.lastRun = result; } });
    }
  }
}

/** 既存のAgent CLIをシェル（Shell）なしで起動し、予約ごとにログを残します。 */
export async function runScheduledAgent(task: ScheduledTask): Promise<{ logPath: string }> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const logDir = path.join(scheduleRoot(), 'logs'); await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${task.id}-${Date.now()}.log`); const log = await open(logPath, 'a');
  const runtimeArgs = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ? [] : ['--import', pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href];
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [...runtimeArgs, path.join(root, 'src/cli.ts'), 'agent', '--server', task.server, '--model', task.model, '--', task.prompt],
        { cwd: task.workspace, windowsHide: true, stdio: ['ignore', log.fd, log.fd], timeout: 30 * 60000 });
      child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`予約実行が失敗しました: code=${code} signal=${signal} ログ=${logPath}`)));
    }); return { logPath };
  } finally { await log.close(); }
}

/** Gatewayの稼働中だけ予約を処理します。終了時は実行中の処理完了を待ちます。 */
export function startTaskScheduler(onError: (error: unknown) => void): { stop: () => Promise<void> } {
  const scheduler = new TaskScheduler(); let pending: Promise<void> | undefined;
  const tick = () => { if (!pending) pending = scheduler.tick().catch(onError).finally(() => { pending = undefined; }); };
  const timer = setInterval(tick, 1000); timer.unref(); tick();
  return { stop: async () => { clearInterval(timer); await pending; } };
}
