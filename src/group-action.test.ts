import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { createGroupActionResponder } from './group-action.js';
import { AgentGroupStore } from './agent-group.js';
import { registerWorkbench } from './workbench.js';

const member = { name: '実装担当', role: '開発', model: 'mock/model' };
const call = (id: string, name: string, input: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });

test('Actionが実ファイルを読み書きし、コマンド結果と失敗をモデルへ返して記録する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-action-'));
  let turn = 0;
  try {
    const respond = createGroupActionResponder(async payload => {
      const messages = payload.messages as any[];
      assert.ok(payload.tools);
      if (turn++ === 0) return { choices: [{ message: { tool_calls: [call('write', 'write_file', { path: 'output.txt', content: '実変更' }), call('read', 'read_file', { path: 'output.txt' }), call('run', 'run_command', { command: 'Write-Output "実行成功"' }), call('outside', 'write_file', { path: '../outside.txt', content: '禁止' }), call('delete', 'run_command', { command: 'Remove-Item output.txt' })] } }] };
      assert.equal(messages.find(m => m.tool_call_id === 'read').content, '実変更');
      assert.match(messages.find(m => m.tool_call_id === 'run').content, /実行成功/);
      assert.match(messages.find(m => m.tool_call_id === 'outside').content, /失敗/);
      assert.match(messages.find(m => m.tool_call_id === 'delete').content, /失敗/);
      return { choices: [{ message: { content: 'output.txtを変更し、読み取りとコマンドで検証しました。' } }] };
    });
    const reply = await respond(member, [{ role: 'user', content: '実装してください' }], { mode: 'action', repository: root, model: 'mock/model' });
    assert.equal(await readFile(path.join(root, 'output.txt'), 'utf8'), '実変更');
    assert.match(reply.content, /write_file output.txt: 成功/);
    assert.match(reply.content, /run_command Remove-Item output.txt: ツール失敗/);
    await assert.rejects(respond(member, [], { mode: 'plan' }), /Action設定/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('既定Planは操作経路を使わず、保存済みAction設定だけが実行される', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-action-api-'));
  const store = new AgentGroupStore(root), group = await store.create('実装相談', [member]);
  await store.configureAutonomy(group.id,{enabled:false,workflow:'free'});
  const app = Fastify(); let plan = 0, action = 0;
  registerWorkbench(app, { workspace: root, authorize: (req, reply) => { if (req.headers.authorization === 'Bearer admin') return true; reply.code(403).send({ error: { message: '管理者のみ' } }); return false; }, models: async () => [{ id: 'mock/model' }], providerSaved: () => {}, testModel: async () => 'ok', groupRespond: async () => { plan++; return '計画のみ'; }, groupActionRespond: async (_member, _messages, settings) => { action++; assert.equal(settings.repository, root); return '実作業結果'; } });
  const post = (suffix: string, payload: object, admin = true) => app.inject({ method: 'POST', url: '/api/workbench/groups/' + group.id + suffix, headers: admin ? { authorization: 'Bearer admin' } : {}, payload });
  try {
    assert.equal((await store.load(group.id)).execution?.mode, 'plan');
    assert.equal((await post('/discuss', { prompt: '実装', mode: 'action', repository: root })).statusCode, 200);
    assert.equal(plan, 1); assert.equal(action, 0);
    assert.equal((await post('/execution', { mode: 'action', repository: root, model: 'mock/model' }, false)).statusCode, 403);
    assert.equal((await post('/execution', { mode: 'action', repository: '', model: 'mock/model' })).statusCode, 400);
    assert.equal((await post('/execution', { mode: 'action', repository: root, model: 'unknown' })).statusCode, 200);
    assert.equal((await store.load(group.id)).execution?.model, undefined);
    assert.equal((await post('/execution', { mode: 'action', repository: root, model: 'mock/model' })).statusCode, 200);
    assert.equal((await post('/discuss', { prompt: '実装' })).statusCode, 200);
    assert.equal(action, 1); assert.equal(plan, 1);
    assert.equal((await post('/execution', { mode: 'plan' })).statusCode, 200);
    assert.deepEqual((await store.load(group.id)).execution, { mode: 'plan' });
    assert.equal((await post('/discuss', { prompt: '相談' })).statusCode, 200);
    assert.equal(plan, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('操作後にモデルが失敗しても実行記録を保存し、議論を失敗として停止する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-action-failure-'));
  try {
    let turn = 0;
    const respond = createGroupActionResponder(async () => {
      if (turn++ === 0) return { choices: [{ message: { tool_calls: [call('write', 'write_file', { path: 'changed.txt', content: '実際の変更' })] } }] };
      throw new Error('モデル通信失敗');
    });
    const store = new AgentGroupStore(root), group = await store.create('実装', [member]);
    const settings = { mode: 'action' as const, repository: root, model: 'mock/model' };
    await store.configureExecution(group.id, settings);
    await assert.rejects(store.discuss(group.id, '作業', 1, (m, messages, _context, signal) => respond(m, messages, settings, signal)), /モデル通信失敗/);
    const loaded = await store.load(group.id);
    assert.equal(loaded.discussion?.status, 'failed');
    assert.match(loaded.messages.at(-1)!.content, /write_file changed.txt: 成功/);
    assert.equal(await readFile(path.join(root, 'changed.txt'), 'utf8'), '実際の変更');
  } finally { await rm(root, { recursive: true, force: true }); }
});
