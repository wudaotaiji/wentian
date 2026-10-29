import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectKnowledgeStore, buildChunks } from './project-knowledge.js';
import { configuredKnowledgeEmbedder, normalizedVector, type KnowledgeEmbedder } from './knowledge-embeddings.js';
import { collectProjectUrls, extractKnowledgePage } from './knowledge-url-collector.js';
import { registerProjectKnowledgeRoutes } from './project-knowledge-routes.js';
import { readPublicWeb } from './chat-agent.js';

/** 模擬ベクトルの対応は試験用。製品の意味判定にはモデルの実際の埋め込みを使います。 */
const embeddings = () => {
  const calls: string[][] = [];
  const embedder: KnowledgeEmbedder = { id: 'fixture-model', embed: async texts => {
    calls.push(texts);
    return texts.map(text => text === '休める日数' || text.startsWith('休暇規程') ? [1, 0] : [0, 1]);
  } };
  return { embedder, calls };
};
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-vector-collection-')); return { root, close: () => rm(root, { recursive: true, force: true }) }; }

test('字句が一致しない質問をベクトルで検索し、索引を永続化・再利用する', async () => {
  const f = await temporary(); const mock = embeddings();
  try {
    const store = new ProjectKnowledgeStore({ root: f.root, embedder: mock.embedder });
    await store.register('alpha', { title: '休暇規程', url: 'https://example.invalid/leave', content: '有給の付与は年間二十日。' });
    await store.register('alpha', { title: '設備', url: 'https://example.invalid/office', content: '機材の管理方法。' });
    assert.equal((await store.search('alpha', '休める日数', 8, 'lexical')).length, 0);
    const hits = await store.search('alpha', '休める日数', 1, 'vector');
    assert.equal(hits[0].title, '休暇規程'); assert.equal(hits[0].score, 1);
    assert.ok(hits[0].contentHash); assert.equal(hits[0].lineStart, 1);
    assert.equal(mock.calls.length, 2);
    const reopened = new ProjectKnowledgeStore({ root: f.root, embedder: mock.embedder });
    assert.equal((await reopened.search('alpha', '休める日数', 1))[0].title, '休暇規程');
    assert.equal(mock.calls.length, 3, '資料の埋め込みは再生成しない');
    assert.equal(JSON.parse(await readFile(path.join(f.root, 'projects/alpha.json'), 'utf8')).vectorIndex.provider, mock.embedder.id);
    assert.deepEqual(await reopened.search('other', '休める日数', 8, 'vector'), []);
  } finally { await f.close(); }
});

test('更新・削除・モデル変更で旧索引を使用せず、索引中の編集競合も拒否する', async () => {
  const f = await temporary(); const mock = embeddings();
  try {
    const store = new ProjectKnowledgeStore({ root: f.root, embedder: mock.embedder });
    const doc = await store.register('alpha', { title: '休暇規程', url: 'https://example.invalid/leave', content: '旧本文' });
    await store.search('alpha', '休める日数', 8, 'vector');
    await store.update('alpha', doc.documentId, { content: '新本文' });
    assert.equal((await store.search('alpha', '休める日数', 8, 'vector'))[0].revision, 2);
    const other = new ProjectKnowledgeStore({ root: f.root, embedder: { ...mock.embedder, id: 'new-model' } });
    const previousCalls = mock.calls.length;
    await other.search('alpha', '休める日数', 8, 'vector');
    assert.equal(mock.calls.length, previousCalls + 2);
    let changed = false;
    const racing = new ProjectKnowledgeStore({ root: f.root, embedder: { id: 'racing', embed: async texts => {
      if (!changed) { changed = true; await store.update('alpha', doc.documentId, { content: '取得中の変更' }); }
      return texts.map(() => [1, 0]);
    } } });
    await assert.rejects(racing.search('alpha', '質問', 8, 'vector'), /更新/);
    await store.remove('alpha', doc.documentId);
    assert.deepEqual(await store.search('alpha', '質問', 8, 'vector'), []);
  } finally { await f.close(); }
});

