// team-access-routes.ts の HTTP 境界テスト。
// 実際の Fastify インスタンスへ registerTeamAccessRoutes を登録し、app.inject で認証・権限の境界を検証します。
// identity はテストではヘッダー x-test-user で模倣しますが、これは「ホスト認証が確定させた本人」の再現です。
// ルート側が本文の identity 指定を無視すること（任意 identity 選択の防止）もここで確認します。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { registerTeamAccessRoutes } from './team-access-routes.js';

/** テスト用ホストを構築します。boss だけが管理者、他は一般ユーザーです。 */
async function buildHost(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `wentian-team-routes-${name}-`));
  const admins = new Set(['boss']);
  const knownUsers = new Set(['boss', 'alice', 'bob', 'carl']);
  const app = Fastify({ logger: false });
  const { service } = registerTeamAccessRoutes(app, {
    root,
    identity: req => { const id = req.headers['x-test-user']; return typeof id === 'string' && knownUsers.has(id) ? { id } : undefined; },
    authorizeAdmin: (req, reply) => {
      const id = req.headers['x-test-user'];
      if (typeof id !== 'string' || !knownUsers.has(id)) { reply.code(401).send({ error: { message: 'ログインが必要です。' } }); return false; }
      if (!admins.has(id)) { reply.code(403).send({ error: { message: '管理者権限が必要です。' } }); return false; }
      return true;
    },
  });
  // ホストのブートストラップ: 初期プラットフォーム管理者を Service 直呼びで作ります（HTTP からは作れない設計）。
  await service.createUser({ id: 'boss', displayName: 'Boss', platformAdmin: true }, { kind: 'system' });
  await app.ready();
  return { app, root, knownUsers };
}
// inject で JSON として届けるため content-type をヘッダーに常時付けます（Fastify のパース検証を通すため）。
const as = (user: string) => ({ 'x-test-user': user, 'content-type': 'application/json' });
const withKey = (secret: string) => ({ 'x-team-virtual-key': secret, 'content-type': 'application/json' });
const json = (payload: unknown) => ({ payload: payload as Record<string, unknown> });

test('未登录・非管理者・未知identityの要求をHTTP層で拒否する', async () => {
  const { app, knownUsers } = await buildHost('authz');
  knownUsers.add('peon');
  // identity 無しでメンバールート → 401
  assert.equal((await app.inject({ method: 'GET', url: '/api/team-access/projects' })).statusCode, 401);
  // 未知の identity ヘッダー（ホストが本人確認できない）→ 401
  assert.equal((await app.inject({ method: 'GET', url: '/api/team-access/projects', headers: as('ghost') })).statusCode, 401);
  // 非管理者の管理操作 → 403。本文で identity や platformAdmin を偽装しても無視されます。
  const spoof = await app.inject({ method: 'POST', url: '/api/team-access/users', headers: as('peon'), ...json({ displayName: 'X', platformAdmin: true, identity: 'boss', userId: 'boss' }) });
  assert.equal(spoof.statusCode, 403);
  // 偽装作成されたはずのユーザーは存在しません。
  const overview = await app.inject({ method: 'GET', url: '/api/team-access/overview', headers: as('boss') });
  assert.ok(!overview.json().users.some((u: { id: string; displayName?: string }) => u.displayName === 'X'));
});

