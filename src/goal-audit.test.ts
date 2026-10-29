import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { auditGoal, listAuditReports, shouldAuditGoal } from './goal-audit.js';
import { createGoal, addTodo, activateTodo, markFailed, markDone } from './goal-store.js';

function withTempGoals<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'wentian-audit-'));
  process.env.WENTIAN_GOAL_PATH = root;
  return Promise.resolve(fn(root)).finally(() => {
    delete process.env.WENTIAN_GOAL_PATH;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

test('shouldAuditGoal: 5TODO完了毎は run=true', () => {
  const goal = { metrics: { consecutiveFailures: 0, completedCount: 5, totalAttempts: 5, blockedCount: 0, startedAt: '', lastTickAt: '' } } as any;
  const r = shouldAuditGoal(goal, 5);
  assert.equal(r.run, true);
  assert.match(r.reason, /periodic/);
});

test('shouldAuditGoal: consecutiveFailures>=2 で run=true', () => {
  const goal = { metrics: { consecutiveFailures: 2, completedCount: 0, totalAttempts: 2, blockedCount: 0, startedAt: '', lastTickAt: '' } } as any;
  const r = shouldAuditGoal(goal, 0);
  assert.equal(r.run, true);
  assert.match(r.reason, /consecutive-failures/);
});

test('shouldAuditGoal: 通常は run=false', () => {
  const goal = { metrics: { consecutiveFailures: 0, completedCount: 1, totalAttempts: 1, blockedCount: 0, startedAt: '', lastTickAt: '' } } as any;
  const r = shouldAuditGoal(goal, 1);
  assert.equal(r.run, false);
});

test('auditGoal (mock agent) は verdict を解析して .md レポートを保存する', async () => {
  await withTempGoals(async () => {
    const goal = await createGoal({ title: 'audit test', description: 'd' });
    await addTodo(goal, { title: 'TODO-A' });
    const result = await auditGoal(goal, { cwd: process.cwd(), agent: 'mock', trigger: 'manual', mockVerdict: 'replan' });
    assert.equal(result.verdict, 'replan');
    assert.ok(existsSync(result.reportPath), 'レポートファイルが存在する');
    const content = readFileSync(result.reportPath, 'utf8');
    assert.match(content, /verdict: \*\*replan\*\*/);
    assert.match(content, /Goal Audit Report/);
    assert.match(content, new RegExp(goal.id));
  });
});

test('auditGoal は agent起動失敗時も proceed で保存する (安全側フォールバック)', async () => {
  await withTempGoals(async () => {
    const goal = await createGoal({ title: 'fallback', description: 'd' });
    const result = await auditGoal(goal, { cwd: process.cwd(), agent: 'claude', trigger: 'manual', timeoutMs: 500 });
    assert.equal(result.verdict, 'proceed', 'audit失敗時は proceed (安全側)');
    const content = readFileSync(result.reportPath, 'utf8');
    assert.match(content, /\[ERROR\]/);
  });
});

test('listAuditReports は .md ファイル一覧を新しい順に返す', async () => {
  await withTempGoals(async () => {
    const goal = await createGoal({ title: 'list', description: 'd' });
    await auditGoal(goal, { cwd: process.cwd(), agent: 'mock', trigger: 'manual', mockVerdict: 'proceed' });
    await new Promise(r => setTimeout(r, 10));
    await auditGoal(goal, { cwd: process.cwd(), agent: 'mock', trigger: 'manual', mockVerdict: 'block' });
    const list = await listAuditReports(goal.id);
    assert.equal(list.length, 2);
    // 新しい順
    assert.match(list[0], /block/);
    assert.match(list[1], /proceed/);
  });
});
