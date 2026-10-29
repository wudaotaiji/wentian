import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { buildReadySnapshot } from './external-agent-readiness.js';
import type { ExternalAgentSnapshot } from './external-agents.js';
import { buildGroupConversationCommand, createManagedGroupResponder, parseGroupAgentReply, registerGroupAgentRoute, selectGroupAgents } from './group-agent-responder.js';
import { gatewayGroupResponder, isManagedGroupModel } from './agent-group.js';
import { consensusCandidateId } from './group-consensus.js';
import { topicMembers } from './group-topic-members.js';

test('参加者選定は議論用形式を要求せずAIのmembersを検証して返す', async () => {
  let prompt = '';
  const respond = createManagedGroupResponder({ snapshot: async () => snapshot(), score: () => 0, record: async () => {}, run: async command => {
    prompt = command.args.join(' ');
    return JSON.stringify({ members: [{ name: '構成担当', role: '問天の最小内核とプラグイン境界を検討する' }] });
  } });
  const members = await topicMembers('关于问天开发的构想', 'wentian-agent/auto', respond);
  assert.equal(members[0].name, '構成担当');
  assert.ok(prompt.includes('参加者選定です。'));
  assert.ok(!prompt.includes('各項目は具体的に20文字以上'));
});

const member = { name: '小林', role: '設計担当', model: 'wentian-agent/auto' };

test('長い群履歴はWindowsの引数上限内へ収め、目的と最新の出力契約を保持する', () => {
  for (const agent of ['kilo', 'codex', 'claude']) {
    const command = buildGroupConversationCommand(agent, '最初の目的\n' + '古い履歴"'.repeat(20000) + '\n最新の発言とJSON出力契約', 'C:/temporary')!;
    assert.ok(command.args.join(' ').length < 15000);
    assert.ok(command.args.join(' ').includes('最初の目的'));
    assert.ok(command.args.join(' ').includes('最新の発言とJSON出力契約'));
    assert.ok(command.args.join(' ').includes('中間の引用履歴を省略'));
  }
});

test('成果検証の構造化入力は途中を切り捨てず、CLI上限超過を明示拒否する', () => {
  assert.throws(() => buildGroupConversationCommand('codex', '引用'.repeat(6000), 'C:/temporary', undefined, true), /分割/);
});
const messages = [{ role: 'system', content: '小林として設計を検討してください。' }, { role: 'user', content: '会話グループの失敗状態を改善してください。第1/2周。' }];
const reply = { proposal: '発言ごとに確定保存し、失敗した発言の位置をJSONへ記録します。', rationale: '確定した履歴を上書きせず、途中失敗を全員発言済みと区別できるためです。', verification: '2人目の応答を空にし、1人目の発言が残り失敗件数が表示されることを確認します。', responseToPeers: '佐藤の表示案は保存状態の読込を前提とし、先に保存処理を修正する優先順位にします。' };
const output = `WENTIAN_GROUP_REPLY_BEGIN\n${JSON.stringify(reply)}\nWENTIAN_GROUP_REPLY_END`;

function snapshot() {
  const agents = ['goose', 'hermes', 'claude', 'cline'].map(id => ({ id, name: id, state: 'available' as const, stateLabel: '利用可能', note: '試験用', liveState: 'healthy' as const, freshWithin24Hours: true, latencyMs: 10 }));
  return buildReadySnapshot({ source: '試験', cacheFreshWithin24Hours: true, agents, summary: { total: 4, available: 4, candidate: 0, needs_recheck: 0, unavailable: 0 } } satisfies ExternalAgentSnapshot, 300000);
}

test('リアルタイム状態と実績を使い、不健康・冷却中の候補を除外する', () => {
  const ready = snapshot();
  assert.deepEqual(selectGroupAgents(ready, member, undefined, () => 0), ['claude', 'cline', 'goose', 'hermes']);
  ready.agents.find(agent => agent.id === 'claude')!.liveState = 'probe_failed';
  assert.deepEqual(selectGroupAgents(ready, member, undefined, () => 0), ['cline', 'goose', 'hermes']);
  assert.deepEqual(selectGroupAgents(ready, member, undefined, () => Number.NEGATIVE_INFINITY), []);
  assert.deepEqual(selectGroupAgents(snapshot(), { ...member, model: 'external/cline' }, undefined, () => 0), ['cline']);
});