test('発行响应だけ原文キーを含み、一覧・応答・状態ファイルから原文は消える', async () => {
  const { app, root, knownUsers } = await buildHost('keys');
  await app.inject({ method: 'POST', url: '/api/team-access/users', headers: as('boss'), ...json({ id: 'alice', displayName: 'Alice' }) });
  await app.inject({ method: 'POST', url: '/api/team-access/projects', headers: as('boss'), ...json({ id: 'p-a', name: 'A', ownerId: 'boss' }) });
  await app.inject({ method: 'POST', url: '/api/team-access/projects/p-a/members', headers: as('boss'), ...json({ userId: 'alice', role: 'owner' }) });
  // owner（Alice）が発行 → 201で原文が1回だけ返ります
  const issued = await app.inject({ method: 'POST', url: '/api/team-access/projects/p-a/keys', headers: as('alice'), ...json({ label: 'ci' }) });
  assert.equal(issued.statusCode, 201);
  const plaintext = issued.json().key as string;
  assert.match(plaintext, /^wtvk_/);
  // 一般メンバー（非owner）の発行は 403
  await app.inject({ method: 'POST', url: '/api/team-access/users', headers: as('boss'), ...json({ id: 'carl', displayName: 'Carl' }) });
  await app.inject({ method: 'POST', url: '/api/team-access/projects/p-a/members', headers: as('boss'), ...json({ userId: 'carl', role: 'member' }) });
  assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/projects/p-a/keys', headers: as('carl'), ...json({ label: 'x' }) })).statusCode, 403);
  // 以後の参照（usage・overview・状態ファイル）に原文は現れません。prefix だけが見えます。
  const usage = await app.inject({ method: 'GET', url: '/api/team-access/projects/p-a/usage', headers: as('alice') });
  assert.equal(usage.statusCode, 200);
  assert.ok(!usage.body.includes(plaintext));
  assert.ok(usage.json().keys[0].prefix.startsWith('wtvk_'));
  const overview = await app.inject({ method: 'GET', url: '/api/team-access/overview', headers: as('boss') });
  assert.ok(!overview.body.includes(plaintext));
  assert.ok(!(await readFile(path.join(root, 'team-access.json'), 'utf8')).includes(plaintext));
});

test('仮想キー利用のHTTP境界: キー無し401・許可外モデル403・予算超過429・失効401', async () => {
  const { app } = await buildHost('usage');
  await app.inject({ method: 'POST', url: '/api/team-access/users', headers: as('boss'), ...json({ id: 'alice', displayName: 'Alice' }) });
  await app.inject({ method: 'POST', url: '/api/team-access/projects', headers: as('boss'), ...json({ id: 'p-a', name: 'A', ownerId: 'alice' }) });
  await app.inject({ method: 'PATCH', url: '/api/team-access/projects/p-a', headers: as('alice'), ...json({ allowedModels: ['exact-model'], pricing: { 'exact-model': { inputUsdPerMTok: 1, outputUsdPerMTok: 0 } }, budgetUsd: 2 }) });
  const issued = await app.inject({ method: 'POST', url: '/api/team-access/projects/p-a/keys', headers: as('alice'), ...json({ label: 'ci' }) });
  const key = { 'x-team-virtual-key': issued.json().key as string };
  // キーヘッダー無し → 401
  assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', ...json({ model: 'exact-model' }) })).statusCode, 401);
  // 許可外モデル（完全一致しない）→ 403。本文の projectId 指定も無視されます。
  assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: key, ...json({ model: 'exact-model2', projectId: 'other' }) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: key, ...json({ model: 'Exact-model' }) })).statusCode, 403);
  // 予算2 USD: 0.5 + 1.0 は通るが、さらに 1.0 は 429 budget_exceeded
  const r1 = await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: key, ...json({ model: 'exact-model', estInputTokens: 500_000 }) });
  assert.equal(r1.statusCode, 200);
  await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: key, ...json({ model: 'exact-model', estInputTokens: 1_000_000 }) });
  const over = await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: key, ...json({ model: 'exact-model', estInputTokens: 1_000_000 }) });
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error.code, 'budget_exceeded');
  // 確定 → 費用が積みます（0.5の予約を実入力で確定）。
  const commit = await app.inject({ method: 'POST', url: '/api/team-access/usage/commit', headers: key, ...json({ reservationId: r1.json().reservationId, inputTokens: 500_000 }) });
  assert.equal(commit.statusCode, 200);
  assert.equal(commit.json().committedUsd, 0.5);
  // 失効後は同じキーでも 401
  const revoke = await app.inject({ method: 'POST', url: `/api/team-access/projects/p-a/keys/${issued.json().keyId}/revoke`, headers: as('alice'), payload: {} });
  assert.equal(revoke.statusCode, 200, revoke.body);
  assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: key, ...json({ model: 'exact-model' }) })).statusCode, 401);
});