test('未設定・異常ベクトル・上流失敗を検索成功にせず、長い行は有限サイズへ分割する', async () => {
  const f = await temporary();
  try {
    const store = new ProjectKnowledgeStore({ root: f.root });
    await assert.rejects(store.search('alpha', '質問', 8, 'vector'), /設定/);
    await assert.rejects(store.search('alpha', '質問', 8, 'bad' as any), /方式/);
    for (const vector of [[], [0, 0], [NaN], [Infinity], ['1']]) assert.throws(() => normalizedVector(vector));
    assert.throws(() => normalizedVector([1, 0], 3));
    const chunks = buildChunks('doc', 1, '長'.repeat(2000));
    assert.equal(chunks.length, 4); assert.ok(chunks.every(c => c.text.length <= 600 && c.lineStart === 1));
    const emojiChunks = buildChunks('emoji', 1, 'a' + '😀'.repeat(700));
    assert.ok(emojiChunks.every(c => Buffer.from(c.text).toString('utf8') === c.text));
    const broken = new ProjectKnowledgeStore({ root: f.root, embedder: { id: 'broken', embed: async () => { throw Error('上流の秘密情報'); } } });
    await store.register('alpha', { title: '資料', url: 'https://example.invalid', content: '本文' });
    await assert.rejects(broken.search('alpha', '質問', 8, 'vector'), error => error instanceof Error && !error.message.includes('秘密情報'));
  } finally { await f.close(); }
});

test('設定した埋め込みAPIの応答順序・次元・通信設定を検査し、秘密を索引IDへ含めない', async () => {
  const env = { WENTIAN_KNOWLEDGE_EMBEDDING_BASE_URL: 'https://embedding.invalid/v1', WENTIAN_KNOWLEDGE_EMBEDDING_MODEL: 'chosen', WENTIAN_KNOWLEDGE_EMBEDDING_API_KEY: 'fixture-secret' };
  assert.equal(configuredKnowledgeEmbedder({}), undefined);
  assert.throws(() => configuredKnowledgeEmbedder({ WENTIAN_KNOWLEDGE_EMBEDDING_MODEL: 'chosen' }), /両方/);
  const provider = configuredKnowledgeEmbedder(env, (async (url, init) => {
    assert.equal(String(url), 'https://embedding.invalid/v1/embeddings');
    assert.equal(init?.redirect, 'error');
    assert.equal(JSON.parse(String(init?.body)).model, 'chosen');
    return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 0] }] }));
  }) as typeof fetch)!;
  assert.deepEqual(await provider.embed(['a', 'b']), [[1, 0], [0, 1]]);
  assert.ok(!provider.id.includes('fixture-secret'));
  const duplicate = configuredKnowledgeEmbedder(env, (async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [1] }] }))) as typeof fetch)!;
  await assert.rejects(duplicate.embed(['a', 'b']), /順序/);
});

test('HTMLから本文と同一サイトリンクを取り込み、同じURLの再収集を改訂として保存する', async () => {
  const f = await temporary(); const store = new ProjectKnowledgeStore({ root: f.root }); const visited: string[] = []; let version = '最初の本文';
  try {
    const read = async (url: string) => { visited.push(url); return { url, contentType: 'text/html', body: `<title>資料 &amp; 案内</title><script>秘密スクリプト</script><p>${version}</p><a href="/next">続き</a><a href="https://other.invalid/">外部</a>` }; };
    const first = await collectProjectUrls(store, 'alpha', { url: 'https://example.invalid/start#section', followLinks: true, maxPages: 2 }, async () => true, read);
    assert.equal(first.documents.length, 2); assert.equal(first.complete, true); assert.equal(visited.length, 2);
    const doc = await store.get('alpha', first.documents[0].documentId);
    assert.equal(doc.title, '資料 & 案内'); assert.doesNotMatch(doc.content, /秘密スクリプト/);
    version = '改訂した本文';
    const next = await collectProjectUrls(store, 'alpha', { url: 'https://example.invalid/start' }, async () => true, read);
    assert.equal(next.documents[0].documentId, doc.documentId); assert.equal(next.documents[0].revision, 2);
    assert.equal((await store.list('alpha')).length, 2);
    assert.equal((await store.list('other')).length, 0);
  } finally { await f.close(); }
});

