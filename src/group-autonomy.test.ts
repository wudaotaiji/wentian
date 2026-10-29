import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { AgentGroupStore, GroupBusyError, namedMembers, type GroupResponder } from './agent-group.js';
import { startGroupAutonomy } from './group-autonomy.js';
import { registerWorkbench } from './workbench.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('人間への返答の進行を保存し、自律討論は競合してもエラー停止しない', async () => {
  await temporary(async (store, root) => {
    const group = await store.create('返答と自律討論', namedMembers(['甲']));
    await store.configureAutonomy(group.id, { workflow: 'free', enabled: true });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const reply = store.replyToHuman(group.id, '質問', async () => { entered(); await gate; return '人間への実際の返答'; });
    await started;
    const manager = startGroupAutonomy({ workspace: root, store, respond: async () => '未実行' });
    try { assert.equal((await store.load(group.id)).humanReply?.status, 'running'); await manager.runOnce(group.id); assert.equal((await store.load(group.id)).autonomy?.paused, undefined); }
    finally { release(); await reply; await manager.stop(); }
    const saved = await store.load(group.id); assert.equal(saved.humanReply?.status, 'completed'); assert.equal(saved.humanReply?.completedTurns, 1);
    const discuss = store.discuss.bind(store); store.discuss = async () => { throw new GroupBusyError(); };
    try { await manager.runOnce(group.id); assert.equal((await store.load(group.id)).autonomy?.paused, undefined); } finally { store.discuss = discuss; }
  });
});

test('人間への返答失敗も進行と確定済み発言を残す', async () => {
  await temporary(async store => {
    const group = await store.create('返答失敗', namedMembers(['甲', '乙']));
    await assert.rejects(store.replyToHuman(group.id, '質問', async member => { if (member.name === '乙') throw new Error('接続障害'); return '確定した返答'; }), /接続障害/);
    const saved = await store.load(group.id); assert.equal(saved.humanReply?.status, 'failed'); assert.equal(saved.humanReply?.completedTurns, 1); assert.equal(saved.messages.at(-1)?.content, '確定した返答');
  });
});

test('継続モードは自然終了後に休憩し次の討論を実行し、手動停止とエラーは維持する', async () => {
  await temporary(async (store, root) => {
    const group = await store.create('継続', namedMembers(['甲', '乙']));
    await store.configureAutonomy(group.id, { workflow: 'free', enabled: true, mode: 'continuous', restSeconds: 15, maxRounds: 2, maxMinutes: 5 });
    const manager = startGroupAutonomy({ workspace: root, store, respond: consensusRespond });
    try {
      await manager.runOnce(group.id);
      const first = await store.load(group.id);
      assert.equal(first.autonomy?.paused, undefined); assert.ok(first.autonomy?.nextRunAt);
      assert.equal(first.autonomy?.completedCycles, 1);
      await manager.runOnce(group.id);
      assert.equal((await store.load(group.id)).autonomy?.completedCycles, 1, '休憩中には実行しない');
      const file = path.join(root, '.wentian', 'groups', group.id + '.json.autonomy');
      await writeFile(file, JSON.stringify({ ...first.autonomy, nextRunAt: new Date(0).toISOString() }));
      await manager.runOnce(group.id);
      assert.equal((await store.load(group.id)).autonomy?.completedCycles, 2);
      for (const reason of ['round_limit', 'time_limit'] as const) { await store.completeAutonomyCycle(group.id, reason); assert.equal((await store.load(group.id)).autonomy?.paused, undefined); }
      await store.completeAutonomyCycle(group.id, 'error'); assert.equal((await store.load(group.id)).autonomy?.paused?.reason, 'error');
      await store.pauseAutonomy(group.id, 'disabled'); await store.resumeAfterShutdown(group.id);
      assert.equal((await store.load(group.id)).autonomy?.paused, undefined, '継続設定はサーバーの協調終了後も継続する');
      await store.configureAutonomy(group.id, { workflow: 'free', enabled: true, mode: 'bounded' });
      await store.pauseAutonomy(group.id, 'disabled'); await store.resumeAfterShutdown(group.id);
      assert.equal((await store.load(group.id)).autonomy?.paused?.reason, 'disabled', '上限付き設定の停止は解除しない');
      await store.configureAutonomy(group.id, { workflow: 'free', enabled: false });
      await manager.runOnce(group.id); assert.equal((await store.load(group.id)).autonomy?.enabled, false);
      await store.resumeAfterShutdown(group.id); assert.equal((await store.load(group.id)).autonomy?.enabled, false);
      await assert.rejects(store.configureAutonomy(group.id, { workflow: 'free', enabled: true, restSeconds: 0 }), /15〜3600/);
      await assert.rejects(store.configureAutonomy(group.id, { workflow: 'free', enabled: true, mode: 'unknown' as any }), /モード/);
    } finally { await manager.stop(); }
  });
});

