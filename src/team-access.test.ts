// team-access.test.ts — TeamAccessService（クラス API）の境界・予算予約・永続化テスト。
// すべての試験は mkdtemp で作った専用 root だけを触り、実運用の状態ファイルを読み書きしません。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TeamAccessError, TeamAccessService, type Actor } from './team-access.js';

test('最後のオーナーを降格させず、予約時価格を更新後も保持する', async () => {
  const { service, boss } = await setup('frozen-price');
  await service.createProject({ id: 'p-a', name: '検証', ownerId: 'boss' }, boss);
  await expectError(() => service.addProjectMember('p-a', 'boss', 'member', boss), 409, 'last_owner');
  const model = 'example/model';
  await service.updateProject('p-a', { allowedModels: [model], pricing: { [model]: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } } }, boss);
  const key = await service.issueKey('p-a', '検証', boss); const authenticated = await service.authenticateKey(key.key);
  const actor = { kind: 'key' as const, ...authenticated };
  const reservation = await service.reserve(actor, { model, estInputTokens: 10, estOutputTokens: 20 });
  await service.updateProject('p-a', { pricing: { [model]: { inputUsdPerMTok: 100, outputUsdPerMTok: 100 } } }, boss);
  const committed = await service.commitReservation(reservation.reservationId, { inputTokens: 10, outputTokens: 20 }, actor);
  assert.equal(committed.committedUsd, 0.00003);
});

/** 孤立した root と、プラットフォーム管理者1名を備えた Service を作ります。 */
async function setup(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `wentian-team-${name}-`));
  const service = new TeamAccessService({ root });
  await service.initialize();
  await service.createUser({ id: 'boss', displayName: 'Platform Admin', platformAdmin: true }, { kind: 'system' });
  const boss: Actor = { kind: 'user', userId: 'boss' };
  return { root, service, boss };
}

test('通常メンバーのモデル利用も所属・モデル許可・予算を通し、キーの所属は変更できない',async()=>{
  const {service,boss}=await setup('knowledge-member');
  await service.createUser({id:'reader',displayName:'一般メンバー'},boss);
  await service.createProject({id:'p-a',name:'資料',ownerId:'boss'},boss);
  await service.createProject({id:'p-b',name:'別資料',ownerId:'boss'},boss);
  await service.addProjectMember('p-a','reader','member',boss);
  await service.updateProject('p-a',{allowedModels:['fixture/model'],budgetUsd:0.0001,pricing:{'fixture/model':{inputUsdPerMTok:1,outputUsdPerMTok:1}}},boss);
  const reader:Actor={kind:'user',userId:'reader'};
  const held=await service.reserve(reader,{projectId:'p-a',model:'fixture/model',estInputTokens:10,estOutputTokens:10});
  await service.commitReservation(held.reservationId,{inputTokens:10,outputTokens:10},reader);
  await assert.rejects(service.reserve(reader,{projectId:'p-b',model:'fixture/model'}));
  await expectError(()=>service.reserve(reader,{projectId:'p-a',model:'other/model'}),403,'model_not_allowed');
  await assert.rejects(service.reserve(reader,{projectId:'p-a',model:'fixture/model',estInputTokens:1000,estOutputTokens:1000}));
  const key=await service.issueKey('p-a','検証',boss),identity=await service.authenticateKey(key.key);
  const reservation=await service.reserve({kind:'key',...identity},{projectId:'p-b',model:'fixture/model'});
  assert.ok(reservation.reservationId);
});
/** 指定 status/code の TeamAccessError が飛ぶことを検証します。 */
async function expectError(action: () => Promise<unknown>, status: number, code: string): Promise<void> {
  try { await action(); }
  catch (error) {
    assert.ok(error instanceof TeamAccessError, `TeamAccessError がexpected でしたが別物: ${String(error)}`);
    assert.equal(error.status, status, `status: ${error.message}`);
    assert.equal(error.code, code, `code: ${error.message}`);
    return;
  }
  assert.fail(`${status} ${code} の失敗を期待しましたが成功しました。`);
}

