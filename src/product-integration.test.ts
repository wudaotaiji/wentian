import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from './server.js';
import { ControlCenterAuthStore } from './control-center-auth.js';

test('本体の実ログインからプロジェクト・資料権限・仮想キー計量まで接続される', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-product-integration-'));
  const beforeEnv = Object.fromEntries(['WENTIAN_USER_STORE','WENTIAN_TEAM_ACCESS_ROOT','WENTIAN_PROJECT_KNOWLEDGE_ROOT','WENTIAN_WORKFLOW_ROOT','WENTIAN_TASK_WORKSPACE','WENTIAN_EVENT_STORE'].map(key => [key, process.env[key]]));
  for (const [key, name] of Object.entries({ WENTIAN_USER_STORE: 'users.json', WENTIAN_TEAM_ACCESS_ROOT: 'teams', WENTIAN_PROJECT_KNOWLEDGE_ROOT: 'knowledge', WENTIAN_WORKFLOW_ROOT: 'workflows', WENTIAN_TASK_WORKSPACE: 'workspace', WENTIAN_EVENT_STORE: 'events.jsonl' })) process.env[key] = path.join(root, name);
  const users = new ControlCenterAuthStore(); await users.initialize();
  const password = 'fixture-password-20261004';
  const owner = await users.createUser({ username: 'owner', password, role: 'admin' });
  const member = await users.createUser({ username: 'member', password, role: 'viewer' });
  await users.createUser({ username: 'stranger', password, role: 'viewer' });
  const previousFetch = globalThis.fetch; let chatCalls = 0;
  // 上流だけを模擬する。本人認証・プロジェクト台帳・HTTP境界は本体を使用する。
  globalThis.fetch = (async input => {
    if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { headers: { 'content-type': 'application/json' } });
    if (String(input).includes('/chat/completions')) { chatCalls++; return new Response(JSON.stringify({ choices: [{ message: { content: '検証応答' } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json' } }); }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const app = await buildApp({ agentConnectionMaintenance: false });
  try {
    async function login(username: string) {
      const result = await app.inject({ method: 'POST', url: '/api/control-center/login', payload: { username, password } });
      assert.equal(result.statusCode, 200, result.body);
      const cookie = String(result.headers['set-cookie']).split(';')[0]!;
      await app.inject({ url: '/api/team-access/projects', headers: { cookie } });
      return { cookie };
    }
    const admin = await login('owner'), viewer = await login('member'), stranger = await login('stranger');
    const created = await app.inject({ method: 'POST', url: '/api/team-access/projects', headers: admin, payload: { id: 'project-a', name: '検証プロジェクト', ownerId: owner.id } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/projects/project-a/members', headers: admin, payload: { userId: member.id, role: 'member' } })).statusCode, 200);
    const settings = await app.inject({ method: 'PATCH', url: '/api/team-access/projects/project-a', headers: admin, payload: { allowedModels: ['lmstudio/local-model'], pricing: { 'lmstudio/local-model': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } }, requestLimit: { maxRequests: 1, windowMs: 60000 } } });
    assert.equal(settings.statusCode, 200, settings.body);
    const knowledge = '/v1/project-knowledge/project-a/documents';
    const registered = await app.inject({ method: 'POST', url: knowledge, headers: admin, payload: { title: '社内手順', url: 'https://example.com/procedure', content: 'プロジェクトの復旧手順です。' } });
    assert.ok(registered.statusCode < 300, registered.body);
    assert.equal((await app.inject({ url: knowledge, headers: viewer })).statusCode, 200);
    assert.equal((await app.inject({ url: knowledge, headers: stranger })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: knowledge, headers: viewer, payload: { title: '無許可', url: 'https://example.com', content: '変更不可' } })).statusCode, 403);
    const search = await app.inject({ url: '/v1/project-knowledge/project-a/search?q=' + encodeURIComponent('復旧'), headers: viewer });
    assert.equal(search.statusCode, 200); assert.match(search.body, /復旧/);
    const issued = await app.inject({ method: 'POST', url: '/api/team-access/projects/project-a/keys', headers: admin, payload: { label: '試験' } });
    assert.equal(issued.statusCode, 201, issued.body); const key = issued.json();
    const keyHeaders = { 'x-team-virtual-key': key.key };
    assert.equal((await app.inject({ url: '/api/team-access/overview', headers: keyHeaders })).statusCode, 403);
    assert.equal((await app.inject({ url: '/v1/project-knowledge/project-b/documents', headers: keyHeaders })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: keyHeaders, payload: { model: 'unauthorized/model', messages: [] } })).statusCode, 403);
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: keyHeaders, payload: { model: 'lmstudio/local-model', messages: [{ role: 'user', content: '試験' }] } });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers['x-wentian-usage-source'], 'upstream');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: keyHeaders, payload: { model: 'lmstudio/local-model', messages: [] } })).statusCode, 429); assert.equal(chatCalls, 1);
    const usage = (await app.inject({ url: '/api/team-access/projects/project-a/usage', headers: admin })).json();
    assert.equal(usage.project.spendUsd, 0.00003); assert.equal(usage.project.heldUsd, 0);
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/team-access/projects/project-a', headers: { ...admin, origin: 'https://outside.example' }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ url: '/operations', headers: admin })).statusCode, 200);
    assert.equal((await app.inject({ url: '/projects', headers: viewer })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/workbench/workflows', headers: viewer })).statusCode, 403);
    // 発行後の応答から原文キー・認証ハッシュが漏れない。
    const revoked = await app.inject({ method: 'POST', url: `/api/team-access/projects/project-a/keys/${key.keyId}/revoke`, headers: admin, payload: {} });
    assert.equal(revoked.statusCode, 200, revoked.body); assert.ok(!revoked.body.includes('"hash"'));
    assert.equal((await app.inject({ url: '/v1/models', headers: keyHeaders })).statusCode, 401);
  } finally {
    await app.close(); globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(beforeEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
