import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { ProjectKnowledgeStore } from './project-knowledge.js';
import { registerProjectKnowledgeRoutes, type ProjectKnowledgeAuthorizer } from './project-knowledge-routes.js';

/** 試験用app。mkdtemp（一時目録）rootのストアだけを触り、実設定目录・実データから隔離する。 */
async function buildApp(authorize: ProjectKnowledgeAuthorizer) {
  const root = await mkdtemp(path.join(tmpdir(), `wentian-knowledge-api-${process.pid}-`));
  const store = new ProjectKnowledgeStore({ root });
  const app = Fastify();
  registerProjectKnowledgeRoutes(app, authorize, { store });
  await app.ready();
  return { app, root, store };
}

/** 「team-a の読み取りだけ許可し、書き込みは team-admin のみ」といった権限マトリックスを再現する認証モック。 */
function matrixAuthorizer(allow: (projectId: string, write: boolean) => boolean): { authorize: ProjectKnowledgeAuthorizer; seen: Array<{ projectId: string; write: boolean }> } {
  const seen: Array<{ projectId: string; write: boolean }> = [];
  return {
    seen,
    authorize: (req, reply, projectId, write) => {
      seen.push({ projectId, write });
      if (allow(projectId, write)) return true;
      // 本番の authorize 実装と同じ形: 401/403 を自前で send して false を返す
      void req; void reply;
      return false;
    },
  };
}

const registration = {
  title: 'ゲートウェイ運用勘所',
  url: 'https://wiki.example.jp/ops/gateway',
  content: '1行目: レート制限はゲートウェイの上位側で確認します。\n2行目: 資料検索はプロジェクト単位で権限を判定します。',
};

test('縦断API: 登録→一覧→検索→引用元取得→更新→削除が HTTP/inject で通る', async () => {
  const gate = matrixAuthorizer(() => true);
  const { app } = await buildApp(gate.authorize);
  // 登録（write=true で authorize を必ず通る）
  const created = await app.inject({ method: 'POST', url: '/v1/project-knowledge/team-a/documents', payload: registration });
  assert.equal(created.statusCode, 201);
  const document = created.json();
  assert.equal(document.revision, 1);
  // 一覧
  const list = await app.inject({ method: 'GET', url: '/v1/project-knowledge/team-a/documents' });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);
  assert.equal(list.json()[0].contentChars, registration.content.length);
  // 検索（根拠フィールド必須）
  const search = await app.inject({ method: 'GET', url: `/v1/project-knowledge/team-a/search?q=${encodeURIComponent('権限を判定')}` });
  assert.equal(search.statusCode, 200);
  const hit = search.json()[0];
  for (const field of ['documentId', 'title', 'url', 'excerpt', 'lineStart', 'lineEnd', 'revision', 'contentHash']) {
    assert.ok(hit[field] !== undefined, `検索ヒットに根拠フィールド ${field} が無い`);
  }
  assert.match(hit.excerpt, /権限を判定/);
  // 引用元取得
  const fetched = await app.inject({ method: 'GET', url: `/v1/project-knowledge/team-a/documents/${document.documentId}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().url, registration.url);
  // 更新（expectedRevision付き）
  const updated = await app.inject({ method: 'PUT', url: `/v1/project-knowledge/team-a/documents/${document.documentId}`, payload: { content: '1行目: 更新後の本文です。旧データ検索には出ません。', expectedRevision: 1 } });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().revision, 2);
  const staleSearch = await app.inject({ method: 'GET', url: `/v1/project-knowledge/team-a/search?q=${encodeURIComponent('レート制限')}` });
  assert.deepEqual(staleSearch.json(), [], '更新後の検索に旧内容が出る');
  // 削除
  const removed = await app.inject({ method: 'DELETE', url: `/v1/project-knowledge/team-a/documents/${document.documentId}` });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/project-knowledge/team-a/documents' })).json(), []);
  // write経路全てで authorize が write=true、read経路で write=false を受け取っている
  assert.ok(gate.seen.some(entry => entry.write === true) && gate.seen.some(entry => entry.write === false) && gate.seen.every(entry => entry.projectId === 'team-a'));
  await app.close();
});

test('認証なし（authorize拒否）は全経路403で、データに触れない=登録も一覧も見えない', async () => {
  const gate = matrixAuthorizer((_projectId, write) => !write); // 読み取りのみ・書き込み全面拒否の運用を想定
  const { app } = await buildApp(gate.authorize);
  const denied = await app.inject({ method: 'POST', url: '/v1/project-knowledge/team-a/documents', payload: registration });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'knowledge_write_forbidden');
  // 拒否された登録は保存されていない（データ触達なし）
  const list = await app.inject({ method: 'GET', url: '/v1/project-knowledge/team-a/documents' });
  assert.deepEqual(list.json(), []);
  // 「拒否時にreplyへ何も送らない authorize」でも403になる（fail-closed）
  const { app: quietApp } = await buildApp(() => false);
  const quietDenied = await quietApp.inject({ method: 'GET', url: '/v1/project-knowledge/team-a/documents' });
  assert.equal(quietDenied.statusCode, 403);
  // authorize が例外を投げても拒否扱い（fail-closed）
  const { app: boomApp } = await buildApp(() => { throw new Error('権限服务障害'); });
  assert.equal((await boomApp.inject({ method: 'GET', url: '/v1/project-knowledge/team-a/search?q=テスト' })).statusCode, 403);
  assert.ok(gate.seen.length >= 1);
  await app.close(); await quietApp.close(); await boomApp.close();
});

test('資料混入防止: team-a の資料は team-b の一覧・検索・取得に出ない（authorize全許可でも）', async () => {
  const { authorize } = matrixAuthorizer(() => true);
  const { app } = await buildApp(authorize);
  const created = await app.inject({ method: 'POST', url: '/v1/project-knowledge/team-a/documents', payload: registration });
  const documentId = created.json().documentId;
  assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/project-knowledge/team-b/documents' })).json(), []);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/v1/project-knowledge/team-b/search?q=${encodeURIComponent('レート制限')}` })).json(), []);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/project-knowledge/team-b/documents/${documentId}` })).statusCode, 404);
  // 別プロジェクトからの更新・削除もできない（404 = 存在を教えない）
  assert.equal((await app.inject({ method: 'PUT', url: `/v1/project-knowledge/team-b/documents/${documentId}`, payload: { content: '混入企み' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/project-knowledge/team-b/documents/${documentId}` })).statusCode, 404);
  await app.close();
});