test('仮想キーはハッシュ保存で原文は発行時だけ。失効後は認証拒否', async () => {
  const { root, service, boss } = await setup('keys');
  await service.createProject({ id: 'p-a', name: 'Project A', ownerId: 'boss' }, boss);
  const issued = await service.issueKey('p-a', 'ci-runner', boss);
  assert.match(issued.key, /^wtvk_/);
  // 原文は発行応答だけ。状態ファイルには原文も平文シークレットも存在しません（SHA-256ハッシュのみ）。
  const stateText = await readFile(path.join(root, 'team-access.json'), 'utf8');
  assert.ok(!stateText.includes(issued.key), '状態ファイルに原文キーが混入しています');
  assert.ok(/"hash":\s*"[0-9a-f]{64}"/.test(stateText), 'SHA-256ハッシュが保存されていません');
  // 原文認証は成功し、キーの所属プロジェクトが返ります。
  assert.deepEqual(await service.authenticateKey(issued.key), { projectId: 'p-a', keyId: issued.keyId });
  // 失効後は同じ原文でも認証できません。
  await service.revokeKey('p-a', issued.keyId, boss);
  await expectError(() => service.authenticateKey(issued.key), 401, 'key_revoked');
  await expectError(() => service.authenticateKey('wtvk_forged'), 401, 'invalid_key');
});

test('モデル許可は完全一致（exact match）で、部分一致・大文字小文字違いは拒否', async () => {
  const { service, boss } = await setup('models');
  await service.createProject({ id: 'p-a', name: 'A', ownerId: 'boss' }, boss);
  await service.updateProject('p-a', { allowedModels: ['exact-model'] }, boss);
  const { keyId } = await service.issueKey('p-a', 'k', boss);
  const key: Actor & { kind: 'key' } = { kind: 'key', keyId, projectId: 'p-a' };
  // 完全一致は成功
  const ok = await service.reserve(key, { model: 'exact-model', estInputTokens: 10 });
  assert.ok(ok.reservationId);
  // 完全一致以外はすべて model_not_allowed
  for (const model of ['Exact-model', 'exact-mode', 'exact-model-2', ' exact-model', 'exact model']) {
    await expectError(() => service.reserve(key, { model }), 403, 'model_not_allowed');
  }
});

test('並行予約でも予算を超過しない（予約は保持額を見て直列判定）', async () => {
  const { service, boss } = await setup('budget');
  await service.createProject({ id: 'p-a', name: 'A', ownerId: 'boss' }, boss);
  await service.updateProject('p-a', { allowedModels: ['paid'], pricing: { paid: { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } }, budgetUsd: 10 }, boss);
  const { keyId } = await service.issueKey('p-a', 'k', boss);
  const key: Actor & { kind: 'key' } = { kind: 'key', keyId, projectId: 'p-a' };
  // 予算10 USD、1予約=1.0 USD（入力100万tokens）を20件同時発行 → 成功はちょうど10件、残りは429。
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => service.reserve(key, { model: 'paid', estInputTokens: 1_000_000 })));
  const successes = attempts.filter(a => a.status === 'fulfilled');
  const failures = attempts.filter(a => a.status === 'rejected');
  assert.equal(successes.length, 10, `成功件数: ${successes.length}`);
  assert.ok(failures.every(f => f.status === 'rejected' && f.reason instanceof TeamAccessError && f.reason.status === 429 && f.reason.code === 'budget_exceeded'), '失敗は全て budget_exceeded です');
  const usage = await service.projectUsage('p-a', key);
  assert.equal(usage.project.heldUsd, 10);
  assert.equal(usage.project.spendUsd, 0);
  // 取消で保持額が空き、その分だけ再予約できます（8+1≤10、9+1≤10、10+1>10）。
  const reserved = usage.reservations.map(r => r.id);
  await service.cancelReservation(reserved[0]!, key);
  await service.cancelReservation(reserved[1]!, key);
  assert.equal((await service.projectUsage('p-a', key)).project.heldUsd, 8);
  await service.reserve(key, { model: 'paid', estInputTokens: 1_000_000 });
  await service.reserve(key, { model: 'paid', estInputTokens: 1_000_000 });
  await expectError(() => service.reserve(key, { model: 'paid', estInputTokens: 1_000_000 }), 429, 'budget_exceeded');
  // 確定（Commit）は実トークンで再計算し、予約の保持額を確定費用へ移します。
  const committed = await service.commitReservation(reserved[2]!, { inputTokens: 500_000, outputTokens: 0 }, key);
  assert.equal(committed.committedUsd, 0.5);
  const after = await service.projectUsage('p-a', key);
  assert.equal(after.project.spendUsd, 0.5);
  assert.equal(after.project.heldUsd, 9); // 10予約 -2取消 +2再予約 = 10生効、うち1件を確定して保持9
  // 二重確定は拒否。
  await expectError(() => service.commitReservation(reserved[2]!, {}, key), 409, 'reservation_not_open');
});

