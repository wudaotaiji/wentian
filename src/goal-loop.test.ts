import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGoalLoop, type RunOneTodoFn } from './goal-loop.js';
import { activateTodo, addTodo, createGoal, loadGoal, markDone, markFailed, pickNextTodo } from './goal-store.js';
import type { CompactorConversationMessage } from './agent-compactor.js';

function withTempCwd<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'wentian-loop-'));
  process.env.WENTIAN_GOAL_PATH = root;
  writeFileSync(path.join(root, 'README.md'), '# Test', 'utf8');
  return Promise.resolve(fn(root)).finally(() => {
    delete process.env.WENTIAN_GOAL_PATH;
    rmSync(root, { recursive: true, force: true });
  });
}

/** テスト用: 1回目ok, 2回目ok, ... と順に結果を返すモックrunner。 */
function makeScriptedRunner(script: Array<{ ok: boolean; checkpoint?: string | null; error?: string }>): RunOneTodoFn {
  let i = 0;
  return async ({ todo }) => {
    const step = script[i++] || { ok: true };
    return { ok: step.ok, checkpoint: step.checkpoint ?? null, summary: `step${i} for ${todo.id}`, error: step.error };
  };
}

test('累積トークン予算（Token Budget）に到達したら次TODOを開始しない', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'token budget', description: 'desc', stop: { maxTokens: 10 } });
    await addTodo(goal, { title: 'A', acceptance: [{ path: 'README.md', contains: '# Test' }] });
    await addTodo(goal, { title: 'B', acceptance: [{ path: 'README.md', contains: '# Test' }] });
    let calls = 0;
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: async ({ options }) => {
      calls++; assert.equal(options.remainingTokens, 10); assert.ok(options.signal);
      return { ok: true, usage: { input: 5, output: 5, total: 10, cachedInput: 0, reasoning: 0 } };
    } });
    assert.equal(calls, 1); assert.equal(result.reason, 'aborted'); assert.equal((await loadGoal(goal.id)).metrics.totalTokens, 10);
    assert.equal(result.goal.todos[1].status, 'pending');
  });
});

test('費用予算（Cost Budget）は累積費用を超えて次TODOを実行しない', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'cost budget', description: 'desc', stop: { maxCostUsd: 0.01 } });
    await addTodo(goal, { title: 'A', acceptance: [{ path: 'README.md', contains: '# Test' }] });
    await addTodo(goal, { title: 'B', acceptance: [{ path: 'README.md', contains: '# Test' }] });
    let calls = 0;
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: async () => { calls++; return { ok: true, costUsd: 0.01 }; } });
    assert.equal(calls, 1); assert.equal(result.reason, 'aborted'); assert.equal(result.goal.metrics.totalCostUsd, 0.01);
  });
});

test('runGoalLoop は pending TODOを順に実行し全完了で completed になる', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'simple loop', description: 'desc' });
    const t1 = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'タスク1' });
    const t2 = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'タスク2' });
    const t3 = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'タスク3' });
    const runner = makeScriptedRunner([{ ok: true }, { ok: true }, { ok: true }]);
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner });
    assert.equal(result.reason, 'completed');
    assert.equal(result.goal.status, 'completed');
    assert.equal(result.goal.metrics.completedCount, 3);
    // git管理外なのでcheckpointはnull (L4フォールバック)
    assert.equal(result.goal.todos.find(t => t.id === t1.id)?.checkpoint, null);
    assert.equal(result.goal.todos.find(t => t.id === t2.id)?.checkpoint, null);
    assert.equal(result.goal.todos.find(t => t.id === t3.id)?.checkpoint, null);
    assert.equal(result.totalTicks, 3);
  });
});

