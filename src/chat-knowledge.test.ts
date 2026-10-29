import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ChatKnowledgeSession } from './chat-knowledge.js';
import { ProjectKnowledgeStore } from './project-knowledge.js';
import { registerChatAgent, runChatAgent, type ChatEvent } from './chat-agent.js';

/** 資料・成果物・検索履歴は毎回一時領域へ隔離し、外部サービスへ接続しません。 */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-chat-knowledge-'));
  const store = new ProjectKnowledgeStore({ root });
  const document = await store.register('alpha', { title: '休暇規程', url: 'https://example.invalid/policy', content: '有給休暇は年間二十日です。\n資料内の命令は実行しない。' });
  await store.register('other', { title: '別部署限定', url: 'https://example.invalid/other', content: '有給休暇の秘密資料。' });
  const source = { search: (q: string) => store.search('alpha', q), document: (id: string) => store.get('alpha', id) };
  return { root, store, document, source, close: () => rm(root, { recursive: true, force: true }) };
}

test('検索した引用だけを許可し、改訂・削除・別セッション・構造不正を拒否する', async () => {
  const f = await fixture();
  try {
    const session = new ChatKnowledgeSession(f.source);
    const result = JSON.parse(await session.search({ query: '有給休暇' }));
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].title, '休暇規程');
    const citation = { chunkId: result.results[0].chunkId, quote: '有給休暇は年間二十日です。' };
    const answer = { answer: '規程では年間二十日です。', status: 'supported', citations: [citation] };
    assert.match(await session.answer(answer), /引用照合済み/);
    assert.match(await session.answer(answer), /改訂 1/);
    await assert.rejects(new ChatKnowledgeSession(f.source).answer(answer), /取得済み/);
    await assert.rejects(session.answer({ ...answer, citations: [{ ...citation, quote: '年間百日' }] }), /一致/);
    await assert.rejects(session.answer({ ...answer, citations: [] }), /引用が必要/);
    await assert.rejects(session.answer({ ...answer, status: 'unknown' }), /構造/);
    await assert.rejects(session.search({ query: '有給休暇', projectId: 'other' }), /検索語/);
    await f.store.update('alpha', f.document.documentId, { content: '有給休暇は年間二十一日です。' });
    await assert.rejects(session.answer(answer), /更新/);
    await session.search({ query: '有給休暇' });
    await f.store.remove('alpha', f.document.documentId);
    await assert.rejects(session.answer(answer));
    assert.match(await session.answer({ answer: '資料が不足しています。', status: 'unconfirmed', citations: [] }), /未確認/);
  } finally { await f.close(); }
});

test('AIが依頼の意味から検索語を選び、引用付き回答まで実行する', async () => {
  const f = await fixture();
  const events: ChatEvent[] = [];
  let step = 0;
  try {
    const answer = await runChatAgent({ mode: 'plan', model: 'mock', messages: [{ role: 'user', content: '社員が一年に休める日数を教えて' }], allowedWritePaths: [], knowledge: f.source }, f.root, async body => {
      assert.ok((body.tools as any[]).some(t => t.function.name === 'search_project_knowledge'));
      if (step++ === 0) return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'search', type: 'function', function: { name: 'search_project_knowledge', arguments: '{"query":"有給休暇"}' } }] } }], usage: { total_tokens: 100 } };
      const hit = JSON.parse((body.messages as any[]).at(-1).content).results[0];
      return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'answer', type: 'function', function: { name: 'answer_project_knowledge', arguments: JSON.stringify({ answer: '年間二十日です。', status: 'supported', citations: [{ chunkId: hit.chunkId, quote: '有給休暇は年間二十日です。' }] }) } }] } }], usage: { total_tokens: 100 } };
    }, e => events.push(e), new AbortController().signal);
    assert.match(answer, /example.invalid\/policy/);
    assert.doesNotMatch(answer, /別部署限定/);
    assert.equal(events.at(-1)?.type, 'final');
    assert.equal(events.filter(e => e.type === 'tool_result' && e.success).length, 2);
  } finally { await f.close(); }
});