test('料金不明をゼロに捏造しない。予算有効なら価格未設定の予約を拒否、予算無しは費用不明のまま確定', async () => {
  const { root, service, boss } = await setup('pricing');
  // ケース1: 予算あり＋価格無し → 予約拒否（409 model_price_required）
  await service.createProject({ id: 'p-budget', name: 'B', ownerId: 'boss' }, boss);
  await service.updateProject('p-budget', { allowedModels: ['opaque'], budgetUsd: 5 }, boss);
  const kb = await service.issueKey('p-budget', 'k', boss);
  const keyB: Actor & { kind: 'key' } = { kind: 'key', keyId: kb.keyId, projectId: 'p-budget' };
  await expectError(() => service.reserve(keyB, { model: 'opaque', estInputTokens: 100 }), 409, 'model_price_required');
  // 明示価格を追加すれば同じ予約が通る（拒否または明示価格設定の要件）
  await service.updateProject('p-budget', { pricing: { opaque: { inputUsdPerMTok: 2, outputUsdPerMTok: 1 } } }, boss);
  await service.reserve(keyB, { model: 'opaque', estInputTokens: 100 });
  // ケース2: 予算無し＋価格無し → 費用不明（undefined）として受理し、確定しても spendUsd は 0 のまま（0費用として記録しない）
  await service.createProject({ id: 'p-free', name: 'F', ownerId: 'boss' }, boss);
  await service.updateProject('p-free', { allowedModels: ['opaque'] }, boss);
  const kf = await service.issueKey('p-free', 'k', boss);
  const keyF: Actor & { kind: 'key' } = { kind: 'key', keyId: kf.keyId, projectId: 'p-free' };
  const free = await service.reserve(keyF, { model: 'opaque', estInputTokens: 100 });
  assert.equal(free.estimatedUsd, undefined);
  const done = await service.commitReservation(free.reservationId, {}, keyF);
  assert.equal(done.committedUsd, undefined);
  assert.equal((await service.projectUsage('p-free', keyF)).project.spendUsd, 0);
  const stateText = await readFile(path.join(root, 'team-access.json'), 'utf8');
  assert.ok(JSON.parse(stateText).projects.find((p: { id: string }) => p.id === 'p-free').reservations.some((r: { costKnown: boolean }) => r.costKnown === false), '費用不明フラグが状態へ残ります');
});

test('回数枠（利用枠）は窓付きで消化し、満了後は復活する', async () => {
  const now = { value: Date.UTC(2026, 9, 4, 12, 0, 0) };
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-team-quota-'));
  const service = new TeamAccessService({ root, now: () => now.value });
  await service.createUser({ id: 'boss', displayName: 'Admin', platformAdmin: true }, { kind: 'system' });
  const boss: Actor = { kind: 'user', userId: 'boss' };
  await service.createProject({ id: 'p-q', name: 'Q', ownerId: 'boss' }, boss);
  await service.updateProject('p-q', { allowedModels: ['m'], requestLimit: { maxRequests: 2, windowMs: 60_000 } }, boss);
  const { keyId } = await service.issueKey('p-q', 'k', boss);
  const key: Actor & { kind: 'key' } = { kind: 'key', keyId, projectId: 'p-q' };
  await service.reserve(key, { model: 'm' });
  await service.reserve(key, { model: 'm' });
  await expectError(() => service.reserve(key, { model: 'm' }), 429, 'request_limit_exceeded');
  now.value += 60_001; // 窓を明ける
  await service.reserve(key, { model: 'm' });
});

