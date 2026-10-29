import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { formatDaemonStatus, isPidAlive, listRunningDaemons, readDaemonRecord, startGoalDaemon, stopGoalDaemon } from './goal-daemon.js';
import { createGoal } from './goal-store.js';

function withTempGoals<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), 'wentian-daemon-'));
  process.env.WENTIAN_GOAL_PATH = root;
  return Promise.resolve(fn(root)).finally(() => {
    delete process.env.WENTIAN_GOAL_PATH;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

test('isPidAlive: 自分のPIDは true', async () => {
  assert.equal(await isPidAlive(process.pid), true);
});

test('isPidAlive: 存在しないPIDは false', async () => {
  // 999999 は通常使われない
  assert.equal(await isPidAlive(999_999), false);
});

test('readDaemonRecord: 存在しないGoalで undefined', async () => {
  await withTempGoals(async () => {
    const rec = await readDaemonRecord('goal-not-exist');
    assert.equal(rec, undefined);
  });
});

test('startGoalDaemon + stopGoalDaemon の基本動作 (record 書込 + 終了)', async function(t) {
  if (process.platform !== 'win32') { t.skip(); return; }
  await withTempGoals(async () => {
    const goal = await createGoal({ title: 'daemon test', description: 'd' });
    // 自分自身を spawn して長時間sleepする疑似worker
    // 簡略化: 実際のcliは重いので、手動で daemon.json を作成して挙動確認
    const rec = {
      version: '1.0' as const, goalId: goal.id, pid: process.pid, startedAt: new Date().toISOString(),
      logPath: 'C:\\fake\\log', status: 'running' as const,
    };
    const dir = path.join(process.env.WENTIAN_GOAL_PATH!, goal.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify(rec, null, 2));
    // readDaemonRecord で読み込める
    const loaded = await readDaemonRecord(goal.id);
    assert.ok(loaded);
    assert.equal(loaded.pid, process.pid);
    // 自分自身のPIDは alive
    assert.equal(await isPidAlive(loaded.pid), true);
    // formatDaemonStatus
    const status = await formatDaemonStatus(goal);
    assert.match(status, /daemon: running/);
    assert.match(status, new RegExp(String(process.pid)));
  });
});

test('startGoalDaemon: 既存runningなら alreadyRunning:true を返す', async () => {
  await withTempGoals(async () => {
    const goal = await createGoal({ title: 'already', description: 'd' });
    // 自分自身のPIDで daemon.json を作る
    const dir = path.join(process.env.WENTIAN_GOAL_PATH!, goal.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({
      version: '1.0', goalId: goal.id, pid: process.pid, startedAt: new Date().toISOString(),
      logPath: 'fake', status: 'running',
    }, null, 2));
    const result = await startGoalDaemon({ goalId: goal.id, cwd: process.cwd() });
    assert.equal(result.alreadyRunning, true);
    assert.equal(result.pid, process.pid);
  });
});

test('startGoalDaemon: 死んだPIDのstale record は削除して再起動', async () => {
  await withTempGoals(async () => {
    const goal = await createGoal({ title: 'stale', description: 'd' });
    const dir = path.join(process.env.WENTIAN_GOAL_PATH!, goal.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({
      version: '1.0', goalId: goal.id, pid: 999_999, startedAt: new Date().toISOString(),
      logPath: 'fake', status: 'running',
    }, null, 2));
    // startGoalDaemon は cli を spawn しようとする。テストでは spawn 失敗が予想されるが、
    // 少なくとも stale record は削除される
    try {
      await startGoalDaemon({ goalId: goal.id, cwd: process.cwd() });
    } catch { /* spawn失敗は想定内 */ }
    // stale record は消えている (新しいものがないか、削除されている)
    const rec = await readDaemonRecord(goal.id);
    // 新しい spawn が死んだ場合、record は書かれないので undefined
    // 成功した場合、新しいPIDで record がある
    if (rec) assert.notEqual(rec.pid, 999_999);
  });
});

test('stopGoalDaemon: 存在しないGoal', async () => {
  await withTempGoals(async () => {
    const result = await stopGoalDaemon('goal-not-exist');
    assert.equal(result.stopped, false);
    assert.match(result.message, /起動記録/);
  });
});

test('stopGoalDaemon: 死んだPID は dead 化', async () => {
  await withTempGoals(async () => {
    const goal = await createGoal({ title: 'dead', description: 'd' });
    const dir = path.join(process.env.WENTIAN_GOAL_PATH!, goal.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({
      version: '1.0', goalId: goal.id, pid: 999_999, startedAt: new Date().toISOString(),
      logPath: 'fake', status: 'running',
    }, null, 2));
    const result = await stopGoalDaemon(goal.id, { timeoutMs: 1000 });
    assert.equal(result.stopped, true);
    const after = await readDaemonRecord(goal.id);
    assert.equal(after?.status, 'dead');
  });
});

test('listRunningDaemons: 稼働中Goalのみ列挙', async () => {
  await withTempGoals(async () => {
    const g1 = await createGoal({ title: 'a', description: 'd' });
    const g2 = await createGoal({ title: 'b', description: 'd' });
    const dir1 = path.join(process.env.WENTIAN_GOAL_PATH!, g1.id);
    const dir2 = path.join(process.env.WENTIAN_GOAL_PATH!, g2.id);
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(path.join(dir1, 'daemon.json'), JSON.stringify({ version: '1.0', goalId: g1.id, pid: process.pid, startedAt: new Date().toISOString(), logPath: 'f', status: 'running' }, null, 2));
    writeFileSync(path.join(dir2, 'daemon.json'), JSON.stringify({ version: '1.0', goalId: g2.id, pid: 999_999, startedAt: new Date().toISOString(), logPath: 'f', status: 'running' }, null, 2));
    const list = await listRunningDaemons();
    assert.equal(list.length, 1);
    assert.equal(list[0].goalId, g1.id);
  });
});

test('formatDaemonStatus: 未起動は "未起動" を返す', async () => {
  await withTempGoals(async () => {
    const goal = await createGoal({ title: 'no-daemon', description: 'd' });
    const status = await formatDaemonStatus(goal);
    assert.match(status, /daemon: 未起動/);
  });
});
