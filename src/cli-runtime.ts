import { createServer } from 'node:net';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface DaemonRecord { pid: number; port: number; hostname: string; startedAt: string; logPath: string; }
const installRoot = path.resolve(process.env.WENTIAN_INSTALL_ROOT || process.cwd());
export const runtimeDirectory = path.join(installRoot, '.wentian', 'runtime');
export const daemonRecordPath = path.join(runtimeDirectory, 'server.json');

/** Daemon状態を人間向けに整形し、接続URLが将来の変更で欠落しない表示契約を提供します。 */
export function formatServerDaemonStatus(record: DaemonRecord | undefined, running: boolean, color = false): string {
  if (!record) return color ? '\x1b[1;36mWentian Gateway Daemon\x1b[0m\n  status: \x1b[31mstopped\x1b[0m\n  URL: \x1b[90m未起動\x1b[0m' : 'Wentian Gateway Daemon\n  status: stopped\n  URL: 未起動';
  const host = record.hostname.includes(':') && !record.hostname.startsWith('[') ? `[${record.hostname}]` : record.hostname;
  const url = `http://${host}:${record.port}/`;
  if (!color) return ['Wentian Gateway Daemon', `  status: ${running ? 'running' : 'stopped'}`, `  URL: ${url}`, `  Health: ${url}health`, `  PID: ${record.pid}`, `  startedAt: ${record.startedAt}`, `  log: ${record.logPath}`].join('\n');
  const stateColor = running ? 32 : 31;
  return [`\x1b[1;36mWentian Gateway Daemon\x1b[0m`, `  status: \x1b[1;${stateColor}m${running ? 'running' : 'stopped'}\x1b[0m`, `  URL: \x1b[4;36m${url}\x1b[0m`, `  Health: \x1b[4;36m${url}health\x1b[0m`, `  PID: \x1b[33m${record.pid}\x1b[0m`, `  startedAt: \x1b[90m${record.startedAt}\x1b[0m`, `  log: \x1b[90m${record.logPath}\x1b[0m`].join('\n');
}

export function parsePort(value: string | undefined): number | 'auto' {
  if (!value || value === 'auto') return value === 'auto' ? 'auto' : 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ポートは1～65535またはautoで指定してください。');
  return port;
}

/** 一時的なTCPサーバーを開き、指定ポートが利用可能かを確認します。 */
export function portAvailable(port: number, hostname: string): Promise<boolean> {
  return new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false)); server.listen(port, hostname, () => server.close(() => resolve(true))); });
}

export async function resolvePort(requested: number | 'auto', hostname: string): Promise<number> {
  if (requested !== 'auto') return requested;
  for (let port = 8787; port <= 8806; port++) if (await portAvailable(port, hostname)) return port;
  throw new Error('自動探索範囲8787～8806に空きポートがありません。');
}

export async function readDaemonRecord(): Promise<DaemonRecord | undefined> {
  try { return JSON.parse(await readFile(daemonRecordPath, 'utf8')) as DaemonRecord; } catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

export function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** OS別に既定ブラウザーを開くコマンドを構成します。URLはWentian自身が生成したHTTP URLだけを渡します。 */
export function browserLaunchCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Web画面はhttp/https URLだけを開けます。');
  if (platform === 'win32') return { command: 'explorer.exe', args: [parsed.href] };
  if (platform === 'darwin') return { command: 'open', args: [parsed.href] };
  return { command: 'xdg-open', args: [parsed.href] };
}

