import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { AgentGroupStore, namedMembers, formatGroupConclusion, type GroupResponder } from './agent-group.js';
import { parseConsensusProposal, parseConsensusVote } from './group-consensus.js';
import { registerWorkbench } from './workbench.js';

const proposal = { conclusion: '会話グループへ失敗理由と実担当の表示を追加する。', actionPlan: ['保存済みの実担当と失敗理由を履歴の先頭へ表示する。'], verification: ['空回答を返す試験用応答で失敗表示と保存履歴を比較する。'], unresolved: [] as string[] };

async function temporary(fn: (store: AgentGroupStore) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-consensus-'));
  try { await fn(new AgentGroupStore(root)); } finally { await rm(root, { recursive: true, force: true }); }
}

test('全員が同じ案へ同意したときだけ早期終了し、結論と手順を保存する', async () => {
  await temporary(async store => {
    const group = await store.create('合意', namedMembers(['甲', '乙'])); let speeches = 0;
    const respond: GroupResponder = async (_member, _messages, context) => {
      if (context?.phase === 'proposal') return JSON.stringify(proposal);
      if (context?.phase === 'vote') return JSON.stringify({ candidateId: context.candidateId, agree: true, reason: '役割から確認し実施可能と判断した。', objections: [] });
      speeches++; return `具体案${speeches}`;
    };
    const result = await store.discuss(group.id, '改善の結論を出す', 1, respond, undefined, { untilConsensus: true, maxRounds: 4 });
    assert.equal(speeches, 2);
    assert.equal(result.discussion?.stopReason, 'consensus');
    assert.equal(result.discussion?.roundsCompleted, 1);
    assert.deepEqual((await store.load(group.id)).discussion?.conclusion, proposal);
    assert.equal(result.discussion?.checks?.[0].votes.length, 2);
    assert.match(formatGroupConclusion(result.discussion!), /合意成立/);
  });
});

test('反対理由を次周へ渡し、解消後の全員同意で自動終了する', async () => {
  await temporary(async store => {
    const group = await store.create('続行', namedMembers(['甲', '乙'])); let round = 0;
    const result = await store.discuss(group.id, '改善', 1, async (member, messages, context) => {
      if (context?.phase === 'proposal') { round++; return JSON.stringify(proposal); }
      if (context?.phase === 'vote') { const dissent = round === 1 && member.name === '乙'; return JSON.stringify({ candidateId: context.candidateId, agree: !dissent, reason: dissent ? '同時編集の検証条件が不足している。' : '条件を確認した。', objections: dissent ? ['同時編集の検証を追加する。'] : [] }); }
      if (round === 1) assert.match(messages[1].content, /同時編集の検証/);
      return '同時編集の失敗条件も含めた改善案を検討する。';
    }, undefined, { untilConsensus: true, maxRounds: 3 });
    assert.equal(result.discussion?.roundsCompleted, 2);
    assert.deepEqual(result.discussion?.checks?.map(check => check.agreed), [false, true]);
    assert.equal(result.messages.length, 5);
  });
});

test('整理担当が合意を主張しても未解決点や反対があれば上限で未合意停止する', async () => {
  await temporary(async store => {
    const group = await store.create('未解決', namedMembers(['甲']));
    const result = await store.discuss(group.id, '改善', 1, async (_member, _messages, context) => {
      if (context?.phase === 'proposal') return JSON.stringify({ ...proposal, unresolved: ['対象データが不足している。'], everyoneAgreed: true });
      if (context?.phase === 'vote') return JSON.stringify({ candidateId: context.candidateId, agree: true, reason: '仮案としてはよい。', objections: [] });
      return '情報不足を解決するための確認案を示す。';
    }, undefined, { untilConsensus: true, maxRounds: 2 });
    assert.equal(result.discussion?.status, 'inconclusive');
    assert.equal(result.discussion?.stopReason, 'round_limit');
    assert.equal(result.discussion?.conclusion, undefined);
    assert.match(formatGroupConclusion(result.discussion!), /対象データが不足/);
    // 人間が追加議題で再実行した場合も、前回の反対理由と判定記録を保持します。
    const resumed = await store.discuss(group.id, '不足情報を補って続行', 1, async (_member, messages, context) => {
      if (context?.phase === 'proposal') return JSON.stringify(proposal);
      if (context?.phase === 'vote') return JSON.stringify({ candidateId: context.candidateId, agree: true, reason: '不足情報を補った。', objections: [] });
      assert.match(messages[1].content, /対象データが不足/); return '不足情報を補う具体案。';
    }, undefined, { untilConsensus: true, maxRounds: 2 });
    assert.equal(resumed.discussionHistory?.[0].stopReason, 'round_limit');
    assert.equal(resumed.discussion?.stopReason, 'consensus');
    await store.member(group.id, 'remove', '甲');
  });
});

