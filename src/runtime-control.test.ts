import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionBudget, parseExecutionLimits, BudgetExceededError } from './execution-budget.js';
import { MetricsRegistry, estimateRequestMemoryBytes, type ManagedModel, type MemorySnapshot } from './manager.js';
import { JsonlEventStore } from './storage.js';
import { persistRequestMetric, restoreRuntimeMetrics } from './runtime-telemetry.js';
import { ModelResidencyManager } from './model-residency.js';
import { LmStudioLifecycleAdapter, type LifecycleAdapter } from './lifecycle.js';
import { independentVerifier } from './model-diversity.js';
import { evaluateModelResponse } from './model-evaluator.js';
import { runModelBenchmark } from './model-benchmark.js';
import { rankModelCandidates, predictModelLatency, recommendModelPool } from './router.js';

const GiB = 1024 ** 3;
const memory: MemorySnapshot = { observedAt: '', ram: { totalBytes: 32 * GiB, freeBytes: 24 * GiB, usedBytes: 8 * GiB }, gpus: [], warnings: [] };

test('永続テレメトリー（Persistent Telemetry）は数値使用量と評価を復元し秘密値を保存しない', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-telemetry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonlEventStore({ path: path.join(root, 'events.jsonl') });
  await persistRequestMetric(store, { provider: 'p', model: 'p/a', requestId: 'unique-a', task: 'coding', startedAt: new Date().toISOString(), latencyMs: 300, ttftMs: 100, promptTokens: 20, outputTokens: 10, success: true });
  await store.append({ kind: 'metric', action: 'model_evaluation', detail: { requestId: 'unique-a', accepted: false, apiKey: '秘密値', outputTokens: '秘密値' } });
  const registry = new MetricsRegistry(1000, () => assert.fail('復元時に再追記しません。'));
  assert.equal(await restoreRuntimeMetrics(store, registry), 1);
  const [metric] = registry.list();
  assert.equal(metric.promptTokens, 20); assert.equal(metric.outputTokens, 10); assert.equal(metric.qualityAccepted, false);
  const events = await store.list();
  assert.equal(events[1].detail?.apiKey, undefined); assert.equal(events[1].detail?.outputTokens, undefined);
  assert.equal(await restoreRuntimeMetrics(store, registry), 1);
});

test('予算（Budget）は試行を共有し不明使用量を予約のまま残す', () => {
  const budget = new ExecutionBudget(parseExecutionLimits({ maxTokens: 100, maxAttempts: 2, maxCostUsd: 0.1 }));
  const price = { inputPerMillion: 1, outputPerMillion: 2 };
  const first = budget.reserve(20, 30, price); first.settle({ prompt_tokens: 10, completion_tokens: 10 }); first.settle({ prompt_tokens: 0, completion_tokens: 0 });
  assert.equal(budget.tokens, 20);
  budget.reserve(20, 30, price).settle(); assert.equal(budget.tokens, 70);
  assert.throws(() => budget.reserve(1, 1, price), BudgetExceededError);
  assert.throws(() => new ExecutionBudget(parseExecutionLimits({ maxCostUsd: 0 })).reserve(1, 1), /単価未登録/);
  assert.throws(() => parseExecutionLimits({ maxRuntimeMs: -1 }), /不正/);
  assert.equal(parseExecutionLimits({ maxAttempts: 100 }).maxAttempts, 3);
});

test('費用・時間・再計画予算（Cost / Time / Replan Budget）を超えて実行しない', () => {
  let now = 0;
  const budget = new ExecutionBudget(parseExecutionLimits({ maxRuntimeMs: 10, maxReplans: 1, maxCostUsd: 0.00001 }), () => now);
  assert.throws(() => budget.reserve(100, 100, { inputPerMillion: 1, outputPerMillion: 1 }), /費用/);
  budget.replan(); assert.throws(() => budget.replan(), /再計画/);
  now = 10; assert.throws(() => budget.check(), /実行時間/);
});

function fixtureResidency() {
  const models: ManagedModel[] = ['a', 'b', 'external'].map(id => ({ id: `p/${id}`, provider: 'p', providerModelId: id, loaded: id === 'external', estimatedRuntimeBytes: 8 * GiB }));
  const actions: string[] = [];
  const adapter: LifecycleAdapter = { provider: 'p', plan: async () => ({}), execute: async target => {
    actions.push(`${target.action}:${target.model}`); models.find(model => model.providerModelId === target.model)!.loaded = target.action === 'load';
  }, verify: async () => true };
  const residency = new ModelResidencyManager({ enabled: true, adapters: [adapter], snapshot: async () => ({ models,
    memory: { ...memory, ram: { ...memory.ram, freeBytes: 24 * GiB - models.filter(model => model.loaded).length * 8 * GiB } } }) });
  return { residency, models, actions };
}

test('駐留（Residency）は時間予算終了後のロードを拒否し、期限切れの所有モデルだけを退避する', async () => {
  const { residency, actions, models } = fixtureResidency();
  await assert.rejects(() => residency.acquire('p/a', { task: 'general' }, undefined, () => 0), /時間予算/);
  assert.deepEqual(actions, []);
  await residency.preload('p/a', { task: 'general' });
  await residency.sweep(Date.now() + 301_000);
  assert.deepEqual(actions, ['load:a', 'unload:a']);
  assert.equal(models[2].loaded, true);
});

