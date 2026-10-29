import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOrdinaryPath, atomicOrdinaryWrite } from './safe-file.js';
import { createTaskWorkspace, assertTaskPathIncluded } from './task-workspace.js';

export interface SourceVerification { candidateId: string; test: string }

/** 試験コマンドはホスト側で組立て、AIが任意のコマンドを実行できないようにします。 */
export function validateSourceVerification(value: unknown): SourceVerification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('修正候補の検証指定が不正です。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['candidateId', 'test'].includes(key))
    || typeof input.candidateId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.candidateId)
    || typeof input.test !== 'string' || !/^src\/[a-zA-Z0-9_.\/-]+\.test\.ts$/.test(input.test)
    || input.test.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) throw new Error('修正候補の検証指定が不正です。');
  return { candidateId: input.candidateId, test: input.test };
}

interface DockerResult { code: number; output: string }
function docker(args: string[], signal?: AbortSignal, timeoutMs = 180000): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const capture = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      if (timedOut) return reject(new Error('隔離検証の時間制限を超えました。'));
      resolve({ code: code ?? -1, output });
    });
  });
}

/**
 * 独立コピーで基準の失敗と修正後の成功を比べます。
 * npm依存物の取得だけネットワークを利用し、試験と型検査はネットワークなしで実行します。
 * 利用者の環境変数・ホーム・設定・本番データ・Docker Socketはコンテナーへ渡しません。
 * 成功しても候補の反映やDaemon再起動は行いません。
 */
export async function verifyMaintenanceSourceCandidate(input: SourceVerification, stagingRoot: string, signal?: AbortSignal, installRoot?: string): Promise<unknown> {
  const request = validateSourceVerification(input);
  const root = await realpathRoot(installRoot);
  const proposal = path.join(stagingRoot, request.candidateId);
  await assertOrdinaryPath(proposal);
  const manifest = JSON.parse(await readFile(path.join(proposal, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  if (manifest.version !== 1 || manifest.status !== 'unverified' || manifest.candidate !== 'candidate.ts'
    || typeof manifest.source !== 'string' || !/^src\/[a-zA-Z0-9_.\/-]+\.ts$/.test(manifest.source)
    || manifest.source.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))
    || typeof manifest.beforeHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.beforeHash)
    || typeof manifest.afterHash !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.afterHash)) throw new Error('修正候補の台帳が不正です。');
  await assertTaskPathIncluded(root, manifest.source);
  await assertTaskPathIncluded(root, request.test);
  const candidatePath = path.join(proposal, 'candidate.ts'); await assertOrdinaryPath(candidatePath);
  const candidate = await readFile(candidatePath);
  const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  if (digest(candidate) !== manifest.afterHash) throw new Error('修正候補が保存後に変更されました。');
  const workspace = await createTaskWorkspace(root);
  const source = path.join(workspace.directory, manifest.source), testFile = path.join(workspace.directory, request.test);
  await assertOrdinaryPath(source); await assertOrdinaryPath(testFile);
  if (digest(await readFile(source)) !== manifest.beforeHash) throw new Error('修正候補作成後に元のソースが変更されました。');
  const testHash = digest(await readFile(testFile));
  // 利用者固有のnpm設定をコンテナーに持ち込む場合は、依存取得を行いません。
  try { await readFile(path.join(workspace.directory, '.npmrc')); throw new Error('npm設定を含む制作コピーでは自動依存取得できません。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const image = process.env.WENTIAN_MAINTENANCE_TEST_IMAGE || 'node:22-bookworm-slim';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image)) throw new Error('隔離検証イメージの指定が不正です。');
  let inspected = await docker(['image', 'inspect', '--format', '{{.Id}}', image], signal, 15000);
  if (inspected.code !== 0) {
    // 初回だけ設定済みイメージを取得し、以後はローカルの同じイメージを使用します。
    const pulled = await docker(['pull', image], signal, 300000);
    inspected = await docker(['image', 'inspect', '--format', '{{.Id}}', image], signal, 15000);
    if (pulled.code !== 0 || inspected.code !== 0) throw new Error('隔離検証イメージを準備できません。');
  }
  const imageId = inspected.output.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('隔離検証イメージの識別子を確認できません。');
  if (workspace.directory.includes(',') || /[\r\n]/.test(workspace.directory)) throw new Error('隔離検証場所のパスを使用できません。');
  const volume = `wentian-maintenance-${randomUUID()}`;
  const containers: string[] = [];
  const mount = `type=bind,source=${workspace.directory},target=/work`;
  const run = async (network: 'bridge' | 'none', command: string[], timeoutMs = 180000) => {
    const name = `wentian-maintenance-${randomUUID()}`; containers.push(name);
    return docker(['run', '--rm', '--pull', 'never', '--name', name, '--network', network, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '128', '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
      '--mount', mount, '--mount', `type=volume,source=${volume},target=/work/node_modules`, '--workdir', '/work',
      '--env', 'HOME=/tmp', '--env', 'NPM_CONFIG_USERCONFIG=/tmp/wentian-user-npmrc', '--env', 'NPM_CONFIG_GLOBALCONFIG=/tmp/wentian-global-npmrc', imageId, ...command], signal, timeoutMs);
  };
  try {
    const install = await run('bridge', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], 300000);
    if (install.code !== 0) return { status: 'unconfirmed', phase: 'dependencies', exitCode: install.code };
    const testCommand = ['node', '--import', 'tsx', '--import', './src/test-environment.ts', '--test', request.test];
    const baseline = await run('none', testCommand);
    if (baseline.code === 0) return { status: 'unconfirmed', phase: 'baseline', reason: '修正前の試験が成功したため、障害の再現を確認できません。' };
    signal?.throwIfAborted();
    await writeFile(source, candidate);
    const corrected = await run('none', testCommand);
    if (corrected.code !== 0) return { status: 'unconfirmed', phase: 'candidate_test', exitCode: corrected.code };
    const build = await run('none', ['npm', 'run', 'build']);
    if (build.code !== 0) return { status: 'unconfirmed', phase: 'build', exitCode: build.code };
    signal?.throwIfAborted();
    if (digest(await readFile(source)) !== manifest.afterHash || digest(await readFile(testFile)) !== testHash) throw new Error('試験中に候補またはテストが変更されました。');
    const receipt = { version: 1, status: 'candidate_verified', candidateId: request.candidateId, source: manifest.source, beforeHash: manifest.beforeHash,
      afterHash: manifest.afterHash, test: request.test, testHash, imageId, workspace: workspace.directory, installRoot: root, completedAt: new Date().toISOString() };
    await atomicOrdinaryWrite(path.join(proposal, 'verified.json'), JSON.stringify(receipt, null, 2) + '\n');
    return { status: 'candidate_verified', candidateId: request.candidateId, source: manifest.source, test: request.test, imageId, baselineExit: baseline.code, candidateExit: corrected.code, buildExit: build.code, beforeHash: manifest.beforeHash, afterHash: manifest.afterHash, workspace: path.basename(workspace.directory) };
  } finally {
    // 中断時も当機能が作成した名前だけを指定し、コンテナーと依存Volumeを片付けます。
    for (const name of containers) await docker(['rm', '-f', name], undefined, 15000).catch(() => undefined);
    await docker(['volume', 'rm', volume], undefined, 15000).catch(() => undefined);
  }
}

async function realpathRoot(installRoot?: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(installRoot || process.env.WENTIAN_INSTALL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