test('他プロジェクトのキー・履歴・予約へのアクセスを拒否（プロジェクト分離）', async () => {
  const { service, boss } = await setup('isolation');
  await service.createUser({ id: 'alice', displayName: 'Alice' }, boss);
  await service.createUser({ id: 'bob', displayName: 'Bob' }, boss);
  await service.createProject({ id: 'p-a', name: 'A', ownerId: 'boss' }, boss);
  await service.createProject({ id: 'p-b', name: 'B', ownerId: 'boss' }, boss);
  await service.addProjectMember('p-a', 'alice', 'owner', boss);
  await service.addProjectMember('p-b', 'bob', 'owner', boss);
  await service.updateProject('p-b', { allowedModels: ['m'], pricing: { m: { inputUsdPerMTok: 1, outputUsdPerMTok: 0 } } }, boss);
  const alice: Actor = { kind: 'user', userId: 'alice' };
  const aliceKey = await service.issueKey('p-a', 'ak', alice);
  const keyA: Actor & { kind: 'key' } = { kind: 'key', keyId: aliceKey.keyId, projectId: 'p-a' };
  const bobKey = await service.issueKey('p-b', 'bk', { kind: 'user', userId: 'bob' });
  const keyB: Actor & { kind: 'key' } = { kind: 'key', keyId: bobKey.keyId, projectId: 'p-b' };
  // Alice（p-a の owner）は p-b の利用履歴・キーを見られません。
  await expectError(() => service.projectUsage('p-b', alice), 403, 'project_membership_required');
  // p-b の予約を p-a のキーで確定・取消もできません。
  const reservationB = await service.reserve(keyB, { model: 'm', estInputTokens: 100 });
  await expectError(() => service.commitReservation(reservationB.reservationId, {}, keyA), 403, 'cross_project_denied');
  await expectError(() => service.cancelReservation(reservationB.reservationId, keyA), 403, 'cross_project_denied');
  // p-a のキーで p-b のキー発行（管理操作）も仮想キーでは不可。
  await expectError(() => service.issueKey('p-b', 'x', keyA), 403, 'key_admin_forbidden');
  // 自分のプロジェクト参照は成功します。
  const mine = await service.projectUsage('p-a', alice);
  assert.equal(mine.project.id, 'p-a');
  assert.equal(mine.keys.length, 1);
  assert.ok(!JSON.stringify(mine).includes(aliceKey.key), '参照応答に原文キーは出ません');
});

test('監査履歴が残り、秘密（原文キー）や禁止キーが混入しない', async () => {
  const { root, service, boss } = await setup('audit');
  await service.createProject({ id: 'p-a', name: 'A', ownerId: 'boss' }, boss);
  const issued = await service.issueKey('p-a', 'k', boss);
  const key: Actor & { kind: 'key' } = { kind: 'key', keyId: issued.keyId, projectId: 'p-a' };
  await service.reserve(key, { model: 'ghost', estInputTokens: 1 }).catch(() => undefined); // 許可外モデルの失敗操作後も履歴は残ります
  const overview = await service.overview();
  const actions = overview.audit.map(a => a.action);
  assert.ok(actions.includes('project_create') && actions.includes('key_issue'), `監査: ${actions.join(',')}`);
  // detail に secret/password/plaintext 相当のキー名がなく、原文も監査へ残りません。
  const auditText = JSON.stringify(overview.audit);
  assert.ok(!auditText.includes(issued.key), '監査に原文キーが残っています');
  assert.ok(!/secret|password|plaintext|authorization/i.test(auditText), '監査detailに禁止キー名があります');
  // 状態ファイル自体にも原文は無し（二重確認）。
  assert.ok(!(await readFile(path.join(root, 'team-access.json'), 'utf8')).includes(issued.key));
});

test('専用 root への原子保存は再起動（新インスタンス）後も同一状態を読める', async () => {
  const { root, service, boss } = await setup('persist');
  await service.createProject({ id: 'p-a', name: 'A', ownerId: 'boss' }, boss);
  const issued = await service.issueKey('p-a', 'k', boss);
  // 同一 root へ新しい Service を作ると、ハッシュ認証で状態が引き継がれます。
  const reopened = new TeamAccessService({ root });
  await reopened.initialize();
  const auth = await reopened.authenticateKey(issued.key);
  assert.equal(auth.projectId, 'p-a');
  const usage = await reopened.projectUsage('p-a', { kind: 'user', userId: 'boss' });
  assert.equal(usage.keys[0]!.label, 'k');
});
