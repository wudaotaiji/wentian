import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerWorkbench } from './workbench.js';
import { createGoal, loadGoal, saveGoal } from './goal-store.js';

test('工作台API: 認証、作成、起動、修正、再検証、Skills、モデル確認', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-workbench-'));
  const previous = process.env.WENTIAN_GOAL_PATH; process.env.WENTIAN_GOAL_PATH = path.join(root, 'goals');
  const app = Fastify(); let starts = 0;
  registerWorkbench(app, { workspace: root, authorize: (req, reply) => {
    if (req.headers.authorization === 'Bearer test') return true;
    reply.code(401).send({ error: { message: 'login required' } }); return false;
  }, models: async () => [{ id: 'mock/model' }], providerSaved: () => {}, testModel: async () => 'Wentian ready',
    start: async input => { starts++; assert.equal(input.cwd, root); return { pid: 123, logPath: '', daemonPath: '', alreadyRunning: false }; },
  });
  const headers = { authorization: 'Bearer test' };
  try {
    assert.equal((await app.inject('/api/workbench')).statusCode, 401);
    assert.equal((await app.inject('/workbench')).statusCode, 200);
    const denied = await app.inject({ method: 'POST', url: '/api/workbench/goals', headers: { ...headers, origin: 'https://evil.example' }, payload: {} });
    assert.equal(denied.statusCode, 403);
    const create = await app.inject({ method: 'POST', url: '/api/workbench/goals', headers, payload: { title: 'Demo', description: 'Create report', acceptance: [{ path: 'report.md', contains: 'ready' }] } });
    assert.equal(create.statusCode, 200); const goal = create.json();
    const call = (action: string, payload = {}) => app.inject({ method: 'POST', url: `/api/workbench/goals/${goal.id}/${action}`, headers, payload });
    assert.equal((await call('run', { model: 'mock/model' })).statusCode, 200); assert.equal(starts, 1);
    assert.equal((await call('revise', { instruction: 'Include a summary' })).statusCode, 200);
    const pending = await loadGoal(goal.id); pending.todos[0].status = 'blocked'; await saveGoal(pending);
    await call('verify'); assert.equal((await loadGoal(goal.id)).todos[0].verification?.status, 'failed');
    await writeFile(path.join(root, 'report.md'), 'ready'); await call('verify');
    assert.equal((await loadGoal(goal.id)).status, 'completed');
    assert.equal((await call('run')).statusCode, 400);
    const skillResponse=await app.inject({ url: '/api/workbench/skills/verified-delivery', headers });
    assert.equal(skillResponse.statusCode, 200);
    assert.match(skillResponse.json().content,/name: verified-delivery/);
    assert.equal(skillResponse.json().localizations.en.title,'Verified delivery');
    assert.equal(skillResponse.json().localizations.zh.title,'经验证的成果交付');
    const sample = await app.inject({ method: 'POST', url: '/api/workbench/test-model', headers, payload: { model: 'mock/model' } });
    assert.equal(sample.json().response, 'Wentian ready');
    const state = (await app.inject({ url: '/api/workbench', headers })).json();
    assert.equal(state.goals.length, 1); assert.equal(state.version, '0.6.0');
    // 認証・別サイト・別作業場所・実行中の拒否を確認し、ユーザーの成果物は削除しません。
    const deleteUrl = `/api/workbench/goals/${goal.id}/delete`;
    assert.equal((await app.inject({ method: 'POST', url: deleteUrl, payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: deleteUrl, headers: { ...headers, origin: 'https://evil.example' }, payload: {} })).statusCode, 403);
    const foreign = await createGoal({ title: '別の作業', description: '', workspace: path.join(root, 'other') });
    assert.equal((await app.inject({ method: 'POST', url: `/api/workbench/goals/${foreign.id}/delete`, headers, payload: {} })).statusCode, 400);
    await loadGoal(foreign.id);
    const daemonDirectory = path.join(root, 'goals', goal.id);
    await mkdir(daemonDirectory, { recursive: true });
    for (const status of ['running', 'stopping']) {
      await writeFile(path.join(daemonDirectory, 'daemon.json'), JSON.stringify({ version: '1.0', goalId: goal.id, pid: process.pid, status }));
      assert.equal((await call('delete')).statusCode, 400);
      await loadGoal(goal.id);
    }
    await writeFile(path.join(daemonDirectory, 'daemon.json'), JSON.stringify({ version: '1.0', goalId: goal.id, pid: process.pid, status: 'dead' }));
    assert.equal((await call('delete')).json().deleted, true);
    await assert.rejects(loadGoal(goal.id), { code: 'ENOENT' });
    assert.equal((await app.inject({ url: '/api/workbench', headers })).json().goals.length, 0);
    assert.equal(await readFile(path.join(root, 'report.md'), 'utf8'), 'ready');
    assert.equal((await readdir(path.join(root, 'goals', 'deleted'))).length, 1);
    assert.equal((await call('delete')).statusCode, 400);
    const first = await createGoal({ title: '一括1', description: '', workspace: root });
    const second = await createGoal({ title: '一括2', description: '', workspace: root });
    const bulk = (ids: unknown) => app.inject({ method: 'POST', url: '/api/workbench/goals/bulk-delete', headers, payload: { ids } });
    assert.equal((await app.inject({ method: 'POST', url: '/api/workbench/goals/bulk-delete', payload: { ids: [first.id] } })).statusCode, 401);
    assert.equal((await bulk([])).statusCode, 400);
    assert.equal((await bulk([first.id, foreign.id])).statusCode, 400);
    await loadGoal(first.id);
    const secondDaemon = path.join(root, 'goals', second.id);
    await mkdir(secondDaemon, { recursive: true });
    await writeFile(path.join(secondDaemon, 'daemon.json'), JSON.stringify({ version: '1.0', goalId: second.id, pid: process.pid, status: 'running' }));
    assert.equal((await bulk([first.id, second.id])).statusCode, 400);
    await loadGoal(first.id);
    await writeFile(path.join(secondDaemon, 'daemon.json'), JSON.stringify({ version: '1.0', goalId: second.id, pid: process.pid, status: 'dead' }));
    const removed = (await bulk([first.id, second.id, first.id])).json();
    assert.deepEqual(removed.deleted, [first.id, second.id]);
    assert.deepEqual(removed.failed, []);
    await assert.rejects(loadGoal(first.id), { code: 'ENOENT' });
    await assert.rejects(loadGoal(second.id), { code: 'ENOENT' });
  } finally { await app.close(); if (previous === undefined) delete process.env.WENTIAN_GOAL_PATH; else process.env.WENTIAN_GOAL_PATH = previous; await rm(root, { recursive: true, force: true }); }
});
