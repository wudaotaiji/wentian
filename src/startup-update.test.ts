import assert from 'node:assert/strict';
import test from 'node:test';
import { checkStartupUpdate } from './startup-update.js';
import type { VersionUpdatePlan } from './version-update.js';

const plan: VersionUpdatePlan = {
  installRoot: '/wentian', currentVersion: '0.5.0', branch: 'main', currentCommit: 'a'.repeat(40),
  remoteCommit: 'b'.repeat(40), relation: 'update_available', updateAvailable: true,
  clean: true, changes: [], checkedAt: new Date().toISOString(), canApply: true,
};

test('起動時の承認で通知したコミットだけを更新し、旧コードの起動を止める', async () => {
  const output: string[] = [];
  let applied = false;
  assert.equal(await checkStartupUpdate({
    check: async () => plan, confirm: async () => true, emit: text => output.push(text),
    apply: async (approval, token, _emit, root) => {
      assert.equal(approval.targetCommit, plan.remoteCommit);
      assert.equal(approval.token, token);
      assert.equal(root, plan.installRoot);
      applied = true;
      return { version: '0.5.1', commit: approval.targetCommit, manifestPath: '/manifest' };
    },
  }), true);
  assert.equal(applied, true);
  assert.match(output.join('\n'), /更新があります/);
  assert.match(output.join('\n'), /更新完了/);
});

test('更新延期時は更新処理を実行せず起動を続ける', async () => {
  assert.equal(await checkStartupUpdate({ check: async () => plan, confirm: async () => false,
    apply: async () => { throw new Error('更新してはいけません'); }, emit: () => {},
  }), false);
});

for (const state of [
  { relation: 'current' as const, updateAvailable: false, canApply: false },
  { relation: 'local_ahead' as const, updateAvailable: false, canApply: false },
  { relation: 'unknown' as const, updateAvailable: false, canApply: false },
  { clean: false, canApply: false, changes: ['M local.ts'] },
]) {
  test(`更新不要・確認不能・変更ありの場合は承認を求めない: ${JSON.stringify(state)}`, async () => {
    assert.equal(await checkStartupUpdate({ check: async () => ({ ...plan, ...state }),
      confirm: async () => { throw new Error('承認を求めてはいけません'); }, emit: () => {},
    }), false);
  });
}

test('ネットワークや Git の例外でも起動を続ける', async () => {
  const output: string[] = [];
  assert.equal(await checkStartupUpdate({ check: async () => { throw new Error('offline'); },
    emit: text => output.push(text),
  }), false);
  assert.match(output.join('\n'), /offline/);
});
