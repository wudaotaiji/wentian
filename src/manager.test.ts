import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CircuitBreaker,
  MetricsRegistry,
  estimateModelRuntimeBytes,
  evaluateModelSafety,
  planUnload,
  rankModelCandidates,
  parseVendorMemoryJson,
  estimateRequestMemoryBytes,
  startRequestMeasurement,
  type ManagedModel,
  type MemorySnapshot,
} from './manager.js';
import { StreamUsageObserver } from './proxy.js';

test('アプリGPU予約をAIの入場判断へ反映し、実測値と予約値を混同しない',()=>{
 const bytes=1024**3,model:ManagedModel={id:'p/gpu',provider:'p',providerModelId:'gpu',loaded:false,estimatedRuntimeBytes:2*bytes};
 const snapshot:MemorySnapshot={observedAt:'',ram:{totalBytes:8*bytes,freeBytes:0,usedBytes:8*bytes},gpus:[{index:0,name:'GPU',totalBytes:8*bytes,freeBytes:8*bytes,usedBytes:0}],warnings:[]};
 assert.equal(evaluateModelSafety(model,snapshot).level,'safe');
 const reserved={...snapshot,gpus:[{...snapshot.gpus[0],reservedBytes:7*bytes}]};assert.equal(evaluateModelSafety(model,reserved).level,'blocked');assert.equal(reserved.gpus[0].freeBytes,8*bytes);assert.equal(reserved.gpus[0].usedBytes,0);
});

test('ロード済みでも長いコンテキスト（Context）の追加メモリを評価する', () => {
  const model: ManagedModel = { id: 'p/loaded', provider: 'p', providerModelId: 'loaded', loaded: true };
  assert.equal(estimateRequestMemoryBytes(model, { task: 'general', minimumContextTokens: 100 }), 100 * 256 * 1024);
  assert.equal(evaluateModelSafety(model, memory, undefined, { task: 'general', minimumContextTokens: 131072 }).level, 'blocked');
  assert.equal(evaluateModelSafety(model, { ...memory, gpus: [] }, undefined, { task: 'general', minimumContextTokens: 131072 }).level, 'blocked');
});

test('必須能力不足のモデルは低順位ではなく除外される', () => {
  const model: ManagedModel = { id: 'p/a', provider: 'p', providerModelId: 'a', loaded: true };
  assert.equal(rankModelCandidates([model], memory, { task: 'tool', requiresTool: true })[0].safety.level, 'blocked');
});

test('同じタスクの実測3件から速い候補を優先する', () => {
  const registry = new MetricsRegistry();
  const models: ManagedModel[] = ['a', 'b'].map(id => ({ id: `p/${id}`, provider: 'p', providerModelId: id, loaded: true, capabilities: { coding: 0.9 } }));
  for (let i = 0; i < 3; i++) for (const model of models) registry.record({ provider: 'p', model: model.id, task: 'coding', startedAt: '', latencyMs: model.providerModelId === 'a' ? 10000 : 1000, success: true });
  assert.equal(rankModelCandidates(models, memory, { task: 'coding', performance: registry })[0].model.id, 'p/b');
  assert.equal(rankModelCandidates(models, memory, { task: 'reasoning', performance: registry })[0].model.id, 'p/a');
});

test('品質予算（Quality Budget）は能力と速度の重みを変える', () => {
  const registry = new MetricsRegistry();
  const models: ManagedModel[] = [
    { id: 'p/fast', provider: 'p', providerModelId: 'fast', loaded: true, capabilities: { coding: 0.7 } },
    { id: 'p/strong', provider: 'p', providerModelId: 'strong', loaded: true, capabilities: { coding: 0.9 } },
  ];
  for (let i = 0; i < 3; i++) for (const model of models) registry.record({ provider: 'p', model: model.id, task: 'coding', startedAt: '', latencyMs: model.providerModelId === 'fast' ? 100 : 10000, success: true });
  assert.equal(rankModelCandidates(models, memory, { task: 'coding', quality: 'economy', difficulty: 0.1, performance: registry })[0].model.id, 'p/fast');
  assert.equal(rankModelCandidates(models, memory, { task: 'coding', quality: 'max', difficulty: 0.9, performance: registry })[0].model.id, 'p/strong');
});

