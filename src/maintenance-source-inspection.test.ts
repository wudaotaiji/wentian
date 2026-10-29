import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectMaintenanceSource, stageMaintenanceSourceEdit, validateSourceInspection } from './maintenance-source-inspection.js';

test('AIが選択した検索語と行番号で製品ソースを調査し、設定と範囲外を読まない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-source-inspection-'));
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'src', 'example.ts'), 'first\nunknown XYZ\nlast\n');
  await writeFile(path.join(root, '.env'), 'secret XYZ');
  const search = await inspectMaintenanceSource({ operation: 'search', query: 'XYZ' }, undefined, root) as any;
  assert.deepEqual(search.matches, [{ path: 'src/example.ts', line: 2, text: 'unknown XYZ' }]);
  const read = await inspectMaintenanceSource({ operation: 'read', path: 'src/example.ts', startLine: 2 }, undefined, root) as any;
  assert.equal(read.lines[0].text, 'unknown XYZ'); assert.equal(read.lines[0].line, 2);
  for (const name of ['../.env', 'src/../.env', 'src/.secret.ts', 'src/example.ts/../../.env']) {
    assert.throws(() => validateSourceInspection({ operation: 'read', path: name }));
  }
  assert.throws(() => validateSourceInspection({ operation: 'search', query: 'x', command: 'anything' }));
});

test('中断済みの調査を開始しない', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectMaintenanceSource({ operation: 'search', query: 'x' }, controller.signal));
});

test('修正候補は元ファイルを変更せず一意に照合して専用領域へ保存する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-source-edit-'));
  await mkdir(path.join(root, 'src')); const source = path.join(root, 'src', 'example.ts');
  await writeFile(source, 'const value = 1;\n');
  const staging = path.join(root, 'candidates');
  const result = await stageMaintenanceSourceEdit({ path: 'src/example.ts', expected: 'value = 1', replacement: 'value = 2' }, staging, undefined, root) as any;
  assert.equal(result.status, 'unverified'); assert.notEqual(result.beforeHash, result.afterHash);
  assert.equal(await readFile(source, 'utf8'), 'const value = 1;\n');
  assert.equal(await readFile(path.join(staging, result.candidateId, 'candidate.ts'), 'utf8'), 'const value = 2;\n');
  await assert.rejects(stageMaintenanceSourceEdit({ path: 'src/example.ts', expected: 'absent', replacement: 'new' }, staging, undefined, root));
  await writeFile(source, 'same same');
  await assert.rejects(stageMaintenanceSourceEdit({ path: 'src/example.ts', expected: 'same', replacement: 'new' }, staging, undefined, root));
});