test('HTTP経由でも他プロジェクトのキー・予約・履歴は取得/操作できない', async () => {
  const { app, knownUsers } = await buildHost('cross');
  for (const u of ['alice', 'bob']) await app.inject({ method: 'POST', url: '/api/team-access/users', headers: as('boss'), ...json({ id: u, displayName: u }) });
  for (const p of [['p-a', 'alice'], ['p-b', 'bob']] as const) await app.inject({ method: 'POST', url: '/api/team-access/projects', headers: as('boss'), ...json({ id: p[0], name: p[0], ownerId: p[1] }) });
  await app.inject({ method: 'PATCH', url: '/api/team-access/projects/p-b', headers: as('bob'), ...json({ allowedModels: ['m'], pricing: { m: { inputUsdPerMTok: 1, outputUsdPerMTok: 0 } } }) });
  const keyA = { 'x-team-virtual-key': (await app.inject({ method: 'POST', url: '/api/team-access/projects/p-a/keys', headers: as('alice'), ...json({ label: 'ak' }) })).json().key as string };
  const keyB = { 'x-team-virtual-key': (await app.inject({ method: 'POST', url: '/api/team-access/projects/p-b/keys', headers: as('bob'), ...json({ label: 'bk' }) })).json().key as string };
  // Alice（p-b非所属）は p-b の利用履歴を取得できません。
  assert.equal((await app.inject({ method: 'GET', url: '/api/team-access/projects/p-b/usage', headers: as('alice') })).statusCode, 403);
  // Alice の一覧にも p-b は現れません。
  const list = await app.inject({ method: 'GET', url: '/api/team-access/projects', headers: as('alice') });
  assert.deepEqual(list.json().projects.map((p: { id: string }) => p.id), ['p-a']);
  // p-b の予約を p-a のキーで確定・取消はできません（予約ID総当りでも守られます）。
  const reservationB = await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: keyB, ...json({ model: 'm', estInputTokens: 100 }) });
  assert.equal(reservationB.statusCode, 200);
  const rid = reservationB.json().reservationId as string;
  const crossCommit = await app.inject({ method: 'POST', url: '/api/team-access/usage/commit', headers: keyA, ...json({ reservationId: rid }) });
  assert.equal(crossCommit.statusCode, 403);
  assert.equal(crossCommit.json().error.code, 'cross_project_denied');
  assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/usage/cancel', headers: keyA, ...json({ reservationId: rid }) })).statusCode, 403);
  // 自分（p-b）のキーでの確定は成功します。
  assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/usage/commit', headers: keyB, ...json({ reservationId: rid, inputTokens: 100 }) })).statusCode, 200);
  knownUsers.add('nobody');
});

test('料金不明モデルは予算有効プロジェクトでは409で拒否され、ゼロ計上しない', async () => {
  const { app } = await buildHost('noprice');
  await app.inject({ method: 'POST', url: '/api/team-access/users', headers: as('boss'), ...json({ id: 'alice', displayName: 'Alice' }) });
  await app.inject({ method: 'POST', url: '/api/team-access/projects', headers: as('boss'), ...json({ id: 'p-a', name: 'A', ownerId: 'alice' }) });
  await app.inject({ method: 'PATCH', url: '/api/team-access/projects/p-a', headers: as('alice'), ...json({ allowedModels: ['opaque'], budgetUsd: 5 }) });
  const key = { 'x-team-virtual-key': (await app.inject({ method: 'POST', url: '/api/team-access/projects/p-a/keys', headers: as('alice'), ...json({ label: 'k' }) })).json().key as string };
  const denied = await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: key, ...json({ model: 'opaque', estInputTokens: 1000 }) });
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error.code, 'model_price_required');
  // 明示価格を設定then同じ予約が通ります（拒否または明示価格設定）。
  await app.inject({ method: 'PATCH', url: '/api/team-access/projects/p-a', headers: as('alice'), ...json({ pricing: { opaque: { inputUsdPerMTok: 1, outputUsdPerMTok: 0 } } }) });
  assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/usage/reserve', headers: key, ...json({ model: 'opaque', estInputTokens: 1000 }) })).statusCode, 200);
});