test('駐留（Residency）は稼働中・外部ロード済みモデルを保護し、解放後にLRU退避する', async () => {
  const { residency, actions, models } = fixtureResidency();
  const release = await residency.acquire('p/a', { task: 'general' });
  await assert.rejects(() => residency.acquire('p/b', { task: 'general' }), /不足/);
  assert.deepEqual(actions, ['load:a']);
  release(); release();
  await residency.preload('p/b', { task: 'general' });
  assert.deepEqual(actions, ['load:a', 'unload:a', 'load:b']);
  assert.equal(models[2].loaded, true); assert.deepEqual(residency.status().active, {});
});

test('駐留（Residency）の同一モデル並行リースは一度だけロードし、中断済み要求をロードしない', async () => {
  const { residency, actions } = fixtureResidency();
  const [first, second] = await Promise.all([residency.acquire('p/a', { task: 'general' }), residency.acquire('p/a', { task: 'general' })]);
  assert.deepEqual(actions, ['load:a']); assert.equal(residency.status().active['p/a'], 2);
  first(); assert.equal(residency.status().active['p/a'], 1); second();
  await assert.rejects(() => residency.acquire('p/b', { task: 'general' }, AbortSignal.abort()), /abort/i);
  assert.deepEqual(actions, ['load:a']);
});

test('ロード済みのキャッシュ（KV Cache）は追加成長分だけを見積もる', () => {
  const model: ManagedModel = { id: 'p/a', provider: 'p', providerModelId: 'a', loaded: true, metadata: { kvBytesPerToken: 65536, residentContextTokens: 4096 } };
  assert.equal(estimateRequestMemoryBytes(model, { task: 'general', promptTokens: 2000, maxOutputTokens: 1000 }), 0);
  assert.equal(estimateRequestMemoryBytes(model, { task: 'general', promptTokens: 4096, maxOutputTokens: 1000 }), 65536000);
});

test('LM Studioの退避は自分のインスタンス（Instance）だけを指定する', async () => {
  const saved = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let loaded = false;
  globalThis.fetch = (async (_url, init) => { if (init?.body) bodies.push(JSON.parse(String(init.body))); if(String(_url).endsWith('/load')){loaded=true;return Response.json({instance_id:'owned'})}if(String(_url).endsWith('/unload')){loaded=false;return Response.json({instance_id:'owned'})}return Response.json({models:[{key:'a',loaded_instances:loaded?[{id:'owned'},{id:'external'}]:[{id:'external'}]}]}) }) as typeof fetch;
  try {
    const adapter = new LmStudioLifecycleAdapter('p', 'http://localhost:1234/v1');
    const target = { provider: 'p', model: 'a', action: 'load' as const, contextTokens: 4096 };
    await assert.rejects(() => adapter.execute({ ...target, action: 'unload' }, 100), /他アプリ/);
    await adapter.execute(target, 100); assert.equal(await adapter.verify(target, 100), true);
    await adapter.execute({ ...target, action: 'unload' }, 100); assert.equal(await adapter.verify({ ...target, action: 'unload' }, 100), true);
    assert.deepEqual(bodies[1], { instance_id: 'owned' });
  } finally { globalThis.fetch = saved; }
});

test('最終検証（Verifier）は同じモデル・同じファミリー・実モデル不明を拒否する', () => {
  assert.equal(independentVerifier('qwen', 'qwen'), false);
  assert.equal(independentVerifier('a', 'b', { a: 'qwen', b: 'qwen' }), false);
  assert.equal(independentVerifier('a', undefined), false);
  assert.equal(independentVerifier('a', 'kilo/kilo-auto/free'), false);
  assert.equal(independentVerifier('qwen', 'deepseek'), true);
});

test('応答評価（Evaluation）は空回答・不正JSON・打ち切りを検出しツール応答を認める', () => {
  assert.equal(evaluateModelResponse({ choices: [{ message: { content: '' } }] }).passed, false);
  assert.equal(evaluateModelResponse({ choices: [{ message: { content: '不正' } }] }, true).passed, false);
  assert.equal(evaluateModelResponse({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }).passed, false);
  assert.equal(evaluateModelResponse({ choices: [{ message: { tool_calls: [{ id: '1' }] } }] }).passed, true);
});

test('固定評価（Benchmark）はモデルの自己申告でなく既知の答えを照合する', async () => {
  const answers = ['WENTIAN_BENCH_OK', '999', '14'];
  const results = await runModelBenchmark('p/a', async () => ({ choices: [{ message: { content: JSON.stringify({ answer: answers.shift() }) } }] }));
  assert.deepEqual(results.map(result => result.accepted), [true, false, true]);
});

test('速度予測（Runtime Prediction）は最大出力長に合わせ、推薦は実測不足を明記する', () => {
  const registry = new MetricsRegistry();
  for(let i=0;i<3;i++)registry.record({provider:'p',model:'p/a',task:'coding',startedAt:'',latencyMs:1100,ttftMs:100,outputTokens:10,success:true});
  assert.equal(predictModelLatency('p/a',{task:'coding',maxOutputTokens:20,performance:registry}),2100);
  const model:ManagedModel={id:'p/a',provider:'p',providerModelId:'a',loaded:true,capabilities:{coding:0.9}};
  const recommendations=recommendModelPool([model],memory,registry);
  assert.equal(recommendations.find(row=>row.task==='coding')!.candidates[0].evidence,'measured');
  assert.equal(recommendations.find(row=>row.task==='general')!.candidates[0].evidence,'capability_only');
  for(let i=0;i<3;i++)registry.record({provider:'p',model:'p/a',task:'coding',startedAt:'',latencyMs:10,success:true,qualityAccepted:false});
  assert.ok(rankModelCandidates([model],memory,{task:'coding',performance:registry})[0].scoreReasons.some(reason=>reason.includes('受入')));
});
