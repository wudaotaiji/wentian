import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KnowledgeError, ProjectKnowledgeStore, buildChunks, contentHash, tokenize,
  validateProjectId, validateSourceUrl,
} from './project-knowledge.js';

test('別インスタンスからの並行登録でも全資料が保存される', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-knowledge-shared-'));
  const stores = [new ProjectKnowledgeStore({ root }), new ProjectKnowledgeStore({ root })];
  await Promise.all(Array.from({ length: 12 }, (_, index) => stores[index % 2]!.register('team-a', { title: `資料${index}`, url: 'https://example.com/doc', content: `共有資料内容${index}` })));
  assert.equal((await stores[0]!.list('team-a')).length, 12);
});

/** 試験ごとに mkdtemp（一時目録）専用rootを作り、実データ・他試験から完全に隔離する。 */
async function isolatedStore(): Promise<ProjectKnowledgeStore> {
  return new ProjectKnowledgeStore({ root: await mkdtemp(path.join(tmpdir(), `wentian-knowledge-${process.pid}-`)) });
}

const doc = {
  title: '権限設計の運用メモ',
  url: 'https://wiki.example.jp/pages/permissions',
  content: '1行目: ゲートウェイの資料APIはプロジェクト単位で隔離します。\n2行目: 更新後は古いチャンクを無効化し、revisionを上げます。\n3行目: 検索は字句検索で、根拠として行番号と抜粋を返します。',
};

test('日本語はバイグラム字句検索で当たり、根拠（行番号・抜粋・revision・hash）を返す', async () => {
  const store = await isolatedStore();
  const created = await store.register('team-a', doc);
  assert.equal(created.revision, 1);
  assert.equal(created.contentHash, contentHash(doc.content));
  const hits = await store.search('team-a', 'チャンクを無効化');
  assert.ok(hits.length >= 1, '日本語クエリがヒットしない');
  const hit = hits[0]!;
  assert.equal(hit.documentId, created.documentId);
  assert.equal(hit.revision, 1);
  assert.equal(hit.contentHash, created.contentHash);
  assert.equal(hit.url, doc.url);
  assert.match(hit.excerpt, /古いチャンクを無効化/);
  assert.ok(hit.lineStart <= 2 && hit.lineEnd >= 2, `2行目が抜粋範囲に含まれない: ${hit.lineStart}-${hit.lineEnd}`);
  // 英数字トークンも効く（混在テキスト）
  assert.ok((await store.search('team-a', 'API')).length >= 1);
});

test('プロジェクト隔離: 他プロジェクトの一覧・検索・取得に資料が混ざらない', async () => {
  const store = await isolatedStore();
  const created = await store.register('team-a', doc);
  assert.deepEqual(await store.list('team-b'), []);
  assert.deepEqual(await store.search('team-b', 'チャンク'), []);
  await assert.rejects(store.get('team-b', created.documentId), (error: unknown) => (error as KnowledgeError).code === 'not_found');
  // 物理的にも team-b の台帳が作られていない（触達しない設計の確認）
  const files = await readdir(path.join(store.root, 'projects'));
  assert.deepEqual(files, ['team-a.json']);
});

test('悪意あるprojectIdは全入口で拒否し、root外へファイルを作らない', async () => {
  const store = await isolatedStore();
  const malicious = ['..', '../evil', '..\\..\\evil', 'a/b', 'a\\b', 'C:\\abs', 'x'.repeat(65), '', 'Team-A', '日本', 'a b', '.hidden', 'x.'];
  for (const id of malicious) {
    await assert.rejects(store.register(id, doc), (error: unknown) => (error as KnowledgeError).code === 'invalid_project_id', `通ってはいけないprojectId: ${id}`);
    await assert.rejects(store.list(id), (error: unknown) => (error as KnowledgeError).code === 'invalid_project_id');
    await assert.rejects(store.search(id, 'テスト'), (error: unknown) => (error as KnowledgeError).code === 'invalid_project_id');
  }
  assert.equal(validateProjectId('team_a-2'), 'team_a-2');
  // root直下とprojects配下にゴミが出ていない
  await assert.rejects(readFile(path.join(store.root, 'projects', '..json'), 'utf8'), { code: 'ENOENT' });
});

test('URLはhttp/httpsだけ。javascript:・data:・認証情報埋め込み・パズリを拒否（XSS/秘密漏えい防止）', async () => {
  const store = await isolatedStore();
  const bad = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://example.jp/x', '/relative/path', 'javascript\t:alert(1)', 'https://user:secret@wiki.example.jp/p'];
  for (const url of bad) await assert.rejects(store.register('team-a', { ...doc, url }), (error: unknown) => (error as KnowledgeError).code === 'invalid_url', `通ってはいけないURL: ${url}`);
  const ok = await store.register('team-a', { ...doc, url: 'http://wiki.example.local/pages/1?utm=ok' });
  assert.ok(ok.url.startsWith('http://wiki.example.local/'));
  // クエリにscript片があっても WHATWG URL 正規化で `<` `>` が %3C %3E へエンコードされ、生のHTML運び屋にならない
  const encoded = await store.register('team-a', { ...doc, url: 'https://example.jp/p?a=<script>alert(1)</script>' });
  assert.ok(!encoded.url.includes('<'), `URL正規化でrawな<が出ない: ${encoded.url}`);
  void validateSourceUrl; // 直接検証関数もエクスポート済み（ルート側の共通利用想定）
});

