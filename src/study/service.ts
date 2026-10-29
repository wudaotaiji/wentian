import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

export const JUPYTER_BASE = '/study/jupyter/';
interface Release { contract: 'wentian-jupyter/1'; release: string; version: string; previous?: Release }
export interface StudyStatus { state: 'not-installed' | 'stopped' | 'starting' | 'running' | 'error'; version?: string; notebooks: string; error?: string; updateAvailable?: boolean }
export interface StudyTarget { port: number; token: string }
export interface StudyModule {
  status(): Promise<StudyStatus>; start(): Promise<StudyStatus>; stop(): Promise<StudyStatus>;
  restart(): Promise<StudyStatus>; target(): StudyTarget | undefined;
}
export function checkedRelease(value: unknown): Release {
  const item = value as Release;
  if (!item || item.contract !== 'wentian-jupyter/1' || !/^\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(item.release) || !/^\d+\.\d+\.\d+$/.test(item.version) || !item.release.startsWith(item.version + '-')) throw new Error('Jupyterモジュールの接続契約または版の形式が不正です。');
  return item;
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// Windowsで親が強制終了された場合も、専用Jupyterだけを自身の認証付きAPIで停止します。
const parentWatcher = `import os, threading, time, urllib.request
def _wentian_parent_alive():
    pid = int(os.environ['WENTIAN_JUPYTER_PARENT'])
    if os.name == 'nt':
        import ctypes
        api = ctypes.windll.kernel32
        api.OpenProcess.restype = ctypes.c_void_p
        api.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        api.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = api.OpenProcess(0x100000, False, pid)
        if not handle: return False
        try: return api.WaitForSingleObject(handle, 0) == 258
        finally: api.CloseHandle(handle)
    try: os.kill(pid, 0); return True
    except OSError: return False
def _wentian_watch():
    while _wentian_parent_alive(): time.sleep(2)
    url = 'http://127.0.0.1:' + os.environ['WENTIAN_JUPYTER_PORT'] + '/study/jupyter/api/shutdown'
    for _ in range(10):
        try:
            request = urllib.request.Request(url, data=b'', method='POST', headers={'Authorization': 'token ' + os.environ['JUPYTER_TOKEN']})
            urllib.request.urlopen(request, timeout=3).close()
            return
        except OSError: time.sleep(1)
    os._exit(0)
threading.Thread(target=_wentian_watch, daemon=True).start()
`;

/** Jupyterの依存とプロセスは内核へロードせず、HTTP契約だけで接続します。 */
export class JupyterStudyService implements StudyModule {
  private child?: ChildProcess;
  private connection?: StudyTarget;
  private runningRelease?: Release;
  private launching?: Promise<StudyStatus>;
  private launchController?: AbortController;
  private error?: string;
  constructor(readonly root: string, readonly notebooks: string, private readonly owner?: string) {}
  private async release(): Promise<Release | undefined> {
    try { return checkedRelease(JSON.parse(await readFile(path.join(this.root, 'active.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  target() { return this.connection; }
  async status(): Promise<StudyStatus> {
    try {
      const selected = await this.release();
      return { state: this.launching ? 'starting' : this.connection ? 'running' : this.error ? 'error' : selected ? 'stopped' : 'not-installed', version: this.runningRelease?.version || selected?.version, notebooks: this.notebooks, ...(this.error ? { error: this.error } : {}), ...(this.connection && selected?.release !== this.runningRelease?.release ? { updateAvailable: true } : {}) };
    } catch { return { state: 'error', notebooks: this.notebooks, error: 'Jupyterの有効版設定を確認してください。' }; }
  }
  async start(): Promise<StudyStatus> {
    if (this.connection) return this.status();
    if (this.launching) return this.launching;
    this.launchController = new AbortController(); this.launching = this.launch();
    try { await this.launching; } finally { this.launching = undefined; this.launchController = undefined; }
    return this.status();
  }
  private async launch(selected?: Release): Promise<StudyStatus> {
    this.error = undefined;
    const release = selected || await this.release();
    if (!release) throw new Error('Jupyterモジュールを先に導入してください。');
    const directory = path.join(this.root, 'releases', release.release), python = path.join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const runtime = path.join(this.root, 'runtime', ...(this.owner ? ['users', this.owner] : []), release.release);
    await Promise.all([mkdir(path.join(runtime,'config'), { recursive: true }), mkdir(this.notebooks, { recursive: true })]);
    await writeFile(path.join(runtime,'config','jupyter_server_config.py'), parentWatcher, { mode:0o600 });
    const listener = createServer();
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const port = (listener.address() as import('node:net').AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const token = randomBytes(32).toString('hex');
    const log = await open(path.join(runtime, 'jupyter.log'), 'a');
    const child = spawn(python, ['-m', 'jupyterlab', '--no-browser', '--ServerApp.ip=127.0.0.1', '--ServerApp.port=' + port, '--ServerApp.port_retries=0', '--ServerApp.base_url=' + JUPYTER_BASE, '--ServerApp.root_dir=' + this.notebooks, '--ServerApp.allow_unauthenticated_access=False', '--ServerApp.log_level=ERROR'], { cwd: this.notebooks, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, JUPYTER_TOKEN: token, JUPYTER_CONFIG_DIR: path.join(runtime, 'config'), JUPYTER_RUNTIME_DIR: runtime, IPYTHONDIR: path.join(runtime, 'ipython'), WENTIAN_JUPYTER_PARENT:String(process.pid),WENTIAN_JUPYTER_PORT:String(port),PYTHONNOUSERSITE: '1', JUPYTER_PLATFORM_DIRS: '1' } });
    await log.close(); this.child = child;
    let failed = false;
    child.once('error', () => { failed = true; this.error = 'Jupyter専用Pythonを起動できません。導入状態を確認してください。'; });
    child.once('exit', () => { failed = true; if (this.child === child) { this.connection = undefined; this.child = undefined; this.runningRelease = undefined; } });
    try {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (this.launchController?.signal.aborted) throw new Error('Jupyterの起動を停止しました。');
        if (failed) throw new Error(this.error || 'Jupyterが起動中に終了しました。専用ログを確認してください。');
        try {
          const response = await fetch(`http://127.0.0.1:${port}${JUPYTER_BASE}api/status`, { headers: { authorization: 'token ' + token }, signal: AbortSignal.timeout(1500), redirect: 'manual' });
          if (response.ok && typeof (await response.json() as { kernels?: unknown }).kernels === 'number') {
            this.connection = { port, token }; this.runningRelease = release;
            return { state: 'running', version: release.version, notebooks: this.notebooks };
          }
        } catch { /* 起動準備中の接続失敗だけを短時間再試行します。 */ }
        await delay(500);
      }
      throw new Error('Jupyterの起動確認が時間切れです。専用ログを確認してください。');
    } catch (error) { this.error = (error as Error).message; await this.terminate(child); throw error; }
  }
  private async terminate(child: ChildProcess) {
    if (child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    else child.kill('SIGTERM');
  }
  async stop(): Promise<StudyStatus> {
    this.launchController?.abort();
    if (this.launching) await this.launching.catch(() => undefined);
    const child = this.child, target = this.connection; this.connection = undefined;
    if (target) {
      await fetch(`http://127.0.0.1:${target.port}${JUPYTER_BASE}api/shutdown`, { method: 'POST', headers: { authorization: 'token ' + target.token }, signal: AbortSignal.timeout(3000) }).catch(() => undefined);
      for (let n = 0; child?.exitCode === null && n < 30; n++) await delay(100);
    }
    if (child) await this.terminate(child);
    this.child = undefined; this.runningRelease = undefined; this.error = undefined;
    return this.status();
  }
  async restart(): Promise<StudyStatus> {
    const old = this.runningRelease; await this.stop();
    try { return await this.start(); }
    catch (error) {
      if (old) { await this.launch(old); this.error = '新版の起動に失敗したため、更新前の版で稼働しています。'; return this.status(); }
      throw error;
    }
  }
}
