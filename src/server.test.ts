import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, providers } from './server.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PublicSiteStore, defaultPublicSite } from './public-site.js';

test('公開用のローカル設定は組み込みプロバイダーを置き換え、IDが重複しない', () => {
  assert.equal(new Set(providers.map(provider => provider.id)).size, providers.length);
  for (const id of ['lmstudio', 'ollama']) assert.equal(providers.filter(provider => provider.id === id).length, 1);
});

test('メールサイトの未認証アクセスではログインフォームを表示し、APIはJSONで拒否する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-login-'));
  const previous = process.env.WENTIAN_TASK_WORKSPACE;
  process.env.WENTIAN_TASK_WORKSPACE = root;
  await new PublicSiteStore(root, 'mail-solutions').save({ ...structuredClone(defaultPublicSite), mailDocument: '<html><body>秘密のメール本文</body></html>' });
  const app = await buildApp({ agentConnectionMaintenance: false });
  try {
    for (const url of ['/sites/mail-solutions/', '/mail-solutions']) {
      const response = await app.inject(url);
      assert.equal(response.statusCode, 401);
      assert.match(String(response.headers['content-type']), /text\/html/);
      assert.match(response.body, /id="loginForm"/);
      assert.match(response.body, /autocomplete="current-password"|autocomplete="new-password"/);
      assert.doesNotMatch(response.body, /秘密のメール本文/);
    }
    const api = await app.inject('/api/mail-training');
    assert.equal(api.statusCode, 401);
    assert.match(String(api.headers['content-type']), /application\/json/);
    assert.equal(api.json().error.code, 'session_required');
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.WENTIAN_TASK_WORKSPACE; else process.env.WENTIAN_TASK_WORKSPACE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('品質予算（Quality Budget）と難度（Difficulty）の不正値を上流送信前に拒否する', async () => {
  const app = await buildApp({ agentConnectionMaintenance: false });
  try {
    for (const fields of [{ wentian_quality: 'invalid' }, { wentian_difficulty: 2 }, { wentian_difficulty: '0.5' }]) {
      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { ...fields, messages: [] } });
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error.code, /^invalid_(quality|difficulty)$/);
    }
    const performance = await app.inject({ method: 'GET', url: '/v1/manager/performance' });
    assert.equal(performance.statusCode, 200);
    assert.ok(Array.isArray(performance.json().data));
  } finally { await app.close(); }
});

test('上流429の状態・Provider・再試行時刻を構造化診断で返す', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  // 実サービスへ接続せず、モデル一覧と上流エラーだけを模擬します。
  globalThis.fetch = (async (input: any) => {
    calls.push(String(input));
    if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: String(input).includes(':1234/') ? [{ id: 'local-model' }] : [] }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: { message: '利用制限' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } });
  }) as typeof fetch;
  const upstreamCalls = () => calls.filter(url => url.includes('/chat/completions')).length;
  const app = await buildApp({ agentConnectionMaintenance: false });
  // 模擬のモデル一覧で候補をLM Studioの1件に絞り、企業固有の能力値に依存しません。
  const payload = { model: 'lmstudio/local-model', messages: [{ role: 'user', content: '試験' }], wentian_min_context_tokens: 16_000 };
  try {
    const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.json().error.details.upstream, { provider: 'lmstudio', model: 'lmstudio/local-model', status: 429, retryAfter: '60' });
    // 上流の利用制限をWentian側の障害と混ぜず、再試行可能までの秒数を応答へ出します。
    assert.equal(result.headers['retry-after'], '60');
    assert.equal(result.json().error.details.reason, 'upstream_limit');
    assert.match(result.json().error.message, /利用制限/);
    assert.deepEqual(calls.filter(url => url.includes('/chat/completions')), ['http://127.0.0.1:1234/v1/chat/completions'], '上流実作業の呼び出し回数が想定と違います。');
    // 常駐の状態確認から、待機中のプロバイダーと再試行可能時刻を確認できます。
    const health = (await app.inject({ method: 'GET', url: '/health' })).json();
    assert.match(health.upstreamLimits['lmstudio'], /^\d{4}-\d{2}-\d{2}T/);
    // 待機中は上流へ再投入せず、待機中の503として待てる秒数を返します。
    // 自動選択の待機判定を検査し、別の外部Agentへの迂回はこの試験で無効にします。
    const cooling = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: {'x-wentian-execution-mode':'direct'}, payload: {...payload, model:'wentian-auto/local'} });
    assert.equal(cooling.statusCode, 503);
    assert.equal(cooling.json().error.code, 'upstream_rate_limited');
    assert.ok(Number(cooling.headers['retry-after']) > 0);
    assert.equal(upstreamCalls(), 1, '利用制限の待機中に上流実作業を再投入しています。');
  } finally { await app.close(); globalThis.fetch = originalFetch; }
});

