import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { AgentGroupStore, namedMembers } from './agent-group.js';
import { registerWorkbench } from './workbench.js';
import { PublicSiteStore } from './public-site.js';
import { groupIdFor } from './cloud-federation/identity.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-group-management-')), store = new AgentGroupStore(root), app = Fastify();
  registerWorkbench(app, { workspace: root, authorize(req, reply) { if (req.headers.authorization === 'Bearer admin') return true; reply.code(req.headers.authorization ? 403 : 401).send({ error: { message: '管理者認証が必要です。' } }); return false; }, groupIdentity: req => req.headers.authorization === 'Bearer viewer' ? { id: 'viewer', name: '閲覧者', admin: false } : req.headers.authorization === 'Bearer admin' ? { id: 'admin', name: '管理者', admin: true } : undefined, models: async () => [], providerSaved() {}, testModel: async () => '未使用' });
  return { root, store, app, post: (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer admin' }, payload }), async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('一覧で集計・ページ別公開・名前変更を確認し、本文を管理一覧へ漏らさない', async () => {
  const f = await fixture();
  try {
    const group = await f.store.create('変更前', namedMembers(['試験AI'], 'mock/model'));
    await f.store.discuss(group.id, '内部の議題', 1, async () => '一覧には出さない会話本文');
    await f.store.publish(group.id, true, 'トップの紹介', 'offline', '');
    await f.store.publish(group.id, true, '別ページの紹介', 'offline', 'research');
    const response = await f.app.inject({ url: '/api/workbench/group-management', headers: { authorization: 'Bearer admin' } });
    const row = response.json().groups[0]; assert.equal(row.aiCount, 1); assert.equal(row.messageCount, 2); assert.deepEqual(row.activePages.sort(), ['', 'research']); assert.ok(!response.body.includes('一覧には出さない会話本文'));
    const before = (await f.store.load(group.id)).messages;
    assert.equal((await f.post('/api/workbench/group-management/' + group.id + '/rename', { title: '変更後', expectedTitle: '変更前' })).statusCode, 200);
    assert.equal((await f.store.load(group.id)).title, '変更後'); assert.deepEqual((await f.store.load(group.id)).messages, before);
    assert.equal((await f.post('/api/workbench/group-management/' + group.id + '/rename', { title: '競合変更', expectedTitle: '変更前' })).statusCode, 409);
    assert.equal((await f.post('/api/workbench/group-management/' + group.id + '/publication', { page: '', published: false })).statusCode, 200);
    assert.equal((await new PublicSiteStore(f.root).rooms()).length, 0);
    assert.equal((await f.store.load(group.id)).publication!.pages!.research.published, true);
    assert.equal((await f.post('/api/workbench/group-management/' + group.id + '/close-all')).statusCode, 200);
    assert.equal((await f.store.managementList())[0].activePages.length, 0);
  } finally { await f.close(); }
});

test('削除は全ページを閉鎖して通常一覧から除外し、全履歴を保全して非公開で復元する', async () => {
  const f = await fixture();
  try {
    const group = await f.store.create('保全対象', namedMembers(['試験AI'], 'mock/model'));
    await f.store.discuss(group.id, '履歴を残す', 1, async () => '保全するAI発言');
    await f.store.participate(group.id, { id: 'human', name: '人間' }, 'join'); await f.store.post(group.id, 'human', '保全する人間の発言');
    await f.store.publish(group.id, true, '全体公開'); await f.store.publish(group.id, true, 'ページ公開', 'offline', 'research');
    const original = await f.store.load(group.id);
    assert.equal((await f.post('/api/workbench/group-management/' + group.id + '/delete')).statusCode, 200);
    assert.equal((await f.store.list()).length, 0); assert.equal((await new PublicSiteStore(f.root).rooms()).length, 0);
    await assert.rejects(f.store.load(group.id), /削除済み/);
    const saved = await f.store.load(group.id, { includeDeleted: true }); assert.deepEqual(saved.messages, original.messages); assert.ok(saved.deletedAt);
    assert.equal(saved.publication!.published, false); assert.equal(saved.publication!.pages!.research.published, false);
    assert.equal((await f.post('/api/workbench/group-management/' + group.id + '/publication', { page: '', published: true })).statusCode, 404);
    assert.equal((await f.post('/api/workbench/group-management/' + group.id + '/restore')).statusCode, 200);
    const restored = await f.store.load(group.id); assert.deepEqual(restored.messages, original.messages); assert.equal(restored.publication!.published, false); assert.equal((await f.store.list()).length, 1);
  } finally { await f.close(); }
});

test('管理者・オリジン・入力・議論中・A2A履歴保護の制約を適用する', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject('/workbench/groups')).statusCode, 200);
    assert.equal((await f.app.inject('/api/workbench/group-management')).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/api/workbench/group-management', headers: { authorization: 'Bearer viewer' } })).statusCode, 403);
    const group = await f.store.create('通常グループ');
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/workbench/group-management/' + group.id + '/delete', headers: { authorization: 'Bearer admin', origin: 'https://other.example' }, payload: {} })).statusCode, 403);
    assert.equal((await f.post('/api/workbench/group-management/' + group.id + '/rename', { title: ' ', expectedTitle: group.title })).statusCode, 400);
    await assert.rejects(f.store.rename('../escape', '不正'), /不正/);
    const a = 'a'.repeat(64), b = 'b'.repeat(64), id = groupIdFor(a, b);
    await f.store.appendFederationEvent(id, [a, b], { id: 'first-event', speaker: 'Wentian-' + a.slice(0, 24), content: 'A2Aの保全対象', at: new Date().toISOString() });
    assert.equal((await f.post('/api/workbench/group-management/' + id + '/delete')).statusCode, 409);
    assert.equal((await f.store.managementList()).find(row => row.id === id)!.canDelete, false);
    await f.store.rename(id, '読みやすいA2A名'); assert.equal((await f.store.load(id)).federation!.nodeIds[0], a);
    let release!: () => void;
    const active = await f.store.create('議論中', namedMembers(['試験AI'], 'mock/model'));
    const discussion = f.store.discuss(active.id, '試験', 1, async () => { await new Promise<void>(resolve => { release = resolve; }); return '完了'; });
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    try { await assert.rejects(f.store.archive(active.id), /議論中/); } finally { release(); await discussion; }
  } finally { await f.close(); }
});
