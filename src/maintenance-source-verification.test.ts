import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { stageMaintenanceSourceEdit } from './maintenance-source-inspection.js';
import { validateSourceVerification, verifyMaintenanceSourceCandidate } from './maintenance-source-verification.js';

test('隔離試験では候補IDと既存テストのパスだけを受け付ける', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(validateSourceVerification({ candidateId: id, test: 'src/example.test.ts' }), { candidateId: id, test: 'src/example.test.ts' });
  for (const input of [{ candidateId: id, test: 'src/../../secret.test.ts' }, { candidateId: id, test: 'src/a.ts' }, { candidateId: id, test: 'src/a.test.ts', command: 'anything' }, { candidateId: '../other', test: 'src/a.test.ts' }]) {
    assert.throws(() => validateSourceVerification(input));
  }
});

// 実Container試験は明示実行時だけ実施し、通常の全試験では外部のRegistryへ接続しません。
test('隔離Containerで修正前の失敗と修正後の成功を確認し、原本は変更しない', { skip: !process.env.WENTIAN_TEST_CONTAINER, timeout: 360000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-container-fixture-'));
  const source = path.join(root, 'src'); await mkdir(source);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'wentian-test-fixture', version: '1.0.0', type: 'module', scripts: { build: 'node -e "process.exit(0)"' }, devDependencies: { tsx: '4.20.6' } }));
  await writeFile(path.join(source, 'example.ts'), 'export const value = 1;\n');
  await writeFile(path.join(source, 'test-environment.ts'), '// 試験専用の空環境です。\n');
  await writeFile(path.join(source, 'example.test.ts'), `import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from './example.js';
test('network', async () => { await assert.rejects(fetch('https://example.com', { signal: AbortSignal.timeout(5000) })); });
test('value', () => { assert.equal(value, 2); });\n`);
  // Lockfileの準備は一時Fixtureに限り、利用者のnpm設定・実際のProjectを変更しません。
  await promisify(execFile)('docker', ['run', '--rm', '--pull', 'never', '--mount', `type=bind,source=${root},target=/work`, '--workdir', '/work', '--env', 'HOME=/tmp',
    'node:22-bookworm-slim', 'npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: root, windowsHide: true, timeout: 120000 });
  const proposals = path.join(root, 'proposals');
  const candidate = await stageMaintenanceSourceEdit({ path: 'src/example.ts', expected: 'value = 1', replacement: 'value = 2' }, proposals, undefined, root) as { candidateId: string };
  const result = await verifyMaintenanceSourceCandidate({ candidateId: candidate.candidateId, test: 'src/example.test.ts' }, proposals, undefined, root) as { status: string; phase?: string };
  assert.deepEqual({ status: result.status, phase: result.phase }, { status: 'candidate_verified', phase: undefined });
  assert.equal(await readFile(path.join(source, 'example.ts'), 'utf8'), 'export const value = 1;\n');
});
