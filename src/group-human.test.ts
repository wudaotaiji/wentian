import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { AgentGroupStore, namedMembers } from './agent-group.js';
import { registerWorkbench } from './workbench.js';

const portrait = { type: 'upload' as const, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
async function temporary(action: (store: AgentGroupStore, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-humans-'));
  try { await action(new AgentGroupStore(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('人間へ各AIが返答し、次の担当へ最新履歴を渡し、実作業は起動しない', async () => temporary(async store => {
  const group = await store.create('会議', namedMembers(['甲', '乙']));
  await store.participate(group.id, { id: 'alice', name: '杨' }, 'join');
  await store.post(group.id, 'alice', '大家好！');
  const result = await store.replyToHuman(group.id, '大家好！', async (member, messages, context) => {
    assert.equal(context?.conversational, true);
    assert.match(messages[1].content, /大家好/);
    if (member.name === '乙') assert.match(messages[1].content, /甲的回复/);
    return member.name + '的回复';
  });
  assert.deepEqual(result.messages.map(message => message.speaker), ['杨', '甲', '乙']);
  assert.equal(result.discussion, undefined);
}));

test('本人の参加・オフライン投稿・退出・再参加と履歴を永続化する', async () => temporary(async (store, root) => {
  const group = await store.create('会議', namedMembers(['設計担当']));
  await assert.rejects(store.post(group.id, 'alice', '未参加'), /参加/);
  await store.participate(group.id, { id: 'alice', name: '設計担当' }, 'join', 'offline');
  let saved = await store.post(group.id, 'alice', '<script>本文は文字列</script>');
  const alice = saved.members.find(m => m.userId === 'alice')!;
  assert.notEqual(alice.name, '設計担当');
  assert.equal(alice.presence, 'offline');
  assert.equal(saved.messages[0].speaker, alice.name);
  assert.equal(saved.messages[0].userId, 'alice');
  await store.participate(group.id, { id: 'alice', name: '設計担当' }, 'presence', 'online');
  await store.participate(group.id, { id: 'alice', name: '設計担当' }, 'leave');
  await assert.rejects(store.post(group.id, 'alice', '退出後'), /参加/);
  saved = await store.participate(group.id, { id: 'alice', name: '設計担当' }, 'join');
  assert.equal(saved.members.filter(m => m.userId === 'alice').length, 1);
  assert.equal(saved.messages.length, 1);
  assert.deepEqual(await new AgentGroupStore(root).load(group.id), saved);
  const file = path.join(root, '.wentian', 'groups', group.id + '.json.humans');
  const state = JSON.parse(await readFile(file, 'utf8')); state.members[0].lastSeenAt = '2000-01-01T00:00:00Z';
  await writeFile(file, JSON.stringify(state));
  assert.equal((await store.load(group.id)).members.find(m => m.userId === 'alice')!.presence, 'offline');
}));

test('送信時にニックネーム・メール・IPを本人だけへ保存し、不正入力は投稿しない', async () => temporary(async (store, root) => {
  const group = await store.create('登録', namedMembers(['吉田']));
  await store.participate(group.id, { id: 'alice', name: 'Alice' }, 'join');
  const profile = { nickname: '吉田<member@example.com>', ipAddress: '127.0.0.1' };
  const saved = await store.post(group.id, 'alice', '本人の発言', profile);
  const member = saved.members.find(m => m.userId === 'alice')!;
  assert.equal(member.nickname, '吉田');
  assert.notEqual(member.name, '吉田');
  assert.equal(member.email, 'member@example.com');
  assert.equal(member.ipAddress, '127.0.0.1');
  assert.equal(saved.messages[0].speaker, member.name);
  assert.deepEqual(await new AgentGroupStore(root).load(group.id), saved);
  for (const nickname of ['吉田', '吉田<invalid>', '吉田<member@example.com><extra>', 'ユーザー<a@example.com>']) await assert.rejects(store.post(group.id, 'alice', '不正', { ...profile, nickname }), /ニックネーム/);
  await assert.rejects(store.post(group.id, 'alice', '不正IP', { ...profile, ipAddress: 'not-an-ip' }), /IP/);
  assert.equal((await store.load(group.id)).messages.length, 1);
  await store.participate(group.id, { id: 'alice', name: 'Alice' }, 'leave');
  const rejoined = await store.participate(group.id, { id: 'alice', name: 'Alice' }, 'join');
  assert.equal(rejoined.members.find(m => m.userId === 'alice')!.email, profile.nickname.match(/<(.+)>/)![1]);
}));

test('AIの応答中に参加・投稿でき、次のAIが人間の発言を読み、同時投稿を失わない', async () => temporary(async store => {
  const group = await store.create('並行会議', namedMembers(['AI甲', 'AI乙']));
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const calls: string[] = [];
  const discussion = store.discuss(group.id, '計画', 1, async (member, messages) => {
    calls.push(member.name);
    if (member.name === 'AI甲') { started(); await gate; }
    else assert.match(messages[1].content, /人間の追加条件/);
    return member.name + 'の回答';
  });
  await ready;
  try {
    await store.participate(group.id, { id: 'alice', name: 'Alice' }, 'join');
    await store.participate(group.id, { id: 'bob', name: 'Bob' }, 'join', 'offline');
    await Promise.all([store.post(group.id, 'alice', '人間の追加条件'), store.post(group.id, 'bob', '非同期の意見')]);
    await store.avatar(group.id, 'Alice', portrait, 'alice');
  } finally { release(); }
  const result = await discussion;
  assert.deepEqual(calls, ['AI甲', 'AI乙']);
  assert.equal(result.messages.length, 5);
  assert.equal(result.members.filter(m => m.kind === 'human').length, 2);
  assert.equal(result.members.find(m => m.userId === 'alice')!.avatar?.type, 'upload');
  assert.equal(result.discussion!.totalTurns, 2);
  assert.deepEqual(await store.load(group.id), result);
}));

test('画像の生成・アップロードは本人または管理者だけに限定し、不正画像を拒否する', async () => temporary(async store => {
  const group = await store.create('画像', namedMembers(['AI']));
  await store.participate(group.id, { id: 'alice', name: 'Alice' }, 'join');
  await store.avatar(group.id, 'Alice', portrait, 'alice');
  await assert.rejects(store.avatar(group.id, 'Alice', portrait, 'bob'), /本人/);
  await assert.rejects(store.avatar(group.id, 'AI', portrait, 'alice'), /本人/);
  await assert.rejects(store.avatar(group.id, 'Alice', { type: 'upload', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }, 'alice'), /PNG/);
  await assert.rejects(store.avatar(group.id, 'Alice', { type: 'upload', dataUrl: 'data:image/png;base64,YmFk' }, 'alice'), /不正/);
  await assert.rejects(store.avatar(group.id, 'Alice', { type: 'upload', dataUrl: 'data:image/png;base64,' + 'A'.repeat(180004) }, 'alice'), /128KB/);
  await store.avatar(group.id, 'AI', { type: 'generated', seed: 'new-portrait' });
  await store.member(group.id, 'update', 'AI', { name: 'AI改名', role: '検証', model: 'mock/model' });
  assert.deepEqual((await store.load(group.id)).members.find(m => m.name === 'AI改名')!.avatar, { type: 'generated', seed: 'new-portrait' });
}));

test('一般利用者は本人として会話に参加でき、AI操作や他人の画像編集はできない', async () => temporary(async (store, root) => {
  const group = await store.create('API', namedMembers(['AI']));
  const app = Fastify();
  registerWorkbench(app, { workspace: root, models: async () => [], providerSaved: () => {}, testModel: async () => '',
    authorize: (req, reply) => { if (req.headers['x-user'] === 'admin') return true; reply.code(req.headers['x-user'] ? 403 : 401).send({ error: { message: '権限が必要' } }); return false; },
    groupIdentity: req => { const id = req.headers['x-user']; return ['admin', 'alice', 'bob'].includes(String(id)) ? { id: String(id), name: String(id), admin: id === 'admin' } : undefined; }
  });
  const base = '/api/workbench/groups/' + group.id;
  const post = (user: string, action: string, payload = {}) => app.inject({ method: 'POST', url: base + '/' + action, headers: { 'x-user': user }, payload });
  try {
    assert.equal((await app.inject(base)).statusCode, 401);
    assert.equal((await app.inject({ url: base, headers: { 'x-user': 'alice' } })).statusCode, 200);
    assert.equal((await post('alice', 'join', { userId: 'bob', presence: 'offline' })).statusCode, 200);
    let response = await post('alice', 'messages', { userId: 'bob', speaker: 'AI', content: '本人の発言' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().messages[0].userId, 'alice');
    assert.equal(response.json().messages[0].speaker, 'alice');
    assert.equal((await post('bob', 'messages', { content: '未参加' })).statusCode, 400);
    assert.equal((await post('alice', 'members/remove', { name: 'AI' })).statusCode, 403);
    assert.equal((await post('alice', 'avatar', { name: 'AI', avatar: portrait })).statusCode, 400);
    assert.equal((await post('alice', 'avatar', { name: 'alice', avatar: portrait })).statusCode, 200);
    assert.equal((await post('admin', 'avatar', { name: 'AI', avatar: portrait })).statusCode, 200);
    response = await app.inject({ method: 'POST', url: base + '/messages', remoteAddress: '192.0.2.42', headers: { 'x-user': 'alice', 'x-forwarded-for': '203.0.113.1' }, payload: { content: '登録する発言', nickname: '吉田<member@example.com>', userId: 'bob', ipAddress: '203.0.113.2' } });
    assert.equal(response.statusCode, 200, response.body);
    const registered = response.json().members.find((m: any) => m.userId === 'alice');
    assert.equal(registered.name, '吉田');
    assert.equal(registered.email, 'member@example.com');
    assert.equal(registered.ipAddress, '192.0.2.42');
    assert.equal(response.json().messages.at(-1).userId, 'alice');
    response = await app.inject({ method: 'POST', url: base + '/messages', headers: { 'x-user': 'alice', origin: 'https://evil.example' }, payload: { content: '偽装' } });
    assert.equal(response.statusCode, 403);
    assert.equal((await post('alice', 'leave')).statusCode, 200);
  } finally { await app.close(); }
}));
