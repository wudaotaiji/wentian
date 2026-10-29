import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTaskWorkspace, publishTaskWorkspace } from './task-workspace.js';
import { captureArtifactSnapshot, compareArtifactSnapshots } from './artifact-evidence.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { recoverPublication } from './task-publication.js';

test('実子プロセスが反映途中で強制終了しても、台帳から原本を復旧する', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-publication-crash-'));
  await writeFile(path.join(source, 'a.txt'), '旧A'); await writeFile(path.join(source, 'b.txt'), '旧B');
  const stage = await createTaskWorkspace(source);
  await writeFile(path.join(stage.directory, 'a.txt'), '新A'); await writeFile(path.join(stage.directory, 'b.txt'), '新B');
  const diff = compareArtifactSnapshots(stage.baseline, await captureArtifactSnapshot(stage.directory));
  const moduleUrl = pathToFileURL(path.resolve('src/task-workspace.ts')).href;
  const code = `import {publishTaskWorkspace} from ${JSON.stringify(moduleUrl)}; await publishTaskWorkspace(${JSON.stringify(stage)},${JSON.stringify(diff.changes)},{beforeApply:async index=>{if(index===1)process.exit(9)}});`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), windowsHide: true }), (error: any) => error.code === 9);
  assert.equal(await readFile(path.join(source, 'a.txt'), 'utf8'), '新A');
  assert.equal((await recoverPublication(source)).recovered, true);
  assert.equal(await readFile(path.join(source, 'a.txt'), 'utf8'), '旧A');
  assert.equal(await readFile(path.join(source, 'b.txt'), 'utf8'), '旧B');
});

/** 反映途中の故障を意図的に発生させ、成功と誤報せず原本を復元することを実測します。 */
test('2ファイル目の反映で故障しても1ファイル目を巻き戻し、証拠を保存する', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-publication-'));
  await writeFile(path.join(source, 'a.txt'), '旧A'); await writeFile(path.join(source, 'b.txt'), '旧B');
  const stage = await createTaskWorkspace(source);
  await writeFile(path.join(stage.directory, 'a.txt'), '新A'); await writeFile(path.join(stage.directory, 'b.txt'), '新B');
  const diff = compareArtifactSnapshots(stage.baseline, await captureArtifactSnapshot(stage.directory));
  const result = await publishTaskWorkspace(stage, diff.changes, { beforeApply: async i => { if (i === 1) throw new Error('試験用故障'); } });
  assert.equal(result.status, 'conflict'); assert.equal(result.recoveryRequired, false);
  assert.deepEqual(result.files, []); assert.equal(await readFile(path.join(source, 'a.txt'), 'utf8'), '旧A');
  assert.equal(await readFile(path.join(source, 'b.txt'), 'utf8'), '旧B');
  assert.equal(JSON.parse(await readFile(result.journalPath!, 'utf8')).state, 'rolled_back');
});

test('反映後の人間の変更を巻き戻さず復旧待ちを明示する', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-publication-'));
  await writeFile(path.join(source, 'a.txt'), '旧A'); await writeFile(path.join(source, 'b.txt'), '旧B');
  const stage = await createTaskWorkspace(source);
  await writeFile(path.join(stage.directory, 'a.txt'), '新A'); await writeFile(path.join(stage.directory, 'b.txt'), '新B');
  const diff = compareArtifactSnapshots(stage.baseline, await captureArtifactSnapshot(stage.directory));
  const result = await publishTaskWorkspace(stage, diff.changes, { beforeApply: async i => {
    if (i === 1) { await writeFile(path.join(source, 'a.txt'), '人間の変更'); throw new Error('競合試験'); }
  } });
  assert.equal(result.status, 'conflict'); assert.equal(result.recoveryRequired, true);
  assert.equal(await readFile(path.join(source, 'a.txt'), 'utf8'), '人間の変更');
});
