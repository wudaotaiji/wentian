import assert from 'node:assert/strict';
import test from 'node:test';
import { createAIRepairPlan, fallbackRepairPlan, validateRepairPlan, type RepairPlannerInput } from './agent-repair-planner.js';

/** テストごとの差分を小さく保つため、安全なOpenCode障害を基準入力として生成します。 */
function input(overrides: Partial<RepairPlannerInput> = {}): RepairPlannerInput {
  return {
    agent: 'opencode', role: 'reviewer', failureKind: 'provider', failureSummary: 'Unexpected server error',
    attempt: 1, isolatedWorkspace: false, allowedModels: ['opencode/nemotron-3.5-lightning-free'], ...overrides,
  };
}

test('AIが提案した許可済みOpenCodeモデルだけを採用する', () => {
  const plan = validateRepairPlan({ action: 'switch_model', model: 'opencode/nemotron-3.5-lightning-free', rationale: 'Providerを迂回します。' }, input());
  assert.deepEqual(plan, { version: '1.0', source: 'ai', action: 'switch_model', model: 'opencode/nemotron-3.5-lightning-free', rationale: 'Providerを迂回します。' });
});

test('AIが許可一覧外モデルを提案してもhandoffへ縮退する', () => {
  const plan = validateRepairPlan({ action: 'switch_model', model: 'unknown/unsafe', rationale: '切替' }, input());
  assert.equal(plan.action, 'handoff');
  assert.equal(plan.model, undefined);
});

test('認証エラーではAIの再試行提案を拒否する', () => {
  const plan = validateRepairPlan({ action: 'retry_same', rationale: '再試行' }, input({ failureKind: 'authentication' }));
  assert.equal(plan.action, 'handoff');
});

test('初回TimeoutでAIがhandoffを提案しても安全な再試行へ補正する', () => {
  assert.equal(validateRepairPlan({ action: 'handoff', rationale: '停止' }, input({ agent: 'kilo', failureKind: 'timeout', allowedModels: [] })).action, 'retry_same');
  assert.equal(validateRepairPlan({ action: 'handoff', rationale: '停止' }, input({ agent: 'opencode', failureKind: 'timeout' })).action, 'switch_model');
});

test('権限の自動承認は隔離Workspace内の対応Agentだけに限定する', () => {
  assert.equal(fallbackRepairPlan(input({ agent: 'kilo', failureKind: 'permission', isolatedWorkspace: true, allowedModels: [] })).action, 'enable_workspace_auto_approval');
  assert.equal(fallbackRepairPlan(input({ agent: 'kilo', failureKind: 'permission', isolatedWorkspace: false, allowedModels: [] })).action, 'handoff');
});

test('Runtime依存欠落ではダウンロードよりWentian内部資源を優先する', () => {
  const plan = fallbackRepairPlan(input({ agent: 'openclaw', failureKind: 'runtime_dependency', allowedModels: [], allowedInternalResources: ['core.runner.external-agent-handoff'] }));
  assert.equal(plan.action, 'use_internal_resource');
  assert.equal(plan.resource, 'core.runner.external-agent-handoff');
});

test('AIが未登録の内部資源を提案しても許可済み内部資源へ正規化する', () => {
  const plan = validateRepairPlan({ action: 'use_internal_resource', resource: 'unknown.module', rationale: '代替' }, input({ failureKind: 'runtime_dependency', allowedInternalResources: ['core.runner.external-agent-handoff'] }));
  assert.equal(plan.action, 'use_internal_resource');
  assert.equal(plan.resource, 'core.runner.external-agent-handoff');
});

test('AIがhandoffを提案してもRuntime依存欠落では内部資源を優先する', () => {
  const plan = validateRepairPlan({ action: 'handoff', rationale: '次へ' }, input({ failureKind: 'runtime_dependency', allowedInternalResources: ['core.runner.external-agent-handoff'] }));
  assert.equal(plan.action, 'use_internal_resource');
});

test('Planner APIの構造化応答をPolicy検証してAI計画にする', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"switch_model","model":"opencode/nemotron-3.5-lightning-free","rationale":"障害状況に適合"}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const plan = await createAIRepairPlan(input(), 'http://127.0.0.1:8787');
    assert.equal(plan.source, 'ai');
    assert.equal(plan.action, 'switch_model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Planner API障害時も決定論的な安全Fallbackで継続する', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Planner unavailable'); };
  try {
    const plan = await createAIRepairPlan(input(), 'http://127.0.0.1:8787');
    assert.equal(plan.source, 'fallback');
    assert.equal(plan.action, 'switch_model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