test('別案への同意や不正な判定は失敗として保存し、途中の賛否とロック解除を保持する', async () => {
  await temporary(async store => {
    const group = await store.create('不正判定', namedMembers(['甲', '乙']));
    await assert.rejects(store.discuss(group.id, '改善', 1, async (member, _messages, context) => {
      if (context?.phase === 'proposal') return JSON.stringify(proposal);
      if (context?.phase === 'vote') return JSON.stringify({ candidateId: member.name === '乙' ? '0'.repeat(64) : context.candidateId, agree: true, reason: '確認済み。', objections: [] });
      return '提案を検討する。';
    }, undefined, { untilConsensus: true, maxRounds: 2 }), /別の結論案/);
    const saved = await store.load(group.id);
    assert.equal(saved.discussion?.status, 'failed');
    assert.equal(saved.discussion?.checks?.[0].votes.length, 1);
    assert.equal(saved.messages.length, 3);
    await store.member(group.id, 'remove', '乙');
    assert.throws(() => parseConsensusVote('{"agree":"true"}'), /不正/);
    assert.throws(() => parseConsensusProposal('{"conclusion":"結論のみ"}'), /不正/);
  });
});

test('最小周回数を守り、無効な上限は開始前に拒否する', async () => {
  await temporary(async store => {
    const group = await store.create('最小周回', namedMembers(['甲'])); let speechCount = 0;
    await assert.rejects(store.discuss(group.id, '改善', 2, async () => '', undefined, { untilConsensus: true, maxRounds: 1 }), /最大周回/);
    assert.equal((await store.load(group.id)).messages.length, 0);
    const result = await store.discuss(group.id, '改善', 2, async (_member, _messages, context) => {
      if (context?.phase === 'proposal') { assert.equal(speechCount, 2); return JSON.stringify(proposal); }
      if (context?.phase === 'vote') return JSON.stringify({ candidateId: context.candidateId, agree: true, reason: '検討した。', objections: [] });
      speechCount++; return '検討する。';
    }, undefined, { untilConsensus: true, maxRounds: 3 });
    assert.equal(result.discussion?.roundsCompleted, 2);
  });
});

test('時間上限を合意成立と扱わず、確定履歴を残して停止する', async t => {
  // 実時間を待たず、時間上限のAbortSignalだけを再現します。
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new Error('試験用時間上限')));
  await temporary(async store => {
    const group = await store.create('時間上限', namedMembers(['甲']));
    const result = await store.discuss(group.id, '改善', 1, async () => { throw new Error('呼ばれない'); }, undefined, { untilConsensus: true });
    assert.equal(result.discussion?.stopReason, 'time_limit');
    assert.equal(result.discussion?.status, 'inconclusive');
    assert.equal(result.messages.length, 1);
    await store.member(group.id, 'remove', '甲');
  });
});

test('工作台APIでも同じ合意判定を実行する', async () => {
  await temporary(async store => {
    const group = await store.create('API合意', namedMembers(['甲'])); await store.configureAutonomy(group.id,{enabled:false,workflow:'free'}); const app = Fastify();
    registerWorkbench(app, { workspace: store.workspace, authorize: () => true, models: async () => [], providerSaved: () => {}, testModel: async () => '', groupRespond: async (_member, _messages, context) => context?.phase === 'proposal' ? JSON.stringify(proposal) : context?.phase === 'vote' ? JSON.stringify({ candidateId: context.candidateId, agree: true, reason: '役割から同意する。', objections: [] }) : '検討する。' });
    try {
      const response = await app.inject({ method: 'POST', url: `/api/workbench/groups/${group.id}/discuss`, payload: { prompt: '改善', rounds: 1, untilConsensus: true, maxRounds: 3 } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().discussion.stopReason, 'consensus');
    } finally { await app.close(); }
  });
});