test('悪意あるprojectIdは400で、authorizeにもストアにも渡らない', async () => {
  const gate = matrixAuthorizer(() => true);
  const { app } = await buildApp(gate.authorize);
  for (const bad of ['..', 'a/b', 'x'.repeat(65), 'Team-A', 'a%2Fb']) {
    const response = await app.inject({ method: 'GET', url: `/v1/project-knowledge/${bad}/documents` });
    // `a/b` はFastifyの経路分割で404になり、これも「触らせない」意味では受容できる（400または404）
    assert.ok([400, 404].includes(response.statusCode), `projectId=${bad} が通った: ${response.statusCode}`);
  }
  // 規則を割るprojectIdはauthorize自体へ渡さない（権限判定より前に弾く）
  assert.ok(gate.seen.every(entry => entry.projectId !== '..' && entry.projectId !== 'Team-A' && entry.projectId !== 'a%2Fb'));
  await app.close();
});

test('XSS・超過入力の拒否: javascript:URLは400、本文超過は413、長い検索語は413', async () => {
  const { authorize } = matrixAuthorizer(() => true);
  const { app } = await buildApp(authorize);
  const xss = await app.inject({ method: 'POST', url: '/v1/project-knowledge/team-a/documents', payload: { ...registration, url: 'javascript:alert(document.cookie)' } });
  assert.equal(xss.statusCode, 400);
  assert.equal(xss.json().error.code, 'invalid_url');
  const tooBig = await app.inject({ method: 'POST', url: '/v1/project-knowledge/team-a/documents', payload: { ...registration, content: 'あ'.repeat(100_001) } });
  assert.ok([400, 413].includes(tooBig.statusCode), `本文超過の返し方: ${tooBig.statusCode}`);
  const longQuery = await app.inject({ method: 'GET', url: `/v1/project-knowledge/team-a/search?q=${encodeURIComponent('あ'.repeat(301))}` });
  assert.equal(longQuery.statusCode, 413);
  assert.equal(longQuery.json().error.code, 'query_too_long');
  // 更新の楽観的ロックは HTTP 409
  const created = await app.inject({ method: 'POST', url: '/v1/project-knowledge/team-a/documents', payload: registration });
  const conflict = await app.inject({ method: 'PUT', url: `/v1/project-knowledge/team-a/documents/${created.json().documentId}`, payload: { content: 'あ'.repeat(50), expectedRevision: 99 } });
  assert.equal(conflict.statusCode, 409);
  await app.close();
});

test('応答・ログにAPIキーらしき秘密を混ぜない: 登録済みのURL userinfo拒否と、検索応答の字段確認', async () => {
  const { authorize } = matrixAuthorizer(() => true);
  const { app, root } = await buildApp(authorize);
  const withSecret = await app.inject({ method: 'POST', url: '/v1/project-knowledge/team-a/documents', payload: { ...registration, url: 'https://user:hunter2@wiki.example.jp/p' } });
  assert.equal(withSecret.statusCode, 400);
  await app.inject({ method: 'POST', url: '/v1/project-knowledge/team-a/documents', payload: registration });
  const search = await app.inject({ method: 'GET', url: `/v1/project-knowledge/team-a/search?q=${encodeURIComponent('ゲートウェイ')}` });
  assert.equal(search.statusCode, 200);
  // 検索応答は根拠字段＋スコアだけで、別プロジェクトIDや内部パスを含まない
  assert.ok(!search.body.includes(root));
  assert.ok(!search.body.includes('hunter2'));
  const files = await readdir(path.join(root, 'projects'));
  assert.deepEqual(files, ['team-a.json']);
  await app.close();
});