test('宣言した最小文脈長を満たす候補が無い場合は切り詰めず不足を返す', async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async (input: any) => {
    if (String(input).includes('/chat/completions')) upstreamCalls++;
    if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: { message: '利用制限' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } });
  }) as typeof fetch;
  const app = await buildApp({ agentConnectionMaintenance: false });
  try {
    const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'wentian-auto/remote', messages: [{ role: 'user', content: '試験' }], wentian_min_context_tokens: 500_000 } });
    // 文脈不足の候補へ黙って落として切り詰めた成功を作らず、不足量を明示して止めます。
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().error.code, 'context_shortfall');
    assert.deepEqual(result.json().error.details, { minContextTokens: 500_000, largestContextTokens: 32_768 });
    assert.equal(upstreamCalls, 0, '条件を満たす候補が無いのに上流へ送信しています。');
  } finally { await app.close(); globalThis.fetch = originalFetch; }
});

test('接続設定の保守開始には管理者セッションを要求する', async () => {
  const app = await buildApp({ agentConnectionMaintenance: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/manager/external-agents/maintenance', payload: {} });
    assert.equal(response.statusCode, 401);
  } finally { await app.close(); }
});

test('統合サーバーの保守実行許可APIは参照と変更の両方で管理者認証を要求する', async () => {
  const app = await buildApp({ agentConnectionMaintenance: false });
  try {
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({ method, url: '/v1/manager/maintenance-controls',
        ...(method === 'PUT' ? { payload: { connection: true, media: true } } : {}) });
      assert.equal(response.statusCode, 401);
    }
  } finally { await app.close(); }
});

test('Manager画面と安全側の状態変更APIを公開する', async () => {
  const app = await buildApp();
  try {
    const dashboard = await app.inject({ method: 'GET', url: '/' });
    assert.equal(dashboard.statusCode, 200);
    assert.match(dashboard.payload, /Wentian Control Center/);
    const approval = await app.inject({ method: 'POST', url: '/v1/manager/lifecycle/approval', payload: { provider: 'ollama', model: 'x', action: 'unload' } });
    assert.equal(approval.statusCode, 403);
    const comfy = await app.inject({ method: 'POST', url: '/v1/media/comfyui/jobs', payload: {} });
    assert.equal(comfy.statusCode, 403);
  } finally { await app.close(); }
});

test('旧freeモデルを非推奨として公開する', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    assert.equal(response.statusCode, 200);
    const free = JSON.parse(response.payload).data.find((model: any) => model.id === 'wentian-auto/free');
    assert.equal(free.deprecated, true);
  } finally { await app.close(); }
});

test('Control Center用の外部エージェント状態APIを公開する', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/manager/external-agents' });
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.payload);
    // 登録数は拡張されるため、固定の旧件数ではなく一覧と集計の整合性を確認します。
    assert.ok(payload.agents.length > 0);
    assert.equal(payload.summary.total, payload.agents.length);
    assert.equal(new Set(payload.agents.map((agent: any) => agent.id)).size, payload.agents.length);
    assert.ok(payload.agents.some((agent: any) => agent.id === 'goose'));
  } finally { await app.close(); }
});

