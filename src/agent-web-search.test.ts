import assert from 'node:assert/strict';
import test from 'node:test';
import { searchPublicWeb, withGroupWebSearch, registerAgentWebSearch } from './agent-web-search.js';
import Fastify from 'fastify';

test('共通検索APIは認証・同一サイト・検索語の検証を行う', async () => {
  const app = Fastify(); let calls = 0;
  registerAgentWebSearch(app, (req, reply) => { if (req.headers.authorization === 'Bearer test') return true; reply.code(401).send({ error: '認証が必要です。' }); return false; }, async query => { calls++; return { query, retrievedAt: new Date().toISOString(), results: [] }; });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/web/search', payload: { query: '資料' } })).statusCode, 401);
    const headers = { authorization: 'Bearer test' };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/web/search', headers: { ...headers, origin: 'https://foreign.example' }, payload: { query: '資料' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/web/search', headers, payload: { query: '' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/web/search', headers, payload: { query: '公開資料' } })).statusCode, 200);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('共通検索はRSSを出典付き資料へ変換し、不正URLと過大な検索語を拒否する', async () => {
  let requested = '';
  const search = await searchPublicWeb('資料 & 比較', undefined, (async url => {
    requested = String(url);
    return new Response('<rss><channel><item><title>公式資料</title><link>https://example.org/docs</link><description>説明</description></item><item><link>javascript:alert(1)</link></item></channel></rss>');
  }) as typeof fetch);
  assert.equal(new URL(requested).searchParams.get('q'), '資料 & 比較');
  assert.equal(search.results.length, 1); assert.equal(search.results[0].url, 'https://example.org/docs');
  await assert.rejects(searchPublicWeb('x'.repeat(401)), /400/);
});

test('全モデルのグループ回答はAIが検索を選択し、取得資料を参照して出典を記録する', async () => {
  for (const model of ['wentian-agent/auto', 'external/opencode', 'provider/model']) {
    let searches = 0;
    const respond = withGroupWebSearch(async (_member, messages, context) => {
      if (context?.researchSelection) return '{"search":true,"query":"公開の設計資料"}';
      assert.ok(messages[0].content.includes('https://example.org/official'));
      return '取得資料に基づく回答';
    }, async query => { searches++; return { query, retrievedAt: new Date().toISOString(), results: [{ title: '公式', url: 'https://example.org/official', snippet: '外部資料' }] }; });
    const result = await respond({ name: '担当', role: '検討', model }, [{ role: 'system', content: '検討' }, { role: 'user', content: '調査' }]);
    assert.equal(searches, 1); assert.ok(String(result).includes('Web検索記録'));
  }
});

test('成果案の更新ではWeb資料を渡してもJSONの末尾へ記録を追記しない', async () => {
  let searches = 0;
  const respond = withGroupWebSearch(async (_member, messages, context) => {
    if (context?.researchSelection) return '{"search":true,"query":"公開資料"}';
    if (context?.outcomePhase === 'revise') assert.match(messages[0].content, /example.org/);
    return '{"draft":"資料に基づく成果","changes":["出典を追加"],"issues":[]}';
  }, async query => { searches++; return { query, retrievedAt: new Date().toISOString(), results: [{ title:'資料',url:'https://example.org/source',snippet:'公開資料' }] }; });
  const member = { name:'担当',role:'検討',model:'mock' }, messages = [{role:'system',content:'JSONのみ'},{role:'user',content:'依頼'}];
  assert.equal(JSON.parse(String(await respond(member,messages,{groupId:'g',usedAgents:[],outcomePhase:'revise'}))).draft,'資料に基づく成果');
  await respond(member,messages,{groupId:'g',usedAgents:[],outcomePhase:'review'});assert.equal(searches,1);
});

test('検索不要・不正なAI判断・検索障害は捏造せず、合意JSONは検索で変更しない', async () => {
  for (const decision of ['{"search":false}', '不正JSON', '{"search":true,"query":"資料"}']) {
    let searches = 0;
    const respond = withGroupWebSearch(async (_m, _messages, context) => context?.researchSelection ? decision : '回答', async () => { searches++; throw new Error('検索障害'); });
    const member = { name: '担当', role: '検討', model: 'mock' };
    const result = await respond(member, []);
    assert.equal(searches, decision.includes('true') ? 1 : 0);
    assert.ok(String(result).includes(decision.includes('false') ? '回答' : '未確認'));
    assert.equal(await respond(member, [], { groupId: 'g', usedAgents: [], phase: 'proposal' }), '回答');
  }
});
