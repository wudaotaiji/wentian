import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { TaskScheduler, nextDaily, runScheduledAgent, retryScheduleLock, type ScheduleRunner } from './task-scheduler.js';
import { scheduleCommand } from './schedule-command.js';

/** テスト（Test）は一時フォルダーと偽の実行器だけを使用し、実タスクを予約しません。 */
async function fixture(run: ScheduleRunner = async () => ({})) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-schedule-'));
  return { root, scheduler: new TaskScheduler(root, run), close: () => rm(root, { recursive: true, force: true }) };
}
const now = Date.parse('2030-01-01T00:00:00Z');

test('ロック（Lock）の一時的なアクセス拒否を再試行し、恒久エラーは伝播する', async () => {
  let calls = 0;
  const codes = ['EPERM', 'EACCES', 'EBUSY'];
  assert.equal(await retryScheduleLock(async () => {
    if (calls < codes.length) throw Object.assign(new Error('一時競合'), { code: codes[calls++] });
    return '成功';
  }), '成功');
  assert.equal(calls, 3);
  calls = 0;
  const permanent = Object.assign(new Error('恒久的な権限拒否'), { code: 'EPERM' });
  await assert.rejects(retryScheduleLock(async () => { calls++; throw permanent; }), error => error === permanent);
  assert.equal(calls, 6);
  calls = 0;
  await assert.rejects(retryScheduleLock(async () => { calls++; throw Object.assign(new Error('競合中'), { code: 'EEXIST' }); }), { code: 'EEXIST' });
  assert.equal(calls, 1);
});

test('独立した予約ストア（Store）の並行更新で全件を保持し、ロックを解放する', async () => {
  const f = await fixture();
  try {
    const tasks = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      new TaskScheduler(f.root).add({ prompt: `並行予約${index}`, timing: { everyMs: 1000 } }, now)));
    assert.deepEqual(new Set((await f.scheduler.list()).map(task => task.id)), new Set(tasks.map(task => task.id)));
    await Promise.all(tasks.map(task => new TaskScheduler(f.root).manage(task.id, 'pause')));
    assert.ok((await f.scheduler.list()).every(task => !task.enabled));
    await f.scheduler.add({ prompt: '解放後の追加', timing: { everyMs: 1000 } }, now);
    assert.equal((await f.scheduler.list()).length, 17);
  } finally { await f.close(); }
});