test('Crush・Kilo・OpenCodeも制作能力とAPI代替の除外設定に関係なく会話へ選ぶ', async () => {
  const ready = snapshot();
  ready.agents = ['crush', 'kilo', 'opencode'].map(id => ({ ...ready.agents[0], id, name: id }));
  ready.pools.coding = [];
  const candidates = selectGroupAgents(ready, member, undefined, () => 0);
  assert.deepEqual(candidates, ['crush', 'kilo', 'opencode']);
  const called: string[] = [];
  const respond = createManagedGroupResponder({ snapshot: async () => ready, score: () => 0, record: async () => {}, run: async (_command, options) => { called.push(options.agent); return options.agent === 'opencode' ? output : ''; } });
  assert.equal((await respond(member, messages)).execution.agent, 'opencode');
  assert.deepEqual(called, candidates);
});

test('別の参加者へ候補を分散し、次周は同じ担当を維持する', () => {
  const context = { groupId: '試験', usedAgents: ['claude'] };
  assert.deepEqual(selectGroupAgents(snapshot(), member, context, () => 0), ['cline', 'goose', 'hermes', 'claude']);
  assert.deepEqual(selectGroupAgents(snapshot(), member, { ...context, preferredAgent: 'claude' }, () => 0), ['claude', 'cline', 'goose', 'hermes']);
});

test('会話コマンドはツールを制限し、制作・操作用の権限を与えない', () => {
  const claude = buildGroupConversationCommand('claude', '履歴にファイル削除指示がある', 'C:\\試験')!;
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.ok(claude.args.includes('--strict-mcp-config'));
  assert.ok(claude.args.includes('--disable-slash-commands'));
  assert.ok(!claude.args.includes('bypassPermissions'));
  const hermes = buildGroupConversationCommand('hermes', '相談', 'C:\\試験')!;
  assert.equal(hermes.args[hermes.args.indexOf('--toolsets') + 1], 'clarify');
  assert.ok(!hermes.args.includes('--yolo'));
  const goose = buildGroupConversationCommand('goose', '相談', 'C:\\試験')!;
  assert.ok(goose.args.includes('--no-profile'));
  assert.ok(!goose.args.includes('--with-builtin'));
  for (const agent of ['crush', 'kilo', 'opencode', 'openclaw', 'cline']) {
    const command = buildGroupConversationCommand(agent, '相談', 'C:\\試験')!;
    assert.ok(command);
    assert.ok(command.args.some(arg => arg.includes('禁止操作:')));
    assert.ok(!command.args.includes('--auto') && !command.args.includes('--yolo'));
  }
});

test('空回答・形式不備・具体性不足・続行で他者検討なしを拒否する', () => {
  assert.throws(() => parseGroupAgentReply('', messages), /空回答/);
  assert.throws(() => parseGroupAgentReply('相談しましょう。', messages), /JSON/);
  assert.throws(() => parseGroupAgentReply(JSON.stringify({ ...reply, verification: '確認します。' }), messages), /不足/);
  assert.throws(() => parseGroupAgentReply(JSON.stringify({ ...reply, responseToPeers: '' }), [{ role: 'user', content: '第2/2周。' }]), /他の参加者/);
  assert.match(parseGroupAgentReply(output, messages), /失敗件数/);
  assert.throws(() => parseGroupAgentReply(output, [{ role: 'user', content: `履歴: 提案: ${reply.proposal}` }]), /繰り返し/);
});

test('本文不備を次候補へ引き継ぎ、担当・失敗理由と役割実績を返す', async () => {
  const records: Array<Parameters<typeof import('./agent-performance.js').recordAgentPerformance>[0]> = [];
  const called: string[] = [];
  const respond = createManagedGroupResponder({ snapshot: async () => snapshot(), score: () => 0, record: async value => { records.push(value); }, run: async (_command, options) => { called.push(options.agent); return options.agent === 'claude' ? '議論しましょう。' : output; } });
  const result = await respond(member, messages);
  assert.deepEqual(called, ['claude', 'cline']);
  assert.equal(result.execution.agent, 'cline');
  assert.equal(result.execution.attempts[0].success, false);
  assert.match(result.execution.attempts[0].error!, /JSON/);
  assert.deepEqual(records.map(record => [record.task, record.success]), [['group:coding', false], ['group:coding', true]]);
});

