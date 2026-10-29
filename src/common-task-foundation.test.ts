import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileTaskService } from './common-task-foundation.js';

const TEST_ROOT = path.join(process.cwd(), '.wentian', 'test-tasks', `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

test('FileTaskServiceはタスクをファイルへ永続化する', async () => {
  const service = new FileTaskService(TEST_ROOT);
  const task = await service.submitTask('owner-1', { prompt: 'テスト' });
  assert.ok(task.taskId.startsWith('task_'));
  assert.equal(task.status, 'queued');
  assert.ok(Date.parse(task.createdAt) > 0);
});

test('FileTaskServiceはタスクを取得できる', async () => {
  const service = new FileTaskService(TEST_ROOT);
  const task = await service.submitTask('owner-1', { prompt: '取得テスト' });
  const loaded = await service.getTask('owner-1', task.taskId);
  assert.equal(loaded.taskId, task.taskId);
  assert.equal(loaded.ownerId, 'owner-1');
});

test('FileTaskServiceはowner分離を enforcement する', async () => {
  const service = new FileTaskService(TEST_ROOT);
  const task = await service.submitTask('owner-1', { prompt: '権限テスト' });
  await assert.rejects(async () => service.getTask('owner-999', task.taskId), /アクセス権/);
});

test('FileTaskServiceはタスクを中断できる', async () => {
  const service = new FileTaskService(TEST_ROOT);
  const task = await service.submitTask('owner-1', { prompt: '中断テスト' });
  const cancelled = await service.cancelTask('owner-1', task.taskId);
  assert.equal(cancelled.status, 'canceled');
});

test('FileTaskServiceは結果を生成しキャッシュする', async () => {
  const service = new FileTaskService(TEST_ROOT);
  const task = await service.submitTask('owner-1', { prompt: '結果テスト' });
  await service.transition('owner-1', task.taskId, 'running');
  await service.transition('owner-1', task.taskId, 'completed', { artifacts: [{ name: 'manifest', uri: 'manifest.json' }] });
  const result = await service.getResult('owner-1', task.taskId);
  assert.equal(result.taskId, task.taskId);
  assert.ok(Array.isArray(result.artifacts));
  assert.deepEqual(result.artifacts, [{ name: 'manifest', uri: 'manifest.json' }]);
});

test('FileTaskServiceは所有者別一覧と状態遷移を強制する', async () => {
  const service = new FileTaskService(TEST_ROOT);
  const mine = await service.submitTask('owner-list', { prompt: '一覧対象' });
  await service.submitTask('other-owner', { prompt: '一覧対象外' });
  assert.deepEqual((await service.listTasks('owner-list')).map(task => task.taskId), [mine.taskId]);
  await assert.rejects(service.transition('owner-list', mine.taskId, 'completed'), /許可されていません/);
  const running = await service.transition('owner-list', mine.taskId, 'running', { progress: { percent: 10, message: '開始' } });
  assert.equal(running.progress?.percent, 10);
  await assert.rejects(service.transition('other-owner', mine.taskId, 'failed'), /アクセス権/);
});

test('FileTaskServiceはパストラバーサル形式のIDを拒否する', async () => {
  const service = new FileTaskService(TEST_ROOT);
  await assert.rejects(service.getTask('owner-1', '../secret'), /形式が不正/);
});

test('FileTaskServiceは終了後にクリーンアップできる', async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});