test('人間への応答後は自律討論を再開し、手動停止・合意・上限停止は保持する', async () => {
  await temporary(async store => {
    const group = await store.create('会話継続', namedMembers(['甲']));
    await store.configureAutonomy(group.id, { workflow: 'free', enabled: true, maxRounds: 2, maxMinutes: 5 });
    await store.pauseAutonomy(group.id, 'human'); await store.resumeAfterHuman(group.id);
    assert.equal((await store.load(group.id)).autonomy?.paused, undefined);
    for (const reason of ['disabled', 'consensus', 'round_limit', 'time_limit'] as const) {
      await store.pauseAutonomy(group.id, reason); await store.resumeAfterHuman(group.id);
      assert.equal((await store.load(group.id)).autonomy?.paused?.reason, reason);
    }
    await store.configureAutonomy(group.id, { workflow: 'free', enabled: false }); await store.resumeAfterHuman(group.id);
    assert.equal((await store.load(group.id)).autonomy?.enabled, false);
  });
});

test('初回巡回中の終了を待ち、終了後に自律討論を起動しない', async () => {
  await temporary(async (store, root) => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    store.list = async () => { entered(); await gate; return []; };
    const manager = startGroupAutonomy({ workspace: root, store, respond: consensusRespond });
    manager.start(); await ready;
    let stopped = false;
    const closing = manager.stop().then(() => { stopped = true; });
    await delay(10); assert.equal(stopped, false);
    release(); await closing; assert.equal(stopped, true);
  });
});

