import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { registerParallelWorkflowRoutes } from './parallel-workflow-routes.js';

test('HTTPの固定条件を通過した成果だけを反映し、非管理者と自由コマンドを拒否する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-workflow-http-')); const workspace = path.join(root, 'source'); await mkdir(workspace);
  const app = Fastify();
  registerParallelWorkflowRoutes(app, { root: path.join(root, 'state'), workspace, authorize: req => req.headers['x-test-admin'] === 'yes', executor: async context => { await writeFile(path.join(context.directory, 'result.txt'), '固定合格条件'); } });
  const headers = { 'x-test-admin': 'yes' };
  assert.equal((await app.inject({ url: '/api/workbench/workflows' })).statusCode, 403);
  const created = await app.inject({ method: 'POST', url: '/api/workbench/workflows', headers, payload: { nodes: [{ id: 'a', dependencies: [], inputs: [], allowedWritePaths: ['result.txt'], acceptance: '成果を生成', sideEffect: false }], acceptanceChecks: [{ path: 'result.txt', contains: '固定合格条件' }] } });
  assert.equal(created.statusCode, 201, created.body); const id = created.json().id;
  assert.equal((await app.inject({ method: 'POST', url: `/api/workbench/workflows/${id}/run`, headers, payload: { command: '任意コマンド' } })).statusCode, 400);
  const result = await app.inject({ method: 'POST', url: `/api/workbench/workflows/${id}/run`, headers });
  assert.equal(result.json().status, 'completed', result.body);
  assert.equal(await readFile(path.join(workspace, 'result.txt'), 'utf8'), '固定合格条件');
  assert.equal((await app.inject({ method: 'POST', url: `/api/workbench/workflows/${id}/run`, headers })).statusCode, 409);
  await app.close();
});
