import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  addTodo, activateTodo, createGoal, createGoalId, formatGoalProgress, isGoalFinished,
  listGoals, loadGoal, markBlocked, markDone, markFailed, pickNextTodo, saveGoal, updateTodo,
} from './goal-store.js';

function withTempGoalsRoot<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'wentian-goal-'));
  process.env.WENTIAN_GOAL_PATH = root;
  return Promise.resolve(fn(root)).finally(() => {
    delete process.env.WENTIAN_GOAL_PATH;
    rmSync(root, { recursive: true, force: true });
  });
}

test('createGoalId は命名規約に従いpath traversalを防ぐ', () => {
  const id = createGoalId('アーカイブ機能を 再設計する!');
  assert.match(id, /^goal-\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*-[a-f0-9]{6}$/);
  assert.ok(id.length <= 64, 'IDは64文字以内');
});

test('createGoalは active 状態で .wentian/goals/<id>.json に原子書込される', async () => {
  await withTempGoalsRoot(async root => {
    const goal = await createGoal({ title: 'Phase 1 検証', description: 'Goal Store の基本動作確認' });
    assert.equal(goal.status, 'active');
    assert.equal(goal.todos.length, 0);
    assert.equal(goal.metrics.completedCount, 0);
    assert.equal(goal.metrics.consecutiveFailures, 0);
    assert.ok(existsSync(path.join(root, `${goal.id}.json`)), 'JSONファイルが存在する');
  });
});

test('loadGoal / listGoals は updatedAt 降順で返す', async () => {
  await withTempGoalsRoot(async () => {
    const a = await createGoal({ title: 'alpha', description: 'A' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const b = await createGoal({ title: 'beta', description: 'B' });
    const list = await listGoals();
    assert.deepEqual(list.map(g => g.id), [b.id, a.id]);
    const loaded = await loadGoal(b.id);
    assert.equal(loaded.id, b.id);
  });
});

test('不正なGoal IDはpath traversal防止のため例外', async () => {
  await withTempGoalsRoot(async () => {
    await assert.rejects(loadGoal('goal-../etc/passwd'), /不正なGoal ID/);
    await assert.rejects(loadGoal('not-a-goal'), /不正なGoal ID/);
    await assert.rejects(loadGoal('goal-2026-09-04-'), /不正なGoal ID/);
  });
});

test('addTodoは依存先を検証し、存在しない依存IDで例外', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: '依存検証', description: 'desc' });
    await addTodo(goal, { title: 'タスクA' });
    await assert.rejects(addTodo(goal, { title: 'タスクB', dependsOn: ['t1', 't999'] }), /依存先TODOが存在しません/);
  });
});

test('pickNextTodoは依存未完了のTODOをスキップし、依存完了後に選択する', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: '依存順序', description: 'desc' });
    const a = await addTodo(goal, { title: 'A' });
    const b = await addTodo(goal, { title: 'B', dependsOn: [a.id] });
    assert.equal(pickNextTodo(goal)?.id, a.id, 'Aが先に選ばれる');
    await activateTodo(goal, a.id);
    await markDone(goal, a.id, 'sha-aaa');
    assert.equal(pickNextTodo(goal)?.id, b.id, 'A完了後にBが選ばれる');
  });
});

test('activateTodoは1度に1TODOだけactiveにし、attemptsを増加', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: '排他', description: 'desc' });
    const a = await addTodo(goal, { title: 'A' });
    const b = await addTodo(goal, { title: 'B' });
    await activateTodo(goal, a.id);
    await activateTodo(goal, b.id);
    const reloaded = await loadGoal(goal.id);
    const aState = reloaded.todos.find(t => t.id === a.id);
    const bState = reloaded.todos.find(t => t.id === b.id);
    assert.equal(aState?.status, 'pending', 'Aはpendingに戻される');
    assert.equal(bState?.status, 'active');
    assert.equal(bState?.attempts, 1, 'Bのattemptsは1');
    assert.equal(reloaded.metrics.totalAttempts, 2, 'A→Bで2回active化しているのでtotalAttempts=2');
  });
});

test('markDoneはcompletedCountを増やしconsecutiveFailuresを0にリセット', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: 'Done', description: 'desc' });
    const t = await addTodo(goal, { title: 'T' });
    await activateTodo(goal, t.id);
    await markFailed(goal, t.id, 'timeout');
    await markFailed(goal, t.id, '2回目失敗');
    assert.equal(goal.metrics.consecutiveFailures, 2);
    // 失敗扱いだったのでstatusはfailed。pendingへ戻すには addTodo で再投入、または手動update
    await updateTodo(goal, t.id, { status: 'pending' });
    await activateTodo(goal, t.id);
    await markDone(goal, t.id, 'sha-final');
    const reloaded = await loadGoal(goal.id);
    assert.equal(reloaded.metrics.completedCount, 1);
    assert.equal(reloaded.metrics.consecutiveFailures, 0);
  });
});

test('consecutiveFailuresが上限に達するとstatus=abortedになる', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: 'Aborted', description: 'desc', stop: { maxConsecutiveFailures: 2 } });
    const t = await addTodo(goal, { title: 'T' });
    await activateTodo(goal, t.id);
    await markFailed(goal, t.id, '1st');
    await updateTodo(goal, t.id, { status: 'pending' });
    await activateTodo(goal, t.id);
    await markFailed(goal, t.id, '2nd');
    const reloaded = await loadGoal(goal.id);
    assert.equal(reloaded.status, 'aborted');
    assert.equal(reloaded.metrics.consecutiveFailures, 2);
  });
});

test('markBlockedは BlockedEntry を追加しblockedCountを増やす', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: 'Blocked', description: 'desc' });
    const t = await addTodo(goal, { title: 'T' });
    await markBlocked(goal, t.id, '外部APIキー未提供');
    const reloaded = await loadGoal(goal.id);
    assert.equal(reloaded.todos[0].status, 'blocked');
    assert.equal(reloaded.blocked.length, 1);
    assert.equal(reloaded.metrics.blockedCount, 1);
    assert.equal(reloaded.blocked[0].reason, '外部APIキー未提供');
  });
});

test('isGoalFinishedはblocked項目を完了として扱わない', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: '完了判定', description: 'desc' });
    const a = await addTodo(goal, { title: 'A' });
    const b = await addTodo(goal, { title: 'B' });
    assert.equal(isGoalFinished(goal), false);
    await markBlocked(goal, a.id, '保留');
    await activateTodo(goal, b.id);
    await markDone(goal, b.id, 'sha');
    const reloaded = await loadGoal(goal.id);
    assert.equal(isGoalFinished(reloaded), false);
  });
});

test('formatGoalProgressは1行で主要指標を返す', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: '進捗', description: 'desc' });
    await addTodo(goal, { title: 'A' });
    await addTodo(goal, { title: 'B' });
    const line = formatGoalProgress(goal);
    assert.match(line, /progress=0\/2/);
    assert.match(line, /consecutiveFailures=0\/3/);
    assert.match(line, new RegExp(goal.id));
  });
});

test('saveGoalはupdatedAtを最新化する', async () => {
  await withTempGoalsRoot(async () => {
    const goal = await createGoal({ title: 'updatedAt', description: 'desc' });
    const before = goal.updatedAt;
    await new Promise(resolve => setTimeout(resolve, 5));
    await saveGoal(goal);
    assert.ok(goal.updatedAt > before);
  });
});
