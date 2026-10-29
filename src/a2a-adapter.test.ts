import test from 'node:test';
import assert from 'node:assert/strict';
import { A2ATaskAdapter } from './a2a-adapter.js';
import { FileTaskService } from './common-task-foundation.js';

test('A2AのAgent Cardが取得できる', async () => {
  const service = new FileTaskService('.wentian/test-tasks/a2a-agent-card');
  const adapter = new A2ATaskAdapter(service);
  const card = adapter.agentCard();
  assert.equal(card.name, 'wentian-gateway');
  assert.ok(Array.isArray(card.capabilities.task_types));
});

test('A2Aでタスクを作成できる', async () => {
  const service = new FileTaskService('.wentian/test-tasks/a2a-create');
  const adapter = new A2ATaskAdapter(service);
  const task = await adapter.createTask('owner-1', { prompt: 'A2Aテスト' });
  assert.ok(task.taskId.startsWith('task_'));
  assert.equal(task.status, 'queued');
});

test('A2Aでタスクを取得できる', async () => {
  const service = new FileTaskService('.wentian/test-tasks/a2a-get');
  const adapter = new A2ATaskAdapter(service);
  const created = await adapter.createTask('owner-1', { prompt: '取得テスト' });
  const task = await adapter.getTask('owner-1', created.taskId);
  assert.equal(task.taskId, created.taskId);
});

test('A2Aでタスクを中断できる', async () => {
  const service = new FileTaskService('.wentian/test-tasks/a2a-cancel');
  const adapter = new A2ATaskAdapter(service);
  const created = await adapter.createTask('owner-1', { prompt: '中断テスト' });
  const task = await adapter.cancelTask('owner-1', created.taskId);
  assert.equal(task.status, 'canceled');
});

test('A2Aで結果を取得できる', async () => {
  const service = new FileTaskService('.wentian/test-tasks/a2a-result');
  const adapter = new A2ATaskAdapter(service);
  const created = await adapter.createTask('owner-1', { prompt: '結果テスト' });
  const result = await adapter.getResult('owner-1', created.taskId);
  assert.equal(result.taskId, created.taskId);
});
