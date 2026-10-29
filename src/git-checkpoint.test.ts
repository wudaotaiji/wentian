import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkpointComplete, checkpointRollback, checkpointStart, currentHead, isGitRepository } from './git-checkpoint.js';
import { createGoal, addTodo } from './goal-store.js';

function initTempGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'wentian-git-'));
  try {
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@wentian.local'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Wentian Test'], { cwd: dir, stdio: 'pipe' });
    writeFileSync(path.join(dir, 'README.md'), '# Test\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'pipe' });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

function withTempRepo<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = initTempGitRepo();
  return Promise.resolve(fn(dir)).finally(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

function withTempNoRepo<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'wentian-nogit-'));
  return Promise.resolve(fn(dir)).finally(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

test('isGitRepository: true for git repo, false otherwise', async () => {
  await withTempRepo(async dir => { assert.equal(await isGitRepository(dir), true); });
  await withTempNoRepo(async dir => { assert.equal(await isGitRepository(dir), false); });
});

test('currentHead returns SHA for git repo and null otherwise', async () => {
  await withTempRepo(async dir => {
    const head = await currentHead(dir);
    assert.match(head || '', /^[0-9a-f]{40}$/);
  });
  await withTempNoRepo(async dir => {
    assert.equal(await currentHead(dir), null);
  });
});

test('checkpointStart は todo.checkpoint に HEAD を記録する', async () => {
  await withTempRepo(async dir => {
    const goal = await createGoal({ title: 'g', description: 'd' });
    const t = await addTodo(goal, { title: 't' });
    const head = await checkpointStart(goal, t, dir);
    assert.match(head || '', /^[0-9a-f]{40}$/);
    assert.equal(t.checkpoint, head);
  });
});

test('checkpointComplete は変更を commit し新SHAを返す', async () => {
  await withTempRepo(async dir => {
    const goal = await createGoal({ title: 'g', description: 'd' });
    const t = await addTodo(goal, { title: 't' });
    await checkpointStart(goal, t, dir);
    const beforeHead = await currentHead(dir);
    writeFileSync(path.join(dir, 'new.txt'), 'hello\n', 'utf8');
    const result = await checkpointComplete(goal, t, 'added new.txt', dir);
    assert.match(result.sha || '', /^[0-9a-f]{40}$/);
    assert.notEqual(result.sha, beforeHead, 'SHA changed after commit');
    assert.equal(t.checkpoint, result.sha);
    // git logにmessageが含まれる
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir, encoding: 'utf8' });
    assert.match(log, new RegExp(`goal\\(${goal.id}\\): ${t.title}`));
  });
});

test('checkpointComplete は変更なしなら commit せずHEADをそのまま返す', async () => {
  await withTempRepo(async dir => {
    const goal = await createGoal({ title: 'g', description: 'd' });
    const t = await addTodo(goal, { title: 't' });
    const head = await checkpointStart(goal, t, dir);
    const result = await checkpointComplete(goal, t, 'no changes', dir);
    assert.equal(result.sha, head);
  });
});

test('checkpointRollback はstash + reset で開始時のHEADへ戻す', async () => {
  await withTempRepo(async dir => {
    const goal = await createGoal({ title: 'g', description: 'd' });
    const t = await addTodo(goal, { title: 't' });
    const startHead = await checkpointStart(goal, t, dir);
    writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted', 'utf8');
    const result = await checkpointRollback(goal, t, 'test failure', dir);
    assert.equal(result.rolled, true);
    // ファイルが消えている (reset --hard)
    let exists = true; try { execFileSync('test', ['-f', 'dirty.txt'], { cwd: dir, stdio: 'pipe' }); } catch { exists = false; }
    assert.equal(exists, false, 'dirty.txt は reset で消えているはず');
    // HEADはstartHeadのまま
    const head = await currentHead(dir);
    assert.equal(head, startHead);
    // stashが残っている
    const stashList = execFileSync('git', ['stash', 'list'], { cwd: dir, encoding: 'utf8' });
    assert.match(stashList, new RegExp(`goal\\(${goal.id}\\)`));
  });
});

test('checkpointRollback は変更なしなら rolled:false を返す', async () => {
  await withTempRepo(async dir => {
    const goal = await createGoal({ title: 'g', description: 'd' });
    const t = await addTodo(goal, { title: 't' });
    await checkpointStart(goal, t, dir);
    const result = await checkpointRollback(goal, t, 'no changes', dir);
    assert.equal(result.rolled, false);
  });
});

test('git管理外では checkpointStart / Complete / Rollback すべて null/rolled:false でno-op', async () => {
  await withTempNoRepo(async dir => {
    const goal = await createGoal({ title: 'g', description: 'd' });
    const t = await addTodo(goal, { title: 't' });
    const start = await checkpointStart(goal, t, dir);
    assert.equal(start, null);
    writeFileSync(path.join(dir, 'dirty.txt'), 'x', 'utf8');
    const complete = await checkpointComplete(goal, t, 'noop', dir);
    assert.equal(complete.sha, null);
    const rollback = await checkpointRollback(goal, t, 'noop', dir);
    assert.equal(rollback.rolled, false);
  });
});
