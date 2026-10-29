import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleController, type LifecycleAdapter, type LifecycleTarget } from './lifecycle.js';

function adapter(state: { loaded: boolean; executions: number }): LifecycleAdapter {
  return {
    provider: 'test',
    async plan(target) { return { action: target.action, model: target.model }; },
    async execute(target) { state.executions++; state.loaded = target.action === 'load'; },
    async verify(target) { return state.loaded === (target.action === 'load'); },
  };
}

const target: LifecycleTarget = { provider: 'test', model: 'model-a', action: 'load' };

test('既定の dry-run は状態を変更しない', async () => {
  const state = { loaded: false, executions: 0 };
  const controller = new LifecycleController({ enabled: true, adapters: [adapter(state)] });
  const result = await controller.run(target, { authenticated: true });
  assert.equal(result.executed, false);
  assert.equal(state.executions, 0);
});

test('feature flag、認証、明示承認をすべて要求する', async () => {
  const state = { loaded: false, executions: 0 };
  const disabled = new LifecycleController({ adapters: [adapter(state)] });
  await assert.rejects(disabled.run(target, { authenticated: true, dryRun: false }), /無効/);

  const controller = new LifecycleController({ enabled: true, adapters: [adapter(state)] });
  await assert.rejects(controller.run(target, { authenticated: false, dryRun: false }), /認証/);
  await assert.rejects(controller.run(target, { authenticated: true, dryRun: false }), /承認/);
  const token = controller.issueApproval(target, true);
  const result = await controller.run(target, { authenticated: true, approvalToken: token, dryRun: false });
  assert.deepEqual({ executed: result.executed, verified: result.verified, executions: state.executions }, { executed: true, verified: true, executions: 1 });
  // 承認トークンはリプレイ攻撃（Replay Attack）を防ぐため再利用できない。
  await assert.rejects(controller.run(target, { authenticated: true, approvalToken: token, dryRun: false }), /承認/);
});

test('対象が異なる承認トークンを拒否する', async () => {
  const state = { loaded: false, executions: 0 };
  const controller = new LifecycleController({ enabled: true, adapters: [adapter(state)] });
  const token = controller.issueApproval(target, true);
  await assert.rejects(controller.run({ ...target, model: 'model-b' }, { authenticated: true, approvalToken: token, dryRun: false }), /承認/);
});