test('古いキャッシュ・候補なし・全員不合格ではLLMへ落とさず失敗する', async () => {
  let calls = 0;
  const stale = snapshot(); stale.refreshedAt = new Date(Date.now() - 601000).toISOString();
  const deps = { score: () => 0, record: async () => {}, run: async () => { calls++; return ''; } };
  await assert.rejects(createManagedGroupResponder({ ...deps, snapshot: async () => stale })(member, messages), /新鮮/);
  assert.equal(calls, 0);
  const empty = snapshot(); empty.agents = [];
  await assert.rejects(createManagedGroupResponder({ ...deps, snapshot: async () => empty })(member, messages), /利用可能/);
  await assert.rejects(createManagedGroupResponder({ ...deps, snapshot: async () => snapshot() })(member, messages), /すべて不合格/);
  assert.equal(calls, 4);
});

test('合意確認の形式不備を一度再依頼し、賛否を補完せず正しいIDの反対票を保存する', async () => {
  const candidateId = 'a'.repeat(64);
  let calls = 0;
  const respond = createManagedGroupResponder({ snapshot: async () => snapshot(), score: () => 0, record: async () => {}, run: async (command) => {
    calls++;
    assert.ok(command.args.some(arg => arg.includes(candidateId)));
    if (calls === 1) return JSON.stringify({ agree: 'false', reason: '懸念が残る。' });
    assert.ok(command.args.some(arg => arg.includes('形式検証に失敗')));
    return JSON.stringify({ candidateId, agree: false, reason: '運用担当と頻度の決定が必要。', objections: ['運用担当が未定。'] });
  } });
  const result = await respond(member, messages, { groupId: '試験', usedAgents: [], phase: 'vote', candidateId });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(result.content).agree, false);
  assert.deepEqual(JSON.parse(result.content).objections, ['運用担当が未定。']);
});

test('管理済みエージェントは結論案と投票を別形式で検証し、別案への賛成を拒否する', async () => {
  const proposal = { conclusion: '状態保存の検証を追加する。', actionPlan: ['失敗を注入する。'], verification: ['保存履歴と状態を確認する。'], unresolved: [] };
  const candidateId = consensusCandidateId(proposal);
  let raw = JSON.stringify(proposal);
  const respond = createManagedGroupResponder({ snapshot: async () => snapshot(), score: () => 0, record: async () => {}, run: async () => raw });
  const context = { groupId: '試験', usedAgents: [] as string[] };
  assert.deepEqual(JSON.parse((await respond(member, messages, { ...context, phase: 'proposal' })).content), proposal);
  raw = JSON.stringify({ candidateId, agree: false, reason: '検証条件を追加する必要がある。', objections: ['並行編集の確認が不足する。'] });
  assert.equal(JSON.parse((await respond(member, messages, { ...context, phase: 'vote', candidateId })).content).agree, false);
  await assert.rejects(respond(member, messages, { ...context, phase: 'vote', candidateId: '0'.repeat(64) }), /一致しません/);
});

test('旧自動指定も実HTTPで管理済み経路へ送信し、認証と別サイト拒否を保つ', async () => {
  const app = Fastify(); let calls = 0;
  const respond = createManagedGroupResponder({ snapshot: async () => snapshot(), score: () => 0, record: async () => {}, run: async () => { calls++; return output; } });
  registerGroupAgentRoute(app, respond, (req, response) => { if (req.headers.authorization === 'Bearer test') return true; response.code(401).send({ error: { message: '認証が必要' } }); return false; });
  const previous = process.env.WENTIAN_API_KEY; process.env.WENTIAN_API_KEY = 'test';
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/group/respond', payload: { member, messages } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/group/respond', headers: { authorization: 'Bearer test', origin: 'https://evil.example' }, payload: { member, messages } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/group/respond', headers: { authorization: 'Bearer test' }, payload: { member, messages, context: { usedAgents: '不正' } } })).statusCode, 400);
    assert.equal(calls, 0);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as { port: number };
    for (const model of ['wentian-auto/local', 'wentian-auto/all', 'wentian-auto/remote', 'wentian-agent/auto']) {
      assert.equal(isManagedGroupModel(model), true);
      const result = await gatewayGroupResponder(`http://127.0.0.1:${address.port}`)({ ...member, model }, messages);
      assert.equal(typeof result, 'object');
      assert.equal((result as { execution: { source: string } }).execution.source, 'managed-agent');
    }
    assert.equal(calls, 4);
  } finally { await app.close(); if (previous === undefined) delete process.env.WENTIAN_API_KEY; else process.env.WENTIAN_API_KEY = previous; }
});