test('更新後は旧チャンクが無効化され、旧内容の検索は当たらない。改訂・失効記録が残る', async () => {
  const store = await isolatedStore();
  const created = await store.register('team-a', doc);
  const updated = await store.update('team-a', created.documentId, {
    content: '1行目: 新しい運用ではベクトル索引ではなく全文索引を試験します。\n2行目: ゲートウェイの資料APIはプロジェクト単位で隔離します。',
    expectedRevision: 1,
  });
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.contentHash, created.contentHash);
  // 旧内容独特語はヒットしない（古チャンク無効化の実効性）
  assert.deepEqual(await store.search('team-a', 'チャンクを無効化'), []);
  // 新内容独特語はヒットし、revision=2と新hashが付く
  const hits = await store.search('team-a', '全文索引');
  assert.equal(hits[0]!.revision, 2);
  assert.equal(hits[0]!.contentHash, updated.contentHash);
  // 失効記録: 旧改訂のハッシュだけ保持し、旧本文は台帳から消えている
  assert.equal(updated.superseded.length, 1);
  assert.equal(updated.superseded[0]!.revision, 1);
  assert.equal(updated.superseded[0]!.contentHash, created.contentHash);
  const raw = await readFile(path.join(store.root, 'projects', 'team-a.json'), 'utf8');
  assert.ok(!raw.includes('古いチャンクを無効化'), '失効した旧本文が台帳に残っている');
});

test('楽観的ロック（expectedRevision）競合と、並行登録で台帳が壊れない', async () => {
  const store = await isolatedStore();
  const created = await store.register('team-a', doc);
  // 古い改訂を前提にした更新は 409相当（revision_conflict）
  await store.update('team-a', created.documentId, { content: doc.content + '\n追記', expectedRevision: 1 });
  await assert.rejects(
    store.update('team-a', created.documentId, { content: '二重更新企图', expectedRevision: 1 }),
    (error: unknown) => (error as KnowledgeError).code === 'revision_conflict',
  );
  // 進程内Mutex: 10件の並行登録が全件残り、JSONとして読める
  await Promise.all(Array.from({ length: 10 }, (_unused, index) => store.register('team-a', { ...doc, title: `並行${index}` })));
  const list = await store.list('team-a');
  assert.equal(list.length, 11); // 初回1件＋並行10件（更新は件数を増やさない）
  const parsed = JSON.parse(await readFile(path.join(store.root, 'projects', 'team-a.json'), 'utf8'));
  assert.equal(parsed.documents.length, 11);
  // tmp残骸が後片付けされている（rename成功で本ファイルだけ）
  const files = await readdir(path.join(store.root, 'projects'));
  assert.deepEqual(files.filter(name => name.endsWith('.tmp')), []);
});

test('検索文字列・本文サイズ・空資料などの入力制限', async () => {
  const store = await isolatedStore();
  await store.register('team-a', doc);
  await assert.rejects(store.search('team-a', 'あ'.repeat(301)), (error: unknown) => (error as KnowledgeError).code === 'query_too_long');
  await assert.rejects(store.search('team-a', '   '), (error: unknown) => (error as KnowledgeError).code === 'invalid_query');
  await assert.rejects(store.register('team-a', { ...doc, content: 'あ'.repeat(100_001) }), (error: unknown) => (error as KnowledgeError).code === 'content_too_large');
  await assert.rejects(store.register('team-a', { ...doc, content: '   ' }), (error: unknown) => (error as KnowledgeError).code === 'invalid_content');
  await assert.rejects(store.register('team-a', { ...doc, title: '' }), (error: unknown) => (error as KnowledgeError).code === 'invalid_title');
});

test('チャンク分割は行番号を維持し、削除後は一覧・検索から消える', async () => {
  const chunks = buildChunks('doc1', 1, 'あ'.repeat(500) + '\n' + 'い'.repeat(500) + '\n' + 'う'.repeat(500));
  assert.ok(chunks.length >= 3, '長文は複数チャンクに割る');
  assert.equal(chunks[0]!.lineStart, 1);
  assert.ok(chunks.every((chunk, index) => index === 0 || chunk.lineStart > chunks[index - 1]!.lineEnd), '行番号が単調で重ならない');
  const store = await isolatedStore();
  const created = await store.register('team-a', doc);
  await store.remove('team-a', created.documentId);
  assert.deepEqual(await store.list('team-a'), []);
  assert.deepEqual(await store.search('team-a', 'チャンク'), []);
  await assert.rejects(store.remove('team-a', created.documentId), (error: unknown) => (error as KnowledgeError).code === 'not_found');
});

test('トークン化: 英単語2文字以上・CJK連続のバイグラム・1字範囲は単字', () => {
  assert.ok(tokenize('Wentian APIgateway').includes('wentian'));
  assert.ok(tokenize('値').includes('値'));              // 1字範囲は単字
  assert.ok(tokenize('x1').includes('x1'));             // 英数2字以上はトークン
  const tokens = tokenize('権限設計');
  assert.ok(tokens.includes('権限') && tokens.includes('限設') && tokens.includes('設計'));
});
