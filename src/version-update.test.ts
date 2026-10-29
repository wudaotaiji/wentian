import assert from 'node:assert/strict';
import test from 'node:test';
import { applyVersionUpdate, formatVersionUpdatePlan, issueVersionUpdateApproval, type VersionUpdatePlan } from './version-update.js';

const plan = (overrides: Partial<VersionUpdatePlan> = {}): VersionUpdatePlan => ({
  installRoot: 'C:\\work\\wentian-gateway', currentVersion: '0.5.0', branch: 'main', currentCommit: 'a'.repeat(40),
  remoteCommit: 'b'.repeat(40), updateAvailable: true, clean: true, changes: [], checkedAt: new Date().toISOString(), canApply: true, ...overrides,
  relation: 'update_available',
});

test('更新可能な計画だけに短期限Tokenを発行する', () => {
  const approval = issueVersionUpdateApproval(plan());
  assert.equal(approval.targetCommit, 'b'.repeat(40));
  assert.ok(approval.expiresAt > Date.now());
  assert.throws(() => issueVersionUpdateApproval(plan({ clean: false, canApply: false, reason: '未コミット変更' })), /未コミット変更/);
});

test('更新計画はVersion・Commit・実行コマンドを表示する', () => {
  const target = plan(); const approval = issueVersionUpdateApproval(target);
  const output = formatVersionUpdatePlan(target, approval);
  assert.match(output, /current version: 0\.5\.0/);
  assert.match(output, /\/update apply/);
});

test('不正TokenはファイルやGitを操作する前に拒否する', async () => {
  const approval = issueVersionUpdateApproval(plan());
  await assert.rejects(applyVersionUpdate(approval, 'wrong-token', () => undefined, 'Z:\\存在しない'), /Tokenが無効/);
});