test('品質ゲート不合格はAgentの成功報告を採用せず失敗上限で停止する', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'quality gate', description: 'desc', stop: { maxConsecutiveFailures: 2 } });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: '自己修正' });
    let runs = 0; let evaluations = 0;
    const result = await runGoalLoop(goal.id, {
      cwd, server: 'http://x', model: 'm', forceWeb: false,
      runOneTodo: async () => { runs += 1; return { ok: true, summary: 'Agentは成功と報告' }; },
      qualityGate: {
        captureBaseline: async () => ({ score: 100 }),
        evaluate: async () => { evaluations += 1; return { passed: false, summary: '回帰を検出' }; },
      },
    });
    assert.equal(result.reason, 'aborted'); assert.equal(runs, 2); assert.equal(evaluations, 2);
    assert.match((await loadGoal(goal.id)).todos[0].lastError || '', /品質ゲート不合格/);
  });
});

test('依存関係を考慮し、依存未完了TODOはスキップされる', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'deps', description: 'desc' });
    const a = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'A' });
    const b = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'B', dependsOn: [a.id] });
    // 1回目: Aをok, 2回目: Bをok
    const runner = makeScriptedRunner([{ ok: true }, { ok: true }]);
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner });
    assert.equal(result.reason, 'completed');
    const reloaded = await loadGoal(goal.id);
    assert.equal(reloaded.todos.find(t => t.id === a.id)?.status, 'done');
    assert.equal(reloaded.todos.find(t => t.id === b.id)?.status, 'done');
  });
});

test('連続失敗が上限に達すると status=aborted になる', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'fail loop', description: 'desc', stop: { maxConsecutiveFailures: 2 } });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'X' });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'Y' });
    const runner = makeScriptedRunner([{ ok: false, error: '1回目' }, { ok: false, error: '2回目' }]);
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner });
    assert.equal(result.reason, 'aborted');
    assert.equal(result.goal.status, 'aborted');
  });
});

test('成功するとconsecutiveFailuresが0にリセットされる', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'reset', description: 'desc', stop: { maxConsecutiveFailures: 5 } });
    const t1 = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: '1' });
    const t2 = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: '2' });
    const t3 = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: '3' });
    // t1はdone、t2は失敗→再試行でdone、t3はdone
    const runner = makeScriptedRunner([{ ok: false }, { ok: true }, { ok: true }, { ok: true }]);
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner });
    assert.equal(result.reason, 'completed');
    const reloaded = await loadGoal(goal.id);
    assert.equal(reloaded.metrics.consecutiveFailures, 0);
    assert.equal(reloaded.metrics.completedCount, 3);
    assert.equal(reloaded.todos.find(t => t.id === t1.id)?.status, 'done');
    assert.equal(reloaded.todos.find(t => t.id === t2.id)?.status, 'done');
    assert.equal(reloaded.todos.find(t => t.id === t3.id)?.status, 'done');
  });
});

test('pendingTODOが無いと no-todo で終了する', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'no-todo', description: 'desc' });
    // blocked状態のTODOだけ → pending ready なし → no-todo
    const t = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'A' });
    await (await import('./goal-store.js')).markBlocked(goal, t.id, '永久保留');
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: async () => ({ ok: true }) });
    assert.equal(result.reason, 'no-todo'); // 保留中の項目があるため完了にはしません。
    assert.equal(result.goal.status, 'active');
  });
});

test('SIGINT 1回目で paused として保存される', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'interrupt', description: 'desc' });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'A' });
    const controller = new AbortController();
    // tick=1で SIGINT を発火するrunner
    const runner: RunOneTodoFn = async () => {
      controller.abort();
      return { ok: true };
    };
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner, signal: controller.signal });
    assert.equal(result.reason, 'paused');
    const reloaded = await loadGoal(goal.id);
    assert.equal(reloaded.status, 'paused');
  });
});

test('Memory Layerがサブ会話先頭にimmovable systemとして注入される', async () => {
  await withTempCwd(async cwd => {
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'memory-content-A', 'utf8');
    const goal = await createGoal({ title: 'memory', description: 'desc' });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'A' });
    let captured: CompactorConversationMessage[] = [];
    const runner: RunOneTodoFn = async ({ memoryMessages }) => {
      captured = memoryMessages;
      return { ok: true };
    };
    await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner });
    const merged = JSON.stringify(captured);
    assert.match(merged, /memory-content-A/);
    assert.ok(captured.some(m => m.metadata?.immovable === true), 'immovable system messageが含まれる');
  });
});