test('URL収集は失敗・非対応形式・権限取り消し・取得中の編集を隠さず、内部URLへ接続しない', async () => {
  const f = await temporary(); const store = new ProjectKnowledgeStore({ root: f.root });
  try {
    await assert.rejects(readPublicWeb('http://127.0.0.1/private', new AbortController().signal), /内部/);
    assert.throws(() => extractKnowledgePage({ url: 'https://example.invalid', body: '%PDF', contentType: 'application/pdf' }), /対応/);
    let calls = 0;
    await assert.rejects(collectProjectUrls(store, 'alpha', { url: 'https://example.invalid' }, async () => false, async () => { calls++; throw Error('実行禁止'); }), /権限/);
    assert.equal(calls, 0);
    const failed = await collectProjectUrls(store, 'alpha', { url: 'https://example.invalid' }, async () => true, async () => { throw Error('秘密の接続設定'); });
    assert.equal(failed.complete, false); assert.equal(failed.errors.length, 1); assert.doesNotMatch(JSON.stringify(failed), /秘密/);
    let allowed = true;
    await assert.rejects(collectProjectUrls(store, 'alpha', { url: 'https://example.invalid' }, async () => allowed, async url => { allowed = false; return { url, body: '<p>本文</p>' }; }), /権限/);
    assert.equal((await store.list('alpha')).length, 0);
    const doc = await store.register('alpha', { title: '原本', url: 'https://example.invalid/', content: '原本文' });
    const result = await collectProjectUrls(store, 'alpha', { url: doc.url }, async () => true, async url => { await store.update('alpha', doc.documentId, { content: '利用者による変更' }); return { url, body: '<p>古い取得本文</p>' }; });
    assert.equal(result.complete, false); assert.match(result.errors[0].message, /更新/);
    assert.equal((await store.get('alpha', doc.documentId)).content, '利用者による変更');
  } finally { await f.close(); }
});

test('実APIで認可後にURL収集し、ベクトル検索・引用元取得まで到達する', async () => {
  const f = await temporary(); const app = Fastify(); let readCalls = 0;
  try {
    registerProjectKnowledgeRoutes(app, (req, _reply, project, write) => req.headers['x-user'] === 'owner' && project === 'alpha' || !write && req.headers['x-user'] === 'reader' && project === 'alpha', {
      root: f.root, embedder: embeddings().embedder,
      readPage: async url => { readCalls++; return { url, contentType: 'text/html', body: '<title>休暇規程</title><p>有給の付与は年間二十日。</p>' }; },
    });
    const payload = { url: 'https://example.invalid/leave' };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/project-knowledge/alpha/collect', payload })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/project-knowledge/alpha/collect', headers: { 'x-user': 'reader' }, payload })).statusCode, 403);
    assert.equal(readCalls, 0);
    const created = await app.inject({ method: 'POST', url: '/v1/project-knowledge/alpha/collect', headers: { 'x-user': 'owner' }, payload });
    assert.equal(created.statusCode, 200); assert.equal(created.json().complete, true);
    const search = await app.inject({ url: '/v1/project-knowledge/alpha/search?mode=vector&q=' + encodeURIComponent('休める日数'), headers: { 'x-user': 'reader' } });
    assert.equal(search.statusCode, 200); assert.equal(search.json()[0].title, '休暇規程');
    const source = await app.inject({ url: '/v1/project-knowledge/alpha/documents/' + search.json()[0].documentId, headers: { 'x-user': 'reader' } });
    assert.equal(source.statusCode, 200); assert.match(source.json().content, /年間二十日/);
    assert.equal((await app.inject({ url: '/v1/project-knowledge/other/search?mode=vector&q=test', headers: { 'x-user': 'owner' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/project-knowledge/alpha/collect', headers: { 'x-user': 'owner', origin: 'https://attacker.invalid' }, payload })).statusCode, 403);
  } finally { await app.close(); await f.close(); }
});