test('Plugin Runtimeの構成と現在のService Providerを公開する', async () => {
  const app = await buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/manager/plugins' });
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.payload);
    assert.ok(payload.plugins.some((plugin: any) => plugin.id === 'core.repair' && plugin.kind === 'repair'));
    assert.ok(payload.services.some((service: any) => service.key === 'wentian.repair.planner' && service.provider === 'core.repair'));
    assert.ok(payload.events.some((event: any) => event.type === 'plugin.loaded'));
  } finally { await app.close(); }
});

test('人気度候補APIと既定無効のインストールAPIを公開する', async () => {
  const app = await buildApp();
  try {
    const plan = await app.inject({ method: 'POST', url: '/v1/manager/agent-install/plan', payload: { agentId: 'crush' } });
    assert.equal(plan.statusCode, 200);
    assert.equal(JSON.parse(plan.payload).changesLocalMachine, true);
    const approval = await app.inject({ method: 'POST', url: '/v1/manager/agent-install/approval', payload: { agentId: 'crush' } });
    assert.equal(approval.statusCode, 403);
  } finally { await app.close(); }
});

test('MCPは明示有効時だけ公開し、要求側のowner指定を採用しない', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-mcp-http-'));
  const beforeMcp = process.env.WENTIAN_ENABLE_MCP;
  const beforeA2a = process.env.WENTIAN_ENABLE_EXPERIMENTAL_A2A;
  const beforeRoot = process.env.WENTIAN_TASK_ROOT;
  process.env.WENTIAN_ENABLE_MCP = 'true';
  delete process.env.WENTIAN_ENABLE_EXPERIMENTAL_A2A;
  process.env.WENTIAN_TASK_ROOT = root;
  const app = await buildApp();
  try {
    const initialized = await app.inject({ method: 'POST', url: '/mcp', headers: { accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } } } });
    assert.equal(initialized.statusCode, 200);
    assert.equal(JSON.parse(initialized.payload).result.serverInfo.name, 'wentian-gateway');
    const sessionHeaders = { accept: 'application/json, text/event-stream', 'mcp-session-id': String(initialized.headers['mcp-session-id']), 'mcp-protocol-version': JSON.parse(initialized.payload).result.protocolVersion };
    await app.inject({ method: 'POST', url: '/mcp', headers: sessionHeaders, payload: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    const submitted = await app.inject({ method: 'POST', url: '/mcp', headers: { ...sessionHeaders, 'x-wentian-owner-id': 'attacker' },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wentian_submit_task', arguments: { prompt: 'HTTP結合テスト', ownerId: 'attacker' } } } });
    const taskId = JSON.parse(JSON.parse(submitted.payload).result.content[0].text).task_id;
    const task = await app.inject({ method: 'POST', url: '/mcp', headers: { ...sessionHeaders, 'x-wentian-owner-id': 'different' },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wentian_get_task', arguments: { task_id: taskId } } } });
    assert.equal(JSON.parse(JSON.parse(task.payload).result.content[0].text).status, 'queued');
    assert.equal((await app.inject({ method: 'GET', url: '/a2a/.well-known/agent-card' })).statusCode, 404);
  } finally {
    await app.close();
    if (beforeMcp === undefined) delete process.env.WENTIAN_ENABLE_MCP; else process.env.WENTIAN_ENABLE_MCP = beforeMcp;
    if (beforeA2a === undefined) delete process.env.WENTIAN_ENABLE_EXPERIMENTAL_A2A; else process.env.WENTIAN_ENABLE_EXPERIMENTAL_A2A = beforeA2a;
    if (beforeRoot === undefined) delete process.env.WENTIAN_TASK_ROOT; else process.env.WENTIAN_TASK_ROOT = beforeRoot;
    await rm(root, { recursive: true, force: true });
  }
});