/** 既定ブラウザーを非同期で開き、Webサーバーのライフサイクルから切り離します。 */
export function openWebBrowser(url: string): void {
  const launch = browserLaunchCommand(url);
  const child = spawn(launch.command, launch.args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.once('error', error => console.warn(`ブラウザーを自動起動できませんでした。URLを手動で開いてください: ${url}\n${error.message}`));
  child.unref();
}

/**
 * 実行中のRuntime（ランタイム / Runtime）に合わせてDaemonの起動コマンドを構成します。
 * Wentian CLIはWindowsでBunから起動されるため、BunにはTypeScriptのサーバー入口を直接渡します。
 * Node.jsで実行される環境だけ、tsx CLIを介してTypeScriptを読み込みます。
 */
export function daemonLaunchCommand(executable: string, serverEntry: string, tsxCli: string, bunVersion?: string): { command: string; args: string[] } {
  return bunVersion
    ? { command: executable, args: [serverEntry] }
    // tsx CLIはWindowsで子プロセスを生成するため、台帳PIDとListener PIDがずれます。
    // Node.jsのimport hookなら同一プロセスでTypeScriptを実行でき、停止・状態確認が正確になります。
    : { command: executable, args: ['--import', 'tsx', serverEntry] };
}

/** Daemonが実際にTCP待受を開始するまで確認し、即時終了を起動成功として扱わないようにします。 */
async function waitForDaemonReady(pid: number, port: number, hostname: string, logPath: string): Promise<void> {
  // Provider探索を含む初期化が低速な環境でも誤って失敗扱いにしないよう、最大60秒待機します。
  for (let attempt = 0; attempt < 600; attempt++) {
    if (!(await portAvailable(port, hostname))) return;
    if (!processAlive(pid)) throw new Error(`Wentian daemonが起動直後に終了しました。ログを確認してください: ${logPath}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Wentian daemonの待受開始を確認できませんでした: http://${hostname}:${port}/ （ログ: ${logPath}）`);
}

/** Gatewayを現在の端末から切り離し、PID・ポート・ログを台帳へ保存します。 */
export async function startDaemon(port: number, hostname: string): Promise<DaemonRecord> {
  const existing = await readDaemonRecord();
  if (existing && processAlive(existing.pid)) throw new Error(`Wentian daemonは既に起動しています（PID ${existing.pid}）。`);
  // 停止済みの台帳が残っていても、別プロセスが同じポートを使用している場合は起動しません。
  // 他プロセスのListener（リスナー / Listener）をDaemon自身の起動成功と誤認することを防ぎます。
  if (!(await portAvailable(port, hostname))) throw new Error(`ポート${port}は別のプロセスが使用しています。--port autoまたは別のポートを指定してください。`);
  await mkdir(runtimeDirectory, { recursive: true });
  const logPath = path.join(runtimeDirectory, 'server.log');
  const log = await open(logPath, 'a');
  const tsxCli = path.join(installRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const serverEntry = path.join(installRoot, 'src', 'server.ts');
  const bunVersion = (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
  const launch = daemonLaunchCommand(process.execPath, serverEntry, tsxCli, bunVersion);
  const child = spawn(launch.command, launch.args, { cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PORT: String(port), WENTIAN_HOST: hostname } });
  child.unref(); await log.close();
  if (!child.pid) throw new Error('Daemonプロセスを起動できませんでした。');
  await waitForDaemonReady(child.pid, port, hostname, logPath);
  const record = { pid: child.pid, port, hostname, startedAt: new Date().toISOString(), logPath };
  await writeFile(daemonRecordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/** 停止完了（Shutdown Completion）を待ち、再起動時のポート解放待ち競合を防ぎます。 */
export async function waitForDaemonStopped(record: DaemonRecord, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    // プロセス終了とポート解放の両方を確認し、停止要求だけでは成功扱いにしません。
    if (!processAlive(record.pid) && await portAvailable(record.port, record.hostname)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Wentian daemonの停止またはポート${record.port}の解放を確認できません。起動記録を保持しました。PID ${record.pid}、ログ: ${record.logPath}`);
}

export async function stopDaemon(): Promise<DaemonRecord> {
  const record = await readDaemonRecord();
  if (!record) throw new Error('Wentian daemonの起動記録がありません。');
  if (processAlive(record.pid)) {
    try { process.kill(record.pid, 'SIGTERM'); } catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  await waitForDaemonStopped(record);
  await unlink(daemonRecordPath).catch(() => undefined);
  return record;
}
