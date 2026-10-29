import assert from 'node:assert/strict';
import test from 'node:test';
import { browserLaunchCommand, daemonLaunchCommand, formatServerDaemonStatus, parsePort, resolvePort, waitForDaemonStopped } from './cli-runtime.js';

test('CLIポート指定を検証する', () => {
  assert.equal(parsePort(undefined), 8787);
  assert.equal(parsePort('auto'), 'auto');
  assert.equal(parsePort('9000'), 9000);
  assert.throws(() => parsePort('70000'), /1～65535/);
});

test('自動ポート探索で利用可能なポートを返す', async () => {
  const port = await resolvePort('auto', '127.0.0.1');
  assert.ok(port >= 8787 && port <= 8806);
});

test('Daemon起動コマンドをBunとNode.jsで正しく分離する', () => {
  assert.deepEqual(
    daemonLaunchCommand('C:\\runtime\\bun.exe', 'C:\\app\\src\\server.ts', 'C:\\app\\node_modules\\tsx\\dist\\cli.mjs', '1.4.0'),
    { command: 'C:\\runtime\\bun.exe', args: ['C:\\app\\src\\server.ts'] },
  );
  assert.deepEqual(
    daemonLaunchCommand('C:\\runtime\\node.exe', 'C:\\app\\src\\server.ts', 'C:\\app\\node_modules\\tsx\\dist\\cli.mjs'),
    { command: 'C:\\runtime\\node.exe', args: ['--import', 'tsx', 'C:\\app\\src\\server.ts'] },
  );
});

test('Daemon状態は接続URLとHealth URLを常に表示する', () => {
  const output = formatServerDaemonStatus({ pid: 37504, port: 8787, hostname: '127.0.0.1', startedAt: '2026-09-09T02:04:48.205Z', logPath: 'C:\\app\\server.log' }, true);
  assert.match(output, /status: running/);
  assert.match(output, /URL: http:\/\/127\.0\.0\.1:8787\//);
  assert.match(output, /Health: http:\/\/127\.0\.0\.1:8787\/health/);
  assert.match(output, /PID: 37504/);
});

test('Daemon状態はTTY向け指定時だけ意味別ANSIカラーを付ける', () => {
  const record = { pid: 1, port: 8787, hostname: '127.0.0.1', startedAt: 'now', logPath: 'server.log' };
  assert.match(formatServerDaemonStatus(record, true, true), /\x1b\[1;32mrunning\x1b\[0m/);
  assert.doesNotMatch(formatServerDaemonStatus(record, true, false), /\x1b\[/);
});

test('Web画面をOS別の既定ブラウザーで開くコマンドを構成する', () => {
  assert.deepEqual(browserLaunchCommand('http://127.0.0.1:8787', 'win32'), { command: 'explorer.exe', args: ['http://127.0.0.1:8787/'] });
  assert.deepEqual(browserLaunchCommand('http://localhost:8787', 'darwin'), { command: 'open', args: ['http://localhost:8787/'] });
  assert.deepEqual(browserLaunchCommand('http://localhost:8787', 'linux'), { command: 'xdg-open', args: ['http://localhost:8787/'] });
  assert.throws(() => browserLaunchCommand('file:///etc/passwd', 'linux'), /http\/https/);
});

// 実ポート（TCP Port）の解放が遅れても待ち、他プロセスの待受を成功扱いにしません。
test('停止完了はポート解放を待ち、占有継続時は失敗する', async () => {
  const {createServer}=await import('node:net');
  const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as import('node:net').AddressInfo).port;
  const record={pid:2147483647,port,hostname:'127.0.0.1',startedAt:'',logPath:'検証用'};
  try {
    await assert.rejects(waitForDaemonStopped(record,150),/起動記録を保持/);
    const started=Date.now();const closing=setTimeout(()=>server.close(),200);
    try{await waitForDaemonStopped(record,2000);assert.ok(Date.now()-started>=150)}finally{clearTimeout(closing)}
  }finally{if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