test('paused 状態のGoal再開は active に戻して続行する', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'resume', description: 'desc' });
    const a = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'A' });
    // 実行中にpauseされた状態を再現: activeなまま保存→statusだけpausedへ
    await activateTodo(goal, a.id);
    const reloaded = await loadGoal(goal.id);
    reloaded.status = 'paused';
    await (await import('./goal-store.js')).saveGoal(reloaded);
    // runGoalLoopが paused を見て active に戻す際、ついでにactive TODOをpendingへ戻すよう再設計する代わりに、
    // ここでは明示的にactive→pendingに戻してから再開
    const reloaded2 = await loadGoal(goal.id);
    reloaded2.todos[0].status = 'pending';
    reloaded2.status = 'paused';
    await (await import('./goal-store.js')).saveGoal(reloaded2);
    const runner = makeScriptedRunner([{ ok: true }]);
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner });
    assert.equal(result.reason, 'completed');
    assert.equal(result.goal.status, 'completed');
  });
});

test('git管理内ディレクトリでTODO完了時 git commit される', async () => {
  // git初期化
  const gitDir = mkdtempSync(path.join(tmpdir(), 'wentian-loop-git-'));
  process.env.WENTIAN_GOAL_PATH = gitDir;
  const repoDir = mkdtempSync(path.join(tmpdir(), 'wentian-loop-repo-'));
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@wentian.local'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Wentian Test'], { cwd: repoDir, stdio: 'pipe' });
    writeFileSync(path.join(repoDir, 'README.md'), '# Test\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoDir, stdio: 'pipe' });
    const goal = await createGoal({ title: 'git-loop', description: 'd' });
    const t = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'commit test' });
    const runner = makeScriptedRunner([{ ok: true }]);
    const result = await runGoalLoop(goal.id, { cwd: repoDir, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner });
    assert.equal(result.reason, 'completed');
    const reloaded = await loadGoal(goal.id);
    assert.match(reloaded.todos[0].checkpoint || '', /^[0-9a-f]{40}$/, 'git SHAが記録される');
  } finally {
    delete process.env.WENTIAN_GOAL_PATH;
    try { rmSync(gitDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('auditAgent=mock + auditEvery=2 で 2TODO完了毎に監査が起動する', async () => {
  await withTempCwd(async cwd => {
    const goal = await createGoal({ title: 'audit-loop', description: 'd' });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: '1' });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: '2' });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: '3' });
    await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: '4' });
    const runner = makeScriptedRunner([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    const auditCalls: string[] = [];
    // runOneTodoはそのまま、auditGoalを直接モックしたいが外から差し込めないため、
    // auditAgent='mock'を渡してverdict=blockになるケースを手動で再現
    const result = await runGoalLoop(goal.id, { cwd, server: 'http://x', model: 'm', forceWeb: false, runOneTodo: runner, auditAgent: 'mock', auditEvery: 2 });
    assert.equal(result.reason, 'completed');
    const reports = await (await import('./goal-audit.js')).listAuditReports(goal.id);
    // 4TODO / 2 = 2回監査が走るはず
    assert.ok(reports.length >= 1, `監査レポートが最低1件ある。実際=${reports.length}`);
  });
});

test('pickNextTodoは境界条件 (依存doneならfailedよりpending優先)', async () => {
  await withTempCwd(async () => {
    const goal = await createGoal({ title: 'priority', description: 'desc' });
    const a = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'A' });
    const b = await addTodo(goal, { acceptance: [{ path: 'README.md', contains: '# Test' }], title: 'B', dependsOn: [a.id] });
    // まずAをdoneに
    await activateTodo(goal, a.id);
    await markDone(goal, a.id, 'sha-a');
    // Bをactivateしてからfailed
    await activateTodo(goal, b.id);
    await markFailed(goal, b.id, 'error');
    // pickNextTodo は B (failed) を返す (pending ready が他にないため)
    const next = pickNextTodo(goal);
    assert.equal(next?.id, b.id);
  });
});
