import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Script } from 'node:vm';
import { AgentGroupStore, gatewayGroupResponder, groupCommand, namedMembers } from './agent-group.js';
import { registerWorkbench } from './workbench.js';
import { workbenchHtml } from './workbench-ui.js';

async function temporary(fn: (store: AgentGroupStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-group-'));
  try { await fn(new AgentGroupStore(root), root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('既定メンバーなし、9人以上の自由追加、名前・役割・モデル変更、削除を保存する', async () => {
  await temporary(async (store, root) => {
    let group = await store.create('相談室'); assert.deepEqual(group.members, []);
    for (let n = 0; n < 12; n++) group = await store.member(group.id, 'add', `参加者${n}`, { name: `参加者${n}`, role: `役割${n}`, model: `mock/${n}` });
    assert.equal(group.members.length, 12);
    group = await store.member(group.id, 'update', '参加者0', { name: '自由な名前', role: '自由な役割', model: 'mock/changed' });
    assert.equal(group.members[0].model, 'mock/changed');
    await assert.rejects(store.member(group.id, 'add', '重複', group.members[0]), /重複/);
    group = await store.member(group.id, 'remove', '参加者1');
    assert.deepEqual((await new AgentGroupStore(root).load(group.id)).members, group.members);
    await assert.rejects(store.load('../escape'), /不正/);
  });
});

test('選択メンバーだけが順番に互いの発言を読み、再開時も履歴を保持する', async () => {
  await temporary(async store => {
    const group = await store.create('議論', namedMembers(['甲', '乙', '丙']));
    const speakers: string[] = [];
    const result = await store.discuss(group.id, '改善案', 2, async (member, messages) => {
      if (speakers.length) assert.match(messages[1].content, /発言1/);
      speakers.push(member.name); return `発言${speakers.length}`;
    }, ['甲', '丙']);
    assert.deepEqual(speakers, ['甲', '丙', '甲', '丙']); assert.equal(result.messages.length, 5);
    const resumed = await store.discuss(group.id, '続き', 1, async (_member, messages) => { assert.match(messages[1].content, /改善案/); return '続行'; }, ['乙']);
    assert.equal(resumed.messages.length, 7);
    assert.deepEqual((await store.load(group.id)).discussion, { status: 'completed', completedTurns: 1, totalTurns: 1 });
    await assert.rejects(store.discuss(group.id, '話題', 1, async () => '回答', ['不在']), /正しく/);
    await assert.rejects(store.discuss(group.id, '話題', 0, async () => '回答'), /1〜5/);
  });
});

test('議論中の編集を拒否し、モデル失敗時は確定済み履歴を保存してロックを解除する', async () => {
  await temporary(async store => {
    const group = await store.create('議論', namedMembers(['甲', '乙']));
    await assert.rejects(store.discuss(group.id, '相談', 1, async member => {
      await assert.rejects(store.member(group.id, 'remove', '甲'), /議論中/);
      if (member.name === '乙') throw new Error('モデル失敗'); return '保存される発言';
    }), /モデル失敗/);
    assert.equal((await store.load(group.id)).messages.length, 2);
    assert.deepEqual((await store.load(group.id)).discussion, { status: 'failed', completedTurns: 1, totalTurns: 2, error: 'モデル失敗' });
    await store.member(group.id, 'remove', '乙');
    const empty = await store.create('空');
    await assert.rejects(store.discuss(empty.id, '相談', 1, async () => '発言'), /追加・選択/);
  });
});

test('空のモデル回答は成功扱いにせず、失敗状態と確定発言を保存する', async () => {
  await temporary(async store => {
    const group = await store.create('空回答の検証', namedMembers(['甲']));
    await assert.rejects(store.discuss(group.id, '具体的な改善案', 1, async () => ''), /回答が空/);
    const saved = await store.load(group.id);
    assert.equal(saved.discussion?.status, 'failed');
    assert.equal(saved.discussion?.completedTurns, 0);
    assert.equal(saved.messages.length, 1);
    await store.member(group.id, 'remove', '甲');
  });
});

test('認証付き工作台APIで自由なメンバー管理と議論を実行する', async () => {
  await temporary(async (_store, root) => {
    const app = Fastify();
    registerWorkbench(app, { workspace: root, authorize: (req, reply) => { if (req.headers.authorization === 'Bearer test') return true; reply.code(401).send({ error: { message: 'ログインが必要' } }); return false; }, models: async () => [{ id: 'mock/model' }], providerSaved: () => {}, testModel: async () => 'ok', groupRespond: async member => member.name === '専門メンバー選定' ? JSON.stringify({ members: [{ name: '進行役', role: '論点を整理する' }, { name: '専門役', role: '提案を検討する' }, { name: '検証役', role: '根拠を検証する' }].map(m => ({ ...m, visualAssetId: null, visualReason: 'この試験では人物素材を選択しません。' })) }) : `${member.name}の意見` });
    const headers = { authorization: 'Bearer test' };
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as object });
    try {
      assert.equal((await app.inject('/api/workbench/groups')).statusCode, 401);
      const group = (await post('/api/workbench/groups', { title: '自由なグループ' })).json();
      await _store.configureAutonomy(group.id,{enabled:false,workflow:'free'});
      assert.ok(group.members.length >= 3);
      const base = `/api/workbench/groups/${group.id}`;
      assert.equal((await post(base+'/members/add', { name: '任意', member: { name: '任意', role: '設計', model: 'mock/model' } })).statusCode, 200);
      assert.equal((await post(base+'/members/add', { name: '別人', member: { name: '別人', role: '検証', model: 'unknown' } })).statusCode, 400);
      const discussion = await post(base+'/discuss', { prompt: '意見をください', participants: ['任意'] });
      assert.equal(discussion.statusCode, 200); assert.equal(discussion.json().messages[1].speaker, '任意');
      assert.equal((await post(base+'/members/update', { name: '任意', member: { name: '新しい名前', role: '分析', model: 'mock/model' } })).statusCode, 200);
      assert.equal((await post(base+'/members/remove', { name: '新しい名前' })).json().members.length, group.members.length);
      assert.equal((await app.inject({ method: 'POST', url: base+'/discuss', headers: { ...headers, origin: 'https://evil.example' }, payload: { prompt: '相談' } })).statusCode, 403);
    } finally { await app.close(); }
  });
});

test('実HTTP経由でメンバーごとのモデルと共有履歴を送り、CLIで登録・更新できる', async () => {
  await temporary(async (store, root) => {
    const app = Fastify(); let calls = 0;
    app.post('/v1/chat/completions', async req => {
      const body = req.body as { model: string; messages: Array<{ content: string }>; tools?: unknown };
      assert.equal(body.model, 'mock/custom'); assert.equal(body.tools, undefined);
      if (calls > 0) assert.match(body.messages[1].content, /HTTP回答1/);
      calls++; return { choices: [{ message: { content: `HTTP回答${calls}` } }] };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    try {
      const group = JSON.parse(await groupCommand(['create', 'CLI相談室', '--workspace', root]));
      await groupCommand(['add-member', group.id, '--name', '任意のAI', '--role', '独自の役割', '--model', 'mock/custom', '--workspace', root]);
      const address = app.server.address() as { port: number };
      await store.discuss(group.id, '相談', 2, gatewayGroupResponder(`http://127.0.0.1:${address.port}`));
      assert.equal(calls, 2); assert.equal((await store.load(group.id)).messages.length, 3);
      await assert.rejects(groupCommand(['create', '不正', '--model', '--workspace', root]), /値/);
    } finally { await app.close(); }
  });
});

test('工作台のグループ編集コードは構文が有効で、固定メンバーを含まない', () => {
  new Script(workbenchHtml.match(/<script>([\s\S]*?)<\/script>/)![1]);
  assert.match(workbenchHtml, /memberForm/); assert.match(workbenchHtml, /groupDiscuss/);
  assert.doesNotMatch(workbenchHtml, /张三|李四|王二麻子/);
});