test('指定時刻を保存し、再読み込み後も一度だけ実行する', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return { logPath: 'example.log' }; });
  try {
    await f.scheduler.add({ prompt: '日時指定', timing: { at: '2030-01-01T09:00:01+09:00' } }, now);
    assert.equal((await new TaskScheduler(f.root).list()).length, 1);
    await f.scheduler.tick(now); assert.equal(calls, 0);
    await f.scheduler.tick(now + 1000); await f.scheduler.tick(now + 5000);
    assert.equal(calls, 1); assert.equal((await f.scheduler.list())[0].lastRun?.status, 'completed');
    assert.equal((await f.scheduler.list())[0].enabled, false);
  } finally { await f.close(); }
});
test('一定間隔の取りこぼしを集約し、元の時刻を基準に次回を計算する', async () => {
  let calls = 0; const f = await fixture(async () => { calls++; return {}; });
  try {
    await f.scheduler.add({ prompt: '定期実行', timing: { everyMs: 1000 } }, now);
    await f.scheduler.tick(now + 4500); assert.equal(calls, 1);
    assert.equal((await f.scheduler.list())[0].nextRunAt, new Date(now + 5000).toISOString());
    await f.scheduler.tick(now + 5000); assert.equal(calls, 2);
  } finally { await f.close(); }
});
test('複数ワーカー（Worker）でも実行中の予約を重複実行しない', async () => {
  let calls = 0; let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async () => { calls++; await wait; return {}; });
  try {
    await f.scheduler.add({ prompt: '排他確認', timing: { everyMs: 1000 } }, now);
    const first = f.scheduler.tick(now + 1000);
    while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
    await new TaskScheduler(f.root, async () => { calls++; return {}; }).tick(now + 5000);
    assert.equal(calls, 1); release(); await first;
  } finally { release(); await f.close(); }
});
test('同時追加、一時停止、再開、削除を永続化する', async () => {
  const f = await fixture();
  try {
    const input = { prompt: '管理確認', timing: { everyMs: 1000 } };
    const [task] = await Promise.all([f.scheduler.add(input, now), new TaskScheduler(f.root).add(input, now)]);
    assert.equal((await f.scheduler.list()).length, 2);
    await f.scheduler.manage(task.id, 'pause'); await f.scheduler.tick(now + 1000);
    assert.equal((await f.scheduler.list()).find(row => row.id === task.id)?.lastRun, undefined);
    await f.scheduler.manage(task.id, 'resume', now + 5000);
    assert.equal((await f.scheduler.list()).find(row => row.id === task.id)?.nextRunAt, new Date(now + 6000).toISOString());
    await f.scheduler.manage(task.id, 'remove'); assert.equal((await f.scheduler.list()).length, 1);
  } finally { await f.close(); }
});
test('失敗を保存し、定期実行は次の予定を維持する', async () => {
  const f = await fixture(async () => { throw new Error('検証用の失敗'); });
  try {
    await f.scheduler.add({ prompt: '失敗確認', timing: { everyMs: 1000 } }, now);
    await f.scheduler.tick(now + 1000); const task = (await f.scheduler.list())[0];
    assert.equal(task.lastRun?.status, 'failed'); assert.match(task.lastRun!.error!, /検証用/); assert.equal(task.running, undefined); assert.equal(task.enabled, true);
  } finally { await f.close(); }
});
test('毎日の時刻を日本時間と夏時間移行日で正しく計算する', () => {
  assert.equal(nextDaily('09:30', 'Asia/Tokyo', now), now + 30 * 60000);
  const spring = Date.parse('2030-03-10T06:59:00Z');
  assert.equal(new Date(nextDaily('02:30', 'America/New_York', spring)).toISOString(), '2030-03-11T06:30:00.000Z');
  assert.throws(() => nextDaily('25:00', 'Asia/Tokyo', now));
  assert.throws(() => nextDaily('09:00', 'invalid/zone', now));
  assert.equal(new Date(nextDaily('01:30', 'America/New_York', Date.parse('2030-11-03T05:30:00Z'), true)).toISOString(), '2030-11-04T06:30:00.000Z');
});
test('日時、間隔、空の依頼文を検証し、不正な予約を保存しない', async () => {
  const f = await fixture();
  try {
    for (const timing of [{ at: '2030-01-01T10:00:00' }, { at: '2020-01-01T10:00:00Z' }, { everyMs: 0 }, { everyMs: NaN }]) await assert.rejects(f.scheduler.add({ prompt: '確認', timing }, now));
    await assert.rejects(f.scheduler.add({ prompt: ' ', timing: { everyMs: 1000 } }, now));
    assert.equal((await f.scheduler.list()).length, 0);
  } finally { await f.close(); }
});
test('予約コマンド（Command）の引数を検証する', async () => {
  const f = await fixture();
  try {
    await scheduleCommand(['add', '--every', '10m', '--prompt', '確認 --goal list'], f.scheduler);
    const task = (await f.scheduler.list())[0]; assert.deepEqual(task.timing, { everyMs: 600000 }); assert.equal(task.prompt, '確認 --goal list');
    await assert.rejects(scheduleCommand(['add', '--every', '10m', '--at', '2030-01-01T00:00:00Z', '--prompt', '確認'], f.scheduler));
    await assert.rejects(scheduleCommand(['add', '--every', 'invalid', '--prompt', '確認'], f.scheduler));
    await assert.rejects(scheduleCommand(['pause'], f.scheduler));
  } finally { await f.close(); }
});
test('壊れた保存データを空の予約一覧で上書きしない', async () => {
  const f = await fixture();
  try { await writeFile(path.join(f.root, 'tasks.json'), 'broken'); await assert.rejects(f.scheduler.add({ prompt: '確認', timing: { everyMs: 1000 } }, now)); }
  finally { await f.close(); }
});

test('実際のAgent子プロセスで予約依頼を実行し、ログへ回答を保存する', { timeout: 20000 }, async () => {
  const f = await fixture(runScheduledAgent); const previousRoot = process.env.WENTIAN_SCHEDULE_ROOT;
  process.env.WENTIAN_SCHEDULE_ROOT = f.root;
  const prompt = '予約確認 --goal list'; let received = '';
  // ローカルの偽API（API）で応答し、外部サービスや外部Agentへ接続しません。
  const server = createServer((request, response) => {
    // 新しいMCPツール発見経路も模擬し、会話POST以外をJSON本文として解釈しません。
    if (request.url === '/api/mcp/agent-tools') {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ tools: [] })); return;
    }
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const plan = { intent: 'chat', operation: 'answer', language: 'ja', text: prompt, attachments: [], required_capabilities: ['text'], tools: [], delegation: { enabled: false, parallel: false, requested_agents: [] } };
      const payload = JSON.parse(body);
      const isPlan = request.headers['x-wentian-decision-kind'] === 'task-plan';
      const isConversation = request.headers['x-wentian-decision-kind'] === 'conversation-turn';
      if (!isPlan) received = payload.messages.find((item: { role: string }) => item.role === 'user')?.content || '';
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: isPlan ? JSON.stringify(plan) : isConversation ? JSON.stringify({ kind: 'answer', language: 'ja', answer: '予約実行の検証成功' }) : '予約実行の検証成功' } }] }));
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    await f.scheduler.add({ prompt, timing: { everyMs: 1000 }, workspace: f.root, server: `http://127.0.0.1:${address.port}` }, now);
    await f.scheduler.tick(now + 1000);
    const result = (await f.scheduler.list())[0].lastRun;
    assert.equal(result?.status, 'completed', result?.error || '予約実行結果'); assert.ok(received.includes(prompt));
    const { readFile } = await import('node:fs/promises'); assert.match(await readFile(result!.logPath!, 'utf8'), /予約実行の検証成功/);
  } finally {
    if (previousRoot === undefined) delete process.env.WENTIAN_SCHEDULE_ROOT; else process.env.WENTIAN_SCHEDULE_ROOT = previousRoot;
    await new Promise<void>(resolve => server.close(() => resolve())); await f.close();
  }
});
