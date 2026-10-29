import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTaskWorkspace } from './task-workspace.js';

// 実Daemonの再起動を伴うため、一時複製と専用ポートで明示実行するときだけ動かします。
test('独立監督が一時Daemonを再起動し、検証済み候補を反映する', { skip: !process.env.WENTIAN_TEST_DEPLOYMENT, timeout: 180000 }, async () => {
  const workspace = await createTaskWorkspace(process.cwd());
  const root = workspace.directory, candidateWorkspace = await mkdtemp(path.join(os.tmpdir(), 'wentian-task-'));
  const id = '00000000-0000-4000-8000-000000000001', agent = 'opencode', source = 'src/agent-native-models.ts', testPath = 'src/fixture.test.ts';
  const reports = path.join(root, '.wentian', 'ai'), proposal = path.join(reports, 'proposals', agent, id);
  await mkdir(path.join(candidateWorkspace, 'src'), { recursive: true }); await mkdir(proposal, { recursive: true });
  await symlink(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, source), 'export const fixture = 1;\n');
  await writeFile(path.join(root, testPath), '// 一時Daemonの検証用ファイルです。\n');
  await writeFile(path.join(candidateWorkspace, source), 'export const fixture = 2;\n');
  await writeFile(path.join(candidateWorkspace, testPath), '// 一時Daemonの検証用ファイルです。\n');
  // このHTTPサーバーは外部へ接続せず、専用ポート上の配備起動とHealthだけを提供します。
  await writeFile(path.join(root, 'src', 'server.ts'), `import { createServer } from 'node:http';
import path from 'node:path';
import { launchMaintenanceSourceDeployment } from './maintenance-source-deployment-launch.js';
const staging = path.join(process.env.WENTIAN_AI_MAINTENANCE_ROOT!, 'proposals', '${agent}');
createServer(async (req,res) => {
  if (req.url === '/health') { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ok:true})); return; }
  if (req.url === '/trigger') { try { await launchMaintenanceSourceDeployment({candidateId:'${id}'},staging,'${agent}'); res.end('started'); } catch { res.statusCode=500;res.end('failed'); } return; }
  res.statusCode=404;res.end();
}).listen(Number(process.env.PORT),'127.0.0.1');\n`);
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root, windowsHide: true });
  await git(['add', '--', source, testPath, 'src/server.ts']);
  await git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, '.git', 'disabled-hooks')}`, 'commit', '-m', 'fixture daemon']);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  await writeFile(path.join(proposal, 'verified.json'), JSON.stringify({ version: 1, status: 'candidate_verified', candidateId: id, source,
    beforeHash: hash('export const fixture = 1;\n'), afterHash: hash('export const fixture = 2;\n'), test: testPath,
    testHash: hash('// 一時Daemonの検証用ファイルです。\n'), workspace: candidateWorkspace, installRoot: root }));
  const port = await new Promise<number>((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('一時ポートを取得できません。')); const value = address.port; server.close(() => resolve(value)); }); });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
    TEMP: os.tmpdir(), TMP: os.tmpdir(), HOME: root, USERPROFILE: root, LOCALAPPDATA: root,
    WENTIAN_CONFIG_DIR: path.join(root, '.wentian', 'config'), WENTIAN_INSTALL_ROOT: root, WENTIAN_AI_MAINTENANCE_ROOT: reports,
    WENTIAN_DEFAULT_MAINTENANCE_ACCESS: 'true', WENTIAN_AGENT_MAINTENANCE_ENABLED: 'true' };
  // 実運用と同じBun起動も選べます。Node版と同じ隔離Fixtureを使用します。
  const bun = process.env.WENTIAN_TEST_DEPLOYMENT_BUN === 'true';
  const executable = bun ? path.join(process.cwd(), 'node_modules', 'bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : process.execPath;
  const node = async (code: string) => promisify(execFile)(executable, bun ? ['-e', code] : ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: root, env, windowsHide: true, timeout: 80000 });
  try {
    await node(`import { startDaemon } from './src/cli-runtime.ts'; await startDaemon(${port},'127.0.0.1');`);
    const before = JSON.parse(await readFile(path.join(root, '.wentian', 'runtime', 'server.json'), 'utf8')) as { pid: number };
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/trigger`)).text(), 'started');
    let result: any;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { result = JSON.parse(await readFile(path.join(proposal, 'deployment.json'), 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    assert.equal(result?.status, 'deployed_pending_agent_verification', JSON.stringify(result));
    let deploymentStatus: any;
    for (let attempt = 0; attempt < 15; attempt++) {
      try { deploymentStatus = JSON.parse(await readFile(path.join(reports, 'deployment-status', 'current.json'), 'utf8')); if (deploymentStatus.status === 'deployed') break; } catch { /* 状態の保存を待ちます。 */ }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(deploymentStatus?.status, 'deployed');
    const after = JSON.parse(await readFile(path.join(root, '.wentian', 'runtime', 'server.json'), 'utf8')) as { pid: number };
    assert.notEqual(after.pid, before.pid); assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any).ok, true);
    assert.equal(await readFile(path.join(root, source), 'utf8'), 'export const fixture = 2;\n');
  } finally {
    // 一時複製の台帳だけを読んで、その専用Daemonを停止します。
    await node("import { readDaemonRecord, stopDaemon } from './src/cli-runtime.ts'; if (await readDaemonRecord()) await stopDaemon();").catch(() => undefined);
  }
});