test('常駐巡回は人間の投稿なしで討論し、停止後の巡回で再実行しない', async () => {
  await temporary(async (store, root) => {
    const group = await store.create('常駐起動', namedMembers(['甲', '乙']));
    await store.configureAutonomy(group.id, { workflow: 'free', enabled: true, maxRounds: 2, maxMinutes: 5 });
    let calls = 0;const errors:unknown[]=[];
    const manager = startGroupAutonomy({ workspace: root, store, intervalMs: 20, onError:error=>errors.push(error),respond: async (...args) => { calls++; return consensusRespond(...args); } });
    manager.start();
    try {
      for (let i = 0; i < 100 && !(await store.load(group.id)).autonomy?.paused; i++) await delay(20);
      const result = await store.load(group.id);
      assert.equal(result.autonomy?.paused?.reason, 'consensus',JSON.stringify({paused:result.autonomy?.paused,discussion:result.discussion?.error,errors:errors.map(error=>String(error))}));
      assert.ok(result.messages.length >= 2);
      const count = calls; await delay(80); assert.equal(calls, count);
    } finally { await manager.stop(); }
  });
});
async function temporary(action: (store: AgentGroupStore, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-autonomy-'));
  try { await action(new AgentGroupStore(root), root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
/** 合意までに必要な提案・賛否を、内容を固定せず形式だけで返す模擬応答です。 */
const consensusRespond: GroupResponder = async (member, _messages, context) => {
  if (context?.phase === 'proposal') return JSON.stringify({ conclusion: '採用する結論案', actionPlan: ['実施手順'], verification: ['確認方法'], unresolved: [] });
  if (context?.phase === 'vote') return JSON.stringify({ candidateId: context.candidateId!, agree: true, reason: member.role, objections: [] });
  return `提案: ${member.name}の提案\n理由: 役割に基づく検討\n確認方法: 実施して確認する`;
};

test('自律モードの議論は人間の議題を履歴へ偽装せず、合意まで続行する', async () => {
  await temporary(async store => {
    const group = await store.create('自律検討', namedMembers(['甲', '乙']));
    const result = await store.discuss(group.id, 'これまでの会話を継続してください。', 1, consensusRespond, undefined, { untilConsensus: true, maxRounds: 2, injectPrompt: false });
    assert.equal(result.messages.some(message => message.speaker === 'ユーザー'), false);
    assert.ok(result.messages.every(message => message.kind !== 'human'));
    assert.equal(result.discussion?.status, 'completed');
    assert.equal(result.discussion?.stopReason, 'consensus');
  });
});

test('人間の停止条件は確定済みの発言を残して stopped へ遷移する', async () => {
  await temporary(async store => {
    const group = await store.create('停止条件', namedMembers(['甲', '乙']));
    let stop = false;
    const result = await store.discuss(group.id, '継続', 1, async (member, _messages, context) => {
      if (context?.phase) return consensusRespond(member, _messages, context);
      if (member.name === '甲') stop = true;
      return `提案: ${member.name}\n理由: 役割\n確認方法: 確認する`;
    }, undefined, { untilConsensus: true, maxRounds: 5, injectPrompt: false, shouldStop: () => stop ? 'human' : undefined });
    assert.equal(result.discussion?.status, 'stopped');
    assert.equal(result.discussion?.stopReason, 'human');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].speaker, '甲');
  });
});

test('自律討論の設定は別台帳へ保存し、本体の会話記録へ混ざらない', async () => {
  await temporary(async (store, root) => {
    const group = await store.create('設定', namedMembers(['甲']));
    const saved = await store.configureAutonomy(group.id, { workflow: 'free', enabled: true, maxRounds: 3, maxMinutes: 12, updatedBy: 'admin' });
    assert.deepEqual(saved.autonomy, { workflow: 'free', enabled: true, maxRounds: 3, maxMinutes: 12, mode: 'bounded', restSeconds: 60, completedCycles: 0, updatedAt: saved.autonomy!.updatedAt, updatedBy: 'admin' });
    await store.pauseAutonomy(group.id, 'human');
    const paused = await store.load(group.id);
    assert.equal(paused.autonomy?.paused?.reason, 'human');
    assert.equal(paused.autonomy?.lastRunAt !== undefined, true);
    const main = JSON.parse(await readFile(path.join(root, '.wentian', 'groups', group.id + '.json'), 'utf8'));
    assert.equal('autonomy' in main, false);
    await assert.rejects(store.configureAutonomy(group.id, { workflow: 'free', enabled: true, maxRounds: 0 }), /1〜20/);
    await assert.rejects(store.configureAutonomy(group.id, { workflow: 'free', enabled: true, maxMinutes: 0 }), /1〜120/);
  });
});

test('落ちた実行の古いロックだけを回収し、生きているロックは残す', async () => {
  await temporary(async (store, root) => {
    const group = await store.create('復旧', namedMembers(['甲']));
    await store.configureAutonomy(group.id, { workflow: 'free', enabled: true, maxRounds: 2, maxMinutes: 5 });
    const file = path.join(root, '.wentian', 'groups', group.id + '.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    data.discussion = { status: 'running', verdict: '未確認', maxRounds: 2, rounds: 1, roundsCompleted: 0, startedAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(data), 'utf8');
    const lockPath = file + '.lock';
    const old = new Date(Date.now() - 3600000);
    await writeFile(lockPath, 'stale', 'utf8'); await utimes(lockPath, old, old);
    assert.equal(await store.recoverStaleAutonomyRun(group.id, 60000), true);
    assert.equal((await store.load(group.id)).discussion?.status, 'failed');
    await writeFile(lockPath, 'fresh', 'utf8');
    assert.equal(await store.recoverStaleAutonomyRun(group.id, 60000), false);
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }), 'utf8'); await utimes(lockPath, old, old);
    assert.equal(await store.recoverStaleAutonomyRun(group.id, 60000), false, '古くても生きた所有者のロックは保護する');
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647 }), 'utf8');
    assert.equal(await store.recoverStaleAutonomyRun(group.id, 3600000), true, '終了済み所有者なら停止済み群の新しいロックも回収する');
  });
});