test('初回トークン時間（TTFT）は制御イベントを除外し終了を二重記録しない', () => {
  let count = 0;
  const observer = new StreamUsageObserver(() => count++);
  observer.push(Buffer.from('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
  assert.equal(count, 0);
  observer.push(Buffer.from('data: {"choices":[{"delta":{"content":"あ"}}'));
  observer.push(Buffer.from(']}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'));
  assert.equal(count, 1);
  assert.equal(observer.usage?.completion_tokens, 2);
  const registry = new MetricsRegistry();
  const measurement = startRequestMeasurement('p', 'm', registry, 'coding');
  measurement.finish(true, undefined, observer.usage);
  measurement.finish(false, '重複通知');
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].outputTokens, 2);
  assert.equal(registry.list()[0].ttftMs, undefined);
});

const GiB = 1024 ** 3;
const memory: MemorySnapshot = {
  observedAt: new Date(0).toISOString(),
  ram: { totalBytes: 32 * GiB, freeBytes: 16 * GiB, usedBytes: 16 * GiB },
  gpus: [{ index: 0, name: 'test', totalBytes: 16 * GiB, freeBytes: 12 * GiB, usedBytes: 4 * GiB }],
  warnings: [],
};

test('モデルサイズをモデル名と実ファイルサイズから推定できる', () => {
  assert.ok(estimateModelRuntimeBytes({ providerModelId: 'model-14b-q4' }) > 8 * GiB);
  assert.ok(estimateModelRuntimeBytes({ providerModelId: 'x', sizeBytes: 4 * GiB }) > 4 * GiB);
});

test('AMDとIntelのVRAM JSONを安全に正規化する', () => {
  const amd = parseVendorMemoryJson(JSON.stringify({card0:{'VRAM Total Memory (B)':17179869184,'VRAM Total Used Memory (B)':4294967296}}),'amd');
  assert.equal(amd[0].freeBytes,12884901888);
  const intel = parseVendorMemoryJson(JSON.stringify({device_level:[{'GPU Memory Total (MiB)':16384,'GPU Memory Used (MiB)':2048}]}),'intel');
  assert.equal(intel[0].freeBytes,14336*1024**2);
});

test('安全余裕を差し引いて Safe と Blocked を評価する', () => {
  const small: ManagedModel = { id: 'p/s', provider: 'p', providerModelId: 's', loaded: false, estimatedRuntimeBytes: 2 * GiB };
  const huge: ManagedModel = { id: 'p/h', provider: 'p', providerModelId: 'h', loaded: false, estimatedRuntimeBytes: 40 * GiB };
  assert.equal(evaluateModelSafety(small, memory).level, 'safe');
  assert.equal(evaluateModelSafety(huge, memory).level, 'blocked');
});

test('ロード済みかつ能力要件を満たすモデルを上位にする', () => {
  const models: ManagedModel[] = [
    { id: 'p/a', provider: 'p', providerModelId: 'a', loaded: false, estimatedRuntimeBytes: GiB, capabilities: { coding: 0.9 } },
    { id: 'p/b', provider: 'p', providerModelId: 'b', loaded: true, capabilities: { coding: 0.8 } },
  ];
  assert.equal(rankModelCandidates(models, memory, { task: 'coding' })[0].model.id, 'p/b');
});

test('アンロードは実行せず明示承認付き計画だけを返す', () => {
  const model: ManagedModel = { id: 'p/a', provider: 'p', providerModelId: 'a', loaded: true, estimatedRuntimeBytes: GiB };
  const plan = planUnload([model]);
  assert.equal(plan.requiresExplicitApproval, true);
  assert.deepEqual(plan.candidates.map((item) => item.id), ['p/a']);
});

test('サーキットブレーカーは閾値後に遮断し、冷却後に Half-open へ移る', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, halfOpenSuccessThreshold: 1 });
  breaker.recordFailure('p', 0);
  breaker.recordFailure('p', 1);
  assert.equal(breaker.canRequest('p', 50), false);
  assert.equal(breaker.canRequest('p', 101), true);
  breaker.recordSuccess('p');
  assert.equal(breaker.status('p').state, 'closed');
});

test('メトリクス集計は成功率、Latency、TTFT を返す', () => {
  const registry = new MetricsRegistry();
  registry.record({ provider: 'p', model: 'm', startedAt: new Date(0).toISOString(), latencyMs: 100, ttftMs: 20, success: true });
  registry.record({ provider: 'p', model: 'm', startedAt: new Date(0).toISOString(), latencyMs: 300, success: false });
  assert.deepEqual(registry.summary(), { count: 2, successRate: 0.5, averageLatencyMs: 200, averageTtftMs: 20 });
});
