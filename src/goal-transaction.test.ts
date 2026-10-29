import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearAllTxs, listTxs, loadTx, reconcileGoalTransactions, txComplete, txFail, txStart, txTouch } from './goal-transaction.js';
import { activateTodo, addTodo, createGoal, markDone, markFailed, loadGoal } from './goal-store.js';

function withTempGoals<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'wentian-tx-'));
  // 復旧処理はgit resetを実行するため、開発中のリポジトリを絶対に渡しません。
  // 専用の一時リポジトリで、ファイル復旧まで検証します。
  execFileSync('git', ['init', '--initial-branch=main', root], { stdio: 'pipe' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'pipe' });
  writeFileSync(path.join(root, 'README.md'), '復旧前の内容\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Wentian Test', '-c', 'user.email=test@wentian.local', 'commit', '-m', '初期状態'], { cwd: root, stdio: 'pipe' });
  process.env.WENTIAN_GOAL_PATH = root;
  return Promise.resolve(fn(root)).finally(() => {
    delete process.env.WENTIAN_GOAL_PATH;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

test('txStart → loadTx → txComplete の基本ライフサイクル', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'tx', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    const tx = await txStart(goal, t, root);
    assert.equal(tx.phase, 'start');
    assert.equal(tx.todoId, 't1');
    assert.equal(tx.pid, process.pid);
    // ファイル存在
    const loaded = await loadTx(goal.id, 't1');
    assert.ok(loaded);
    assert.equal(loaded.phase, 'start');
    // complete で消える
    await txComplete(goal, 't1');
    const after = await loadTx(goal.id, 't1');
    assert.equal(after, undefined);
  });
});

test('txTouch で phase と error を更新できる', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'tx2', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    await txStart(goal, t, root);
    await txTouch(goal, t.id, 'running');
    const loaded1 = await loadTx(goal.id, t.id);
    assert.equal(loaded1?.phase, 'running');
    await txTouch(goal, t.id, 'failed', 'something went wrong');
    const loaded2 = await loadTx(goal.id, t.id);
    assert.equal(loaded2?.phase, 'failed');
    assert.equal(loaded2?.error, 'something went wrong');
  });
});

test('txFail は failed 状態を残しtxファイルも残る', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'tx3', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    await txStart(goal, t, root);
    await txFail(goal, t.id, 'connection timeout');
    const loaded = await loadTx(goal.id, t.id);
    assert.equal(loaded?.phase, 'failed');
    assert.equal(loaded?.error, 'connection timeout');
  });
});

test('reconcile: 未完了tx(start)のactive TODOはpendingへロールバック', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'reconcile', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    await activateTodo(goal, t.id);
    // txはstartのみ (完了前=電源断模擬)
    await txStart(goal, t, root);
    writeFileSync(path.join(root, 'README.md'), '未完了の変更\n');
    const reloaded = await loadGoal(goal.id);
    const result = await reconcileGoalTransactions(reloaded, root);
    assert.equal(result.rolledBack, 1);
    assert.equal(result.recovered, 0);
    assert.equal(reloaded.todos[0].status, 'pending');
    assert.match(reloaded.todos[0].lastError || '', /rolled back/);
    assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), '復旧前の内容\n');
  });
});

test('reconcile: 完了済tx(done)のactive TODOはdoneへ回復', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'recover-done', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    await activateTodo(goal, t.id);
    await txStart(goal, t, root);
    await txTouch(goal, t.id, 'done');
    const reloaded = await loadGoal(goal.id);
    const result = await reconcileGoalTransactions(reloaded, root);
    assert.equal(result.recovered, 1);
    assert.equal(result.rolledBack, 0);
    assert.equal(reloaded.todos[0].status, 'done');
  });
});

test('reconcile: 失敗tx(failed)のactive TODOはfailedへ回復', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'recover-failed', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    await activateTodo(goal, t.id);
    await txStart(goal, t, root);
    await txFail(goal, t.id, 'network error');
    const reloaded = await loadGoal(goal.id);
    const result = await reconcileGoalTransactions(reloaded, root);
    assert.equal(result.recovered, 1);
    assert.equal(reloaded.todos[0].status, 'failed');
    assert.match(reloaded.todos[0].lastError || '', /network error/);
  });
});

test('reconcile: tx無しのactive TODOは安全側でpendingへ', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'no-tx', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    await activateTodo(goal, t.id);
    // txStart を呼ばない (前バージョンのGoalを模擬)
    const reloaded = await loadGoal(goal.id);
    const result = await reconcileGoalTransactions(reloaded, root);
    assert.equal(result.rolledBack, 1);
    assert.equal(reloaded.todos[0].status, 'pending');
  });
});

test('reconcile: activeで無いTODOは変更しない', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'noop', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    // activeにしない
    const reloaded = await loadGoal(goal.id);
    const result = await reconcileGoalTransactions(reloaded, root);
    assert.equal(result.reconciled, 0);
    assert.equal(reloaded.todos[0].status, 'pending');
  });
});

test('listTxs はtx一覧を返す', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'listtx', description: 'd' });
    const t1 = await addTodo(goal, { title: 'A' });
    const t2 = await addTodo(goal, { title: 'B' });
    await txStart(goal, t1, root);
    await txStart(goal, t2, root);
    const txs = await listTxs(goal.id);
    assert.equal(txs.length, 2);
  });
});

test('clearAllTxs は全txを削除する', async () => {
  await withTempGoals(async root => {
    const goal = await createGoal({ title: 'clear', description: 'd' });
    const t = await addTodo(goal, { title: 'A' });
    await txStart(goal, t, root);
    assert.equal((await listTxs(goal.id)).length, 1);
    await clearAllTxs(goal.id);
    assert.equal((await listTxs(goal.id)).length, 0);
  });
});
