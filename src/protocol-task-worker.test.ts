import path from 'node:path';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileTaskService } from './common-task-foundation.js';
import { ProtocolTaskWorker, WorkerTaskService } from './protocol-task-worker.js';
import type { OrchestrationResult } from './external-orchestrator.js';

const roots: string[] = [];
function root(): string { const value = path.join(process.cwd(), '.wentian', 'test-worker', `${Date.now()}-${Math.random().toString(36).slice(2)}`); roots.push(value); return value; }
function result(status: OrchestrationResult['status'] = 'completed'): OrchestrationResult {
  return { taskId: 'external-1', status, selectedAgents: ['goose'], manifestPath: 'manifest.json', reports: [] };
}

test('WorkerTaskServiceは登録タスクを実行し成果物を永続化する', async () => {
  const store = new FileTaskService(root());
  const worker = new ProtocolTaskWorker(store, { execute: async () => result() });
  await worker.start();
  const service = new WorkerTaskService(store, worker);
  const task = await service.submitTask('owner', { prompt: '実行してください' });
  await worker.waitForIdle();
  const completed = await service.getTask('owner', task.taskId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.artifacts[0]?.name, '実行台帳');
  assert.equal((await service.getResult('owner', task.taskId)).verification?.status, 'not_configured');
});

test('ワーカーは再起動時にrunningタスクを復旧する', async () => {
  const store = new FileTaskService(root());
  const task = await store.submitTask('owner', { prompt: '復旧してください' });
  await store.transition('owner', task.taskId, 'running');
  const worker = new ProtocolTaskWorker(store, { execute: async () => result('needs_review') });
  await worker.start(); await worker.waitForIdle();
  assert.equal((await store.getTask('owner', task.taskId)).status, 'input_required');
});

test('中断は実行中のAbortSignalへ伝播しcanceledを維持する', async () => {
  const store = new FileTaskService(root());
  let started!: () => void; const didStart = new Promise<void>(resolve => { started = resolve; });
  const worker = new ProtocolTaskWorker(store, { execute: async (_task, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return result();
  } });
  await worker.start(); const service = new WorkerTaskService(store, worker);
  const task = await service.submitTask('owner', { prompt: '長い処理' });
  await didStart; await service.cancelTask('owner', task.taskId); await worker.waitForIdle();
  assert.equal((await service.getTask('owner', task.taskId)).status, 'canceled');
});

test('Gateway停止時はrunningを保持して次回復旧できる', async () => {
  const store = new FileTaskService(root());
  let started!: () => void; const didStart = new Promise<void>(resolve => { started = resolve; });
  const worker = new ProtocolTaskWorker(store, { execute: async (_task, signal) => {
    started(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); return result();
  } });
  await worker.start(); const service = new WorkerTaskService(store, worker);
  const task = await service.submitTask('owner', { prompt: '再起動を待つ処理' });
  await didStart; await worker.stop();
  assert.equal((await store.getTask('owner', task.taskId)).status, 'running');
});

test('永続ワーカーの一時領域をクリーンアップする', async () => {
  for (const directory of roots) await rm(directory, { recursive: true, force: true });
});
