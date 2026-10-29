import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp, providers } from './server.js';

/** ゲートウェイ（Gateway）の実HTTP経路を通し、実サービスや外部CLIは呼び出しません。 */
async function fixture(run: (app: Awaited<ReturnType<typeof buildApp>>, calls: Array<Record<string, any>>) => Promise<void>, price = false, retired = false) {
  const savedFetch = globalThis.fetch;
  const original = providers.map(provider => provider.enabled);
  for (const provider of providers) provider.enabled = false;
  const provider = { id: retired ? 'retiredfixture' : 'runtimefixture', name: '検証用', kind: 'llm' as const, scope: 'remote' as const,
    baseUrl: 'http://127.0.0.1:29999/v1', enabled: true, autoRoute: true, priority: 1, tags: [],
    modelProfiles: { a: { capabilities: { coding: 0.7 } }, b: { capabilities: { coding: 0.95 } } },
    ...(price ? { tokenPrice: { inputPerMillion: 1, outputPerMillion: 1 } } : {}) };
  providers.push(provider);
  const calls: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_url, init) => {
    if (String(_url).endsWith('/models')) return Response.json({ data: [{ id: 'a', loaded: true }, { id: 'b', loaded: false }] });
    const body = JSON.parse(String(init?.body)); calls.push(body);
    if (retired && body.model === 'a') return Response.json({ error: { message: 'model-a was retired at 2026-09-25' } }, { status: 410 });
    return Response.json({ choices: [{ message: { content: body.model === 'a' ? '' : 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: body.model === 'a' ? 0 : 2, total_tokens: body.model === 'a' ? 10 : 12 } });
  }) as typeof fetch;
  const app = await buildApp({ agentConnectionMaintenance: false });
  try { await app.inject({ method: 'POST', url: '/v1/manager/unload-plan', payload: {} }); await run(app, calls); }
  finally { await app.close(); providers.pop(); providers.forEach((item, index) => item.enabled = original[index]); globalThis.fetch = savedFetch; }
}

test('空回答を検出すると登録能力が高いモデルへ昇格（Escalation）し、制御フィールドを転送しない', async () => {
  await fixture(async (app, calls) => {
    const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'wentian-auto/remote', wentian_task: 'coding', max_tokens: 16, messages: [{ role: 'user', content: '検証' }] } });
    assert.equal(result.statusCode, 200); assert.deepEqual(calls.map(call => call.model), ['a', 'b']);
    assert.equal(result.json().wentian.resolved_model, 'runtimefixture/b');
    assert.equal(calls[0].wentian_task, undefined); assert.equal(calls[0].max_tokens, 16);
    assert.match(result.json().wentian.request_id, /^[0-9a-f-]{36}$/);
    const performance = (await app.inject({ method: 'GET', url: '/v1/manager/performance' })).json().data;
    assert.equal(performance.find((item: any) => item.model === 'runtimefixture/a' && item.task === 'coding').successRate, 0);
    // 管理サイトの表示用APIにも同じ実行結果と選択理由が届きます。本文は公開しません。
    const overview = (await app.inject('/v1/manager/control-plane')).json();
    assert.equal(overview.features.find((item: any) => item.id === 'gpu').status, '環境制約');
    const observations = (await app.inject('/v1/manager/observations')).json().data;
    assert.ok(observations.some((item: any) => item.requestId === result.json().wentian.request_id));
    assert.ok(observations.every((item: any) => item.content === undefined));
    const recent = (await app.inject('/v1/routing/recent')).json().data;
    assert.equal(recent[0].decision.budget.attempts, 2);
    assert.match(recent[0].decision.reason, /切り替え/);
  });
});

test('提供終了（Retired）の410は自動切替し、以降の候補と画面選択から除外する', async () => {
  await fixture(async (app, calls) => {
    const payload = { model: 'wentian-auto/remote', wentian_task: 'coding', max_tokens: 16, messages: [{ role: 'user', content: 'こんにちは' }] };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', payload })).statusCode, 200);
    assert.deepEqual(calls.map(call => call.model), ['a', 'b']);
    const listed = (await app.inject('/v1/models')).json().data;
    assert.equal(listed.find((model: any) => model.id === 'retiredfixture/a').available, false);
    calls.length = 0;
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', payload })).statusCode, 200);
    assert.deepEqual(calls.map(call => call.model), ['b']);
    const explicit = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { ...payload, model: 'retiredfixture/a' } });
    assert.equal(explicit.statusCode, 410);
    assert.match(explicit.json().error.message, /retired/);
    assert.ok((await app.inject('/v1/manager/events')).json().data.some((event: any) => event.action === 'model_retired'));
  }, false, true);
});

test('試行回数予算（Attempt Budget）が1なら品質不合格後の2件目を呼び出さない', async () => {
  await fixture(async (app, calls) => {
    const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'wentian-auto/remote', wentian_task: 'coding', wentian_budget: { maxAttempts: 1 }, messages: [{ role: 'user', content: '検証' }] } });
    assert.equal(result.statusCode, 422); assert.equal(result.json().error.code, 'execution_budget_exhausted'); assert.equal(calls.length, 1);
  });
});

test('費用上限（Cost Budget）を指定すると未登録単価の推論を開始しない', async () => {
  await fixture(async (app, calls) => {
    const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'runtimefixture/b', wentian_budget: { maxCostUsd: 0.001 }, messages: [{ role: 'user', content: '検証' }] } });
    assert.equal(result.statusCode, 422); assert.equal(calls.length, 0);
  });
});

test('ローカル・旧free・無料Agent限定は条件外のLLMやCodexへ切り替えない', async () => {
  await fixture(async (app, calls) => {
    for (const model of ['wentian-auto/local', 'wentian-auto/free', 'wentian-auto/free-agents']) {
      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model, messages: [{ role: 'user', content: '你好！' }] } });
      assert.equal(response.statusCode, 503);
      assert.equal(response.json().error.code, 'no_models');
      assert.match(response.json().error.message, /切り替えていません/);
    }
    assert.equal(calls.length, 0);
  });
});

test('既知単価の推論は実使用量で費用（Cost）を精算し、最終応答へ返す', async () => {
  await fixture(async (app, calls) => {
    const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'runtimefixture/b', max_completion_tokens: 16, wentian_budget: { maxCostUsd: 0.001 }, messages: [{ role: 'user', content: '検証' }] } });
    assert.equal(result.statusCode, 200); assert.equal(calls[0].max_tokens, undefined); assert.equal(calls[0].max_completion_tokens, 16);
    assert.ok(Math.abs(result.json().wentian.cost_usd - 0.000012) < 1e-12); assert.equal(result.json().wentian.budget_tokens, 12);
  }, true);
});
