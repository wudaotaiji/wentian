import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, link } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeMaintenance } from './runtime-maintenance.js';

const id = 'goal-2026-10-04-fixture';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-maintenance-'));
  const name = `${id}.json`;
  const content = JSON.stringify({ version: '1.0', id, todos: [], blocked: [], metrics: {}, stop: {} });
  await writeFile(path.join(root, name), content);
  return { root, name, content, service: new RuntimeMaintenance({ stateRoot: root }) };
}
test('復元は停止明示と変更検知を要求し、復元前の内容を退避する', async () => {
  const { root, name, content, service } = await fixture();
  const backup = await service.createBackup();
  assert.equal((await service.inspectBackup(backup.backupId)).passed, true);
  await assert.rejects(service.restoreBackup(backup.backupId), /runtimeStopped/);
  await writeFile(path.join(root, name), content.replace('"todos":[]', '"todos":[{"id":"t1"}]'));
  await assert.rejects(service.restoreBackup(backup.backupId, { runtimeStopped: true }), /変化/);
  const result = await service.restoreBackup(backup.backupId, { runtimeStopped: true, overwriteDrifted: true });
  assert.equal(await readFile(path.join(root, name), 'utf8'), content);
  assert.match(await readFile(path.join(result.preRestoreDir, name), 'utf8'), /t1/);
});
test('バックアップ破損は適用前に拒否し、実状態を変更しない', async () => {
  const { root, name, content, service } = await fixture(); const backup = await service.createBackup();
  await writeFile(path.join(root, '.maintenance', 'backups', backup.backupId, name), '破損');
  await assert.rejects(service.restoreBackup(backup.backupId, { runtimeStopped: true }), /破損/);
  assert.equal(await readFile(path.join(root, name), 'utf8'), content);
});
test('稼働中・状態不明のトランザクションは復元を拒否する', async () => {
  const { root, service } = await fixture(); const backup = await service.createBackup();
  const directory = path.join(root, id, 'tx'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 't1.json'), JSON.stringify({ phase: 'running', pid: process.pid }));
  await assert.rejects(service.restoreBackup(backup.backupId, { runtimeStopped: true }), /稼働中/);
  await writeFile(path.join(directory, 't1.json'), '壊れたJSON');
  await assert.rejects(service.restoreBackup(backup.backupId, { runtimeStopped: true }), /確認できない/);
});
test('ハードリンク（Hard Link）の状態ファイルは拒否する', async () => {
  const { root, name, service } = await fixture(); await link(path.join(root, name), path.join(root, 'outside-copy'));
  await assert.rejects(service.createBackup(), /バックアップ全件取得に失敗|稼働中または状態不明/);
});