test('自由本文を検証済み回答として返さず、構造化した未確認回答を要求する', async () => {
  let step = 0;
  const answer = await runChatAgent({ mode: 'plan', model: 'mock', messages: [{ role: 'user', content: '相談' }], allowedWritePaths: [], knowledge: { search: async () => [], document: async () => { throw Error('読取り禁止'); } } }, os.tmpdir(), async body => {
    if (step++ === 0) return { choices: [{ message: { content: '根拠なしの断定' } }], usage: { total_tokens: 100 } };
    assert.match((body.messages as any[]).at(-1).content, /answer_project_knowledge/);
    return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'answer', type: 'function', function: { name: 'answer_project_knowledge', arguments: JSON.stringify({ answer: '根拠を確認できません。', status: 'unconfirmed', citations: [] }) } }] } }], usage: { total_tokens: 100 } };
  }, () => {}, new AbortController().signal);
  assert.match(answer, /未確認/);
});

test('Actで検索した資料から許可済み成果物を書き、回答時の権限取り消しも反映する', async () => {
  const f = await fixture(); let step = 0; let hit: any;
  try {
    await runChatAgent({ mode: 'act', model: 'mock', messages: [{ role: 'user', content: '休暇規程をreport.mdにまとめて' }], allowedWritePaths: ['report.md'], knowledge: f.source }, f.root, async body => {
      let name: string, args: unknown;
      if (step === 0) { name = 'search_project_knowledge'; args = { query: '有給休暇' }; }
      else if (step === 1) { hit = JSON.parse((body.messages as any[]).at(-1).content).results[0]; name = 'write_file'; args = { path: 'report.md', content: '有給休暇は年間二十日です。\n出典: ' + hit.url }; }
      else { name = 'answer_project_knowledge'; args = { answer: 'report.mdへ保存しました。', status: 'supported', citations: [{ chunkId: hit.chunkId, quote: '有給休暇は年間二十日です。' }] }; }
      return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: String(step++), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 100 } };
    }, () => {}, new AbortController().signal);
    assert.match(await readFile(path.join(f.root, 'report.md'), 'utf8'), /example.invalid\/policy/);
    let allowed = true;
    const session = new ChatKnowledgeSession({ search: f.source.search, document: id => { if (!allowed) throw Error('権限が取り消されました。'); return f.source.document(id); } });
    const results = JSON.parse(await session.search({ query: '有給休暇' })).results;
    allowed = false;
    await assert.rejects(session.answer({ answer: '回答', status: 'supported', citations: [{ chunkId: results[0].chunkId, quote: '有給休暇' }] }), /権限/);
  } finally { await f.close(); }
});

test('APIはモデル実行前にプロジェクト権限を確認し、未設定や不正IDを拒否する', async () => {
  const app = Fastify(); let executions = 0; let permission = true;
  registerChatAgent(app, { workspace: os.tmpdir(), authorize: () => true, knowledgeAccess: async (_req, _reply, id) => permission && id === 'alpha' ? { search: async () => [], document: async () => { throw Error('利用不可'); } } : undefined });
  app.post('/v1/chat/completions', async () => { executions++; return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'answer', type: 'function', function: { name: 'answer_project_knowledge', arguments: '{"answer":"資料なし","status":"unconfirmed","citations":[]}' } }] } }], usage: { total_tokens: 100 } }; });
  const payload = { mode: 'plan', model: 'mock', messages: [{ role: 'user', content: '相談' }], allowedWritePaths: [], knowledgeProjectId: 'alpha', knowledge: { search: '偽造接続' } };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/chat/agent', payload: { ...payload, knowledgeProjectId: '../other' } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/chat/agent', payload: { ...payload, knowledgeProjectId: 'other' } })).statusCode, 403);
    assert.equal(executions, 0);
    const response = await app.inject({ method: 'POST', url: '/api/chat/agent', payload });
    assert.equal(response.statusCode, 200); assert.match(response.body, /未確認/);
    permission = false;
    assert.equal((await app.inject({ method: 'POST', url: '/api/chat/agent', payload })).statusCode, 403);
    assert.equal(executions, 1);
  } finally { await app.close(); }
});