test('常駐管理器は有効なグループだけを実行し、合意成立で停止して再実行を抑える', async () => {
  await temporary(async (store, root) => {
    const group = await store.create('常駐検討', namedMembers(['甲', '乙']));
    const manager = startGroupAutonomy({ workspace: root, store, respond: consensusRespond, intervalMs: 3600000 });
    await manager.runOnce(group.id);
    const disabled = await store.load(group.id);
    assert.equal(disabled.messages.length, 0, '無効なグループは発言しない');
    await store.configureAutonomy(group.id, { workflow: 'free', enabled: true, maxRounds: 2, maxMinutes: 5 });
    await manager.runOnce(group.id);
    const run = await store.load(group.id);
    assert.ok(run.messages.length >= 2);
    assert.ok(run.messages.every(message => message.speaker !== 'ユーザー'));
    assert.equal(run.discussion?.stopReason, 'consensus');
    assert.equal(run.autonomy?.paused?.reason, 'consensus');
    assert.equal(run.autonomy?.lastRunAt !== undefined, true);
    await manager.stop();
  });
});

test('人間の投稿は実行中の自律討論を止め、停止後にだけ返答する', async () => {
  await temporary(async (store, root) => {
    const group = await store.create('参加', namedMembers(['甲', '乙']));
    await store.configureAutonomy(group.id, { workflow: 'free', enabled: true, maxRounds: 5, maxMinutes: 5 });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const manager = startGroupAutonomy({ workspace: root, store, intervalMs: 3600000, respond: async (member, _messages, context) => {
      if (context?.phase) return consensusRespond(member, _messages, context);
      if (member.name === '甲') { started(); await gate; }
      return `提案: ${member.name}\n理由: 役割\n確認方法: 確認する`;
    } });
    const running = manager.runOnce(group.id);
    await ready;
    const stopping = manager.humanActivity(group.id);
    release();
    await stopping; await running;
    const stopped = await store.load(group.id);
    assert.equal(stopped.discussion?.status, 'stopped');
    assert.equal(stopped.discussion?.stopReason, 'human');
    assert.equal(stopped.autonomy?.paused?.reason, 'human');
    await manager.stop();
  });
});

test('工作台APIで管理者だけが自律討論を開始・停止でき、人間の投稿で自動停止する', async () => {
  await temporary(async (_store, root) => {
    const app = Fastify();
    let humanStopped = 0;
    registerWorkbench(app, {
      workspace: root, models: async () => [{ id: 'mock/model' }], providerSaved: () => {}, testModel: async () => 'ok',
      authorize: (req, reply) => { if (req.headers.authorization === 'Bearer admin') return true; reply.code(401).send({ error: { message: 'ログインが必要' } }); return false; },
      groupIdentity: () => ({ id: 'alice', name: 'Alice', admin: true }),
      groupRespond: async member => `${member.name}の返答`,
      groupAutonomy: { humanActivity: async () => { humanStopped++; }, stop: async () => undefined },
    });
    const headers = { authorization: 'Bearer admin' };
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as object });
    try {
      const group = (await post('/api/workbench/groups', { title: '自律', names: ['甲', '乙'] })).json();
      const base = `/api/workbench/groups/${group.id}`;
      assert.equal((await app.inject({ method: 'POST', url: base + '/autonomy', payload: { workflow: 'free', enabled: true } })).statusCode, 401);
      const saved = await post(base + '/autonomy', { workflow: 'free', enabled: true, maxRounds: 3, maxMinutes: 10 });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().autonomy.enabled, true);
      assert.equal(saved.json().autonomy.maxRounds, 3);
      const rejected = await post(base + '/autonomy', { workflow: 'free', enabled: true, maxRounds: 50 });
      assert.equal(rejected.statusCode, 400);
      await post(base + '/join', { presence: 'online' });
      const posted = await post(base + '/messages', { content: 'みなさん、進めてください。' });
      assert.equal(posted.statusCode, 200, posted.body);
      for (let index = 0; index < 60 && humanStopped === 0; index++) await delay(20);
      assert.equal(humanStopped, 1);
      for (let index = 0; index < 60; index++) { const current = await app.inject(base); if (current.json().messages.some((message: any) => message.speaker === '甲')) break; await delay(20); }
      const final = (await app.inject(base)).json();
      assert.ok(final.messages.some((message: any) => message.content === '甲の返答'));
      const stopped = await post(base + '/autonomy', { workflow: 'free', enabled: false });
      assert.equal(stopped.statusCode, 200);
      assert.equal(stopped.json().autonomy.enabled, false);
    } finally { await app.close(); }
  });
});
