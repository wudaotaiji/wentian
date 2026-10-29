import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { registerWorkbench } from './workbench.js';
import { AgentGroupStore, namedMembers } from './agent-group.js';
import { registerSiteAdmin, PublicSiteStore, defaultPublicSite } from './public-site.js';
import type { PublicGuestPost } from './public-guest.js';

test('個別チャットは二人だけが読み書きでき、管理者・第三者・公開サイト・AIへ漏らさない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-dm-')), app = Fastify();
  const people = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }, { id: 'admin', name: '管理者' }];
  const identity = (req: any) => { const person = people.find(p => p.id === req.headers.cookie); return person && { ...person, admin: person.id === 'admin' }; };
  let replies = 0;
  registerWorkbench(app, { workspace: root, directMessagePeople: () => people, groupIdentity: identity,
    authorize: (req, reply) => { if (identity(req)?.admin) return true; reply.code(403).send({ error: { message: '管理者専用です。' } }); return false; },
    models: async () => [], providerSaved: () => {}, testModel: async () => '', groupRespond: async () => { replies++; return '返答'; } });
  try {
    assert.equal((await app.inject('/api/direct-messages')).statusCode, 401);
    const send = (url: string, who: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { cookie: who }, payload: payload as any });
    let response = await send('/api/direct-messages', 'a', { peerId: 'b', userId: 'admin' });
    assert.equal(response.statusCode, 200, response.body); const id = response.json().id;
    assert.equal((await send('/api/direct-messages', 'b', { peerId: 'a' })).json().id, id);
    assert.equal((await send('/api/direct-messages', 'a', { peerId: 'a' })).statusCode, 400);
    assert.equal((await send('/api/direct-messages', 'a', { peerId: 'guest-forged' })).statusCode, 400);
    const posted = await Promise.all(Array.from({ length: 6 }, (_, i) => send('/api/direct-messages/' + id + '/messages', i % 2 ? 'b' : 'a', { content: '秘密' + i, senderId: 'admin' })));
    for (response of posted) assert.equal(response.statusCode, 200, response.body);
    response = await app.inject({ url: '/api/direct-messages/' + id, headers: { cookie: 'b' } });
    assert.equal(response.json().messages.length, 6); assert.ok(response.json().messages.every((m: any) => m.senderId !== 'admin'));
    for (const method of ['GET', 'POST'] as const) {
      response = await app.inject({ method, url: '/api/direct-messages/' + id + (method === 'POST' ? '/messages' : ''), headers: { cookie: 'admin' }, ...(method === 'POST' ? { payload: { content: '侵入' } } : {}) });
      assert.equal(response.statusCode, 403);
    }
    const inbox = (await app.inject({ url: '/api/direct-messages', headers: { cookie: 'admin' } })).json(); assert.equal(inbox.threads.length, 0);
    response = await app.inject({ method: 'POST', url: '/api/direct-messages/' + id + '/messages', headers: { cookie: 'a', origin: 'https://other.example' }, payload: { content: '拒否' } }); assert.equal(response.statusCode, 403);
    assert.equal((await send('/api/direct-messages/' + id + '/messages', 'a', { content: ' ' })).statusCode, 400);
    assert.equal((await send('/api/direct-messages/' + id + '/messages', 'a', { content: 'x'.repeat(10001) })).statusCode, 400);
    const groups = (await app.inject({ url: '/api/workbench/groups', headers: { cookie: 'a' } })).body; assert.doesNotMatch(groups, /秘密/); assert.equal(replies, 0);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('発言禁止と強制退会はAPI・再参加・ゲスト投稿でも効き、解除と履歴を保持する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-moderation-')), app = Fastify(); let guestPost: PublicGuestPost | undefined;
  const identity = (req: any) => ['admin', 'member'].includes(req.headers.cookie) ? { id: req.headers.cookie, name: req.headers.cookie, admin: req.headers.cookie === 'admin' } : undefined;
  registerWorkbench(app, { workspace: root, groupIdentity: identity, registerPublicPost: post => { guestPost = post; }, authorize: (req, reply) => { if (identity(req)?.admin) return true; reply.code(403).send({ error: { message: '管理者専用です。' } }); return false; }, models: async () => [], providerSaved: () => {}, testModel: async () => '' });
  registerSiteAdmin(app, { workspace: root, authorize: () => true, gatewayOrigin: () => 'http://localhost', design: async () => '{}', guestPost: (...args) => guestPost!(...args) });
  try {
    await app.ready(); const groups = new AgentGroupStore(root), group = await groups.create('管理試験', namedMembers(['AI']));
    const url = '/api/workbench/groups/' + group.id;
    const send = (action: string, who: string, payload: unknown) => app.inject({ method: 'POST', url: url + '/' + action, headers: { cookie: who }, payload: payload as any });
    await send('join', 'member', {}); await send('messages', 'member', { content: '保持する発言' });
    assert.equal((await send('moderation', 'member', { userId: 'member', action: 'kick' })).statusCode, 403);
    await send('moderation', 'admin', { userId: 'member', action: 'mute' });
    assert.equal((await send('messages', 'member', { content: '禁止' })).statusCode, 403);
    await send('leave', 'member', {}); await send('join', 'member', {});
    assert.equal((await send('messages', 'member', { content: '禁止' })).statusCode, 403);
    await send('moderation', 'admin', { userId: 'member', action: 'unmute' }); assert.equal((await send('messages', 'member', { content: '解除済み' })).statusCode, 200);
    await send('moderation', 'admin', { userId: 'member', action: 'kick' });
    assert.equal((await send('join', 'member', {})).statusCode, 403); assert.equal((await groups.load(group.id)).members.find(m => m.userId === 'member')!.active, false);
    await send('moderation', 'admin', { userId: 'member', action: 'unban' }); assert.equal((await send('join', 'member', {})).statusCode, 200);
    assert.equal((await groups.load(group.id)).messages.length, 2);
    await new PublicSiteStore(root).save({ ...defaultPublicSite }); await groups.publish(group.id, true, '', 'online', '');
    const publicUrl = '/api/site/rooms/' + group.id, nickname = '訪問者<guest@example.com>';
    let response = await app.inject({ method: 'POST', url: publicUrl + '/join', payload: { nickname } }); const cookie = String(response.headers['set-cookie']).split(';')[0];
    await app.inject({ method: 'POST', url: publicUrl + '/messages', headers: { cookie }, payload: { nickname, content: '訪問者です' } });
    const guest = (await groups.load(group.id)).members.find(m => m.userId?.startsWith('guest-'))!;
    await send('moderation', 'admin', { userId: guest.userId, action: 'mute' });
    response = await app.inject({ method: 'POST', url: publicUrl + '/messages', headers: { cookie }, payload: { nickname, content: '禁止' } }); assert.notEqual(response.statusCode, 200);
    await send('moderation', 'admin', { userId: guest.userId, action: 'kick' });
    response = await app.inject({ method: 'POST', url: publicUrl + '/messages', headers: { cookie }, payload: { nickname, content: '再参加禁止' } }); assert.notEqual(response.statusCode, 200);
    assert.equal((await new AgentGroupStore(root).load(group.id)).members.find(m => m.userId === guest.userId)!.banned, true);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
