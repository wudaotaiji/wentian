import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWithExternalAgent } from './planner-fallback.js';
import { createAgentPlan } from './agent-planner.js';
import { buildReadySnapshot } from './external-agent-readiness.js';

function snapshot() {
  return buildReadySnapshot({ source: '試験', agents: ['kilo', 'opencode'].map(id => ({ id, name: id, state: 'available' as const, stateLabel: '正常', note: '', freshWithin24Hours: true, liveState: 'healthy' as const })), cacheFreshWithin24Hours: true, summary: { total: 2, available: 2, candidate: 0, unavailable: 0, needs_recheck: 0 } }, 300000);
}

test('分類はKiloの不正出力を同一Agentで再分類し、失敗後にOpenCodeへ切替し、専用作業場所と中断信号を渡す', async () => {
  const calls: string[] = [], prompts: string[] = [], controller = new AbortController();
  const result = await classifyWithExternalAgent('分類規則', '你好！', (raw, agent) => ({ agent, value: JSON.parse(raw) }), controller.signal, {
    snapshot: async () => snapshot(), command: (agent, prompt, workspace) => { assert.ok(prompt.includes('你好！')); assert.notEqual(workspace, process.cwd()); prompts.push(prompt); return { executable: agent, args: [] }; },
    run: async (_command, options) => { assert.equal(options.signal, controller.signal); calls.push(options.agent); return options.agent === 'kilo' ? '不正JSON' : '{"intent":"chat"}'; },
  });
  // 検証理由を同じKiloへ返して再分類し、それでも失敗した時にOpenCodeへ切り替えます。
  assert.deepEqual(calls, ['kilo', 'kilo', 'opencode']); assert.equal(result.agent, 'opencode');
  assert.ok(prompts.filter(prompt => prompt.includes('再分類')).length >= 1);
});

test('検証エラーの理由を同じAgentへ返し、スキーマ違反をAI自身に修正させて採用する', async () => {
  const prompts: string[] = [];
  const result = await classifyWithExternalAgent('分類規則', 'この端末のclaudeを最新バージョンにして', (raw, agent) => {
    const value = JSON.parse(raw);
    if (value.evidence_source === 'runtime' && !Array.isArray(value.runtime_requirements)) throw new Error('実環境の取得に必要なruntime_requirementsを1～4件指定してください。');
    return { agent, value };
  }, undefined, {
    snapshot: async () => snapshot(),
    command: (agent, prompt) => { prompts.push(prompt); return { executable: agent, args: [] }; },
    run: async (_command, options) => options.agent === 'kilo'
      ? (prompts.some(prompt => prompt.includes('runtime_requirementsを1～4件'))
        ? '{"intent":"local_tool","operation":"read","evidence_source":"runtime","runtime_requirements":[{"tool":"run_command"}]}'
        : '{"intent":"local_tool","operation":"read","evidence_source":"runtime"}')
      : '{"intent":"chat"}',
  });
  assert.equal(result.agent, 'kilo'); assert.equal(result.value.evidence_source, 'runtime');
  assert.ok(prompts.some(prompt => prompt.includes('runtime_requirementsを1～4件')));
});

test('古いキャッシュ・不健康候補・中断では分類代替を実行しない', async () => {
  const old = snapshot(); old.refreshedAt = '2000-01-01T00:00:00Z';
  const run = async () => { throw new Error('起動禁止'); };
  await assert.rejects(classifyWithExternalAgent('', '', raw => JSON.parse(raw), undefined, { snapshot: async () => old, run }), /キャッシュ/);
  const unhealthy = snapshot(); unhealthy.agents.forEach(agent => { agent.liveState = 'probe_failed'; });
  await assert.rejects(classifyWithExternalAgent('', '', raw => JSON.parse(raw), undefined, { snapshot: async () => unhealthy, run }), /候補なし/);
  const controller = new AbortController(); controller.abort(new Error('利用者中断'));
  await assert.rejects(classifyWithExternalAgent('', '', raw => JSON.parse(raw), controller.signal, { snapshot: async () => snapshot(), run }), /利用者中断/);
});

test('503時の分類代替にも同じ検証と実行方式制約を適用し、認証と予算は回避しない', async () => {
  const original = globalThis.fetch, previous = process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK;
  process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK = 'true';
  let status = 503, calls = 0, rateLimited = false;
  globalThis.fetch = (async () => Response.json({ error: { message: '利用不可', ...(rateLimited ? { type: 'rate_limit_exceeded' } : {}) } }, { status })) as typeof fetch;
  const dependencies = { classify: (async (_system, _input, validate) => { calls++; return validate(JSON.stringify({ intent: 'chat', operation: 'answer', delegation: { enabled: true }, tools: [] }), 'kilo'); }) as typeof classifyWithExternalAgent };
  try {
    const plan = await createAgentPlan('你好！', 'http://fixture', undefined, { mode: 'direct' }, dependencies);
    assert.deepEqual(plan.classification, { source: 'external', model: 'kilo' }); assert.equal(plan.delegation.enabled, false); assert.equal(plan.text, '你好！');
    status = 401; await assert.rejects(createAgentPlan('你好！', 'http://fixture', undefined, {}, dependencies), /HTTP 401/); assert.equal(calls, 1);
    status = 503; await assert.rejects(createAgentPlan('你好！', 'http://fixture', undefined, { budget: { maxTokens: 10000 } }, dependencies), /HTTP 503/); assert.equal(calls, 1);
    rateLimited = true; await assert.rejects(createAgentPlan('你好！', 'http://fixture', undefined, {}, dependencies), /HTTP 503/); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; if (previous === undefined) delete process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK; else process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK = previous; }
});
