/**
 * 限定外部タスクAPI（Confined External Task Routes）試験
 *
 * runTask を差し替えてコア実行（CLI起動・原本反映） 없이 HTTP境界だけを 검증する。
 * 認証拒否・モデル未設定・ボディホワイトリスト・許可パス検証の順で門を确认する。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { registerConfinedExternalTaskRoutes, type ConfinedExternalTaskRouteOptions } from './confined-external-task-routes.js';
import { taskOutcome } from './task-outcome.js';
import type { ConfinedExternalTaskResult } from './confined-external-task.js';

/** 成功を返すスタブ結果（生データなし・パスとハッシュのみ）。 */
const stubResult: ConfinedExternalTaskResult = {
  outcome: taskOutcome('success', { taskId: 'direct-test', manifestPath: 'C:/tmp/manifest.json', reason: '1件を反映しました。' }),
  changes: [{ path: 'target/a.txt', bytes: 9, beforeHash: 'b'.repeat(64), afterHash: 'a'.repeat(64) }],
  ignoredProposalFields: [], cliLaunchCount: 1, inputFiles: [],
};

/** mkdtemp（一時目録）を原本に見立てたapp。target/ は実在、docs/ は実在ディレクトリ（拒否確認用）。 */
async function buildApp(options: Partial<ConfinedExternalTaskRouteOptions> & Pick<ConfinedExternalTaskRouteOptions, 'authorize'> = { authorize: () => true }) {
  const workspace = await mkdtemp(path.join(tmpdir(), `wentian-confined-api-${process.pid}-`));
  await mkdir(path.join(workspace, 'target'), { recursive: true });
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, 'target', 'a.txt'), '古い内容\n');
  const seen: Array<{ plan: unknown; workspace: string; options: unknown }> = [];
  // コア実行部（CLI起動・原本反映）は呼ばないスタブ。受け取ったplan/optionsを検証用に記録する。
  const runTask = async (plan: unknown, ws: string, taskOptions: unknown): Promise<ConfinedExternalTaskResult> => { seen.push({ plan, workspace: ws, options: taskOptions }); return stubResult; };
  const app = Fastify();
  registerConfinedExternalTaskRoutes(app, { workspace, model: 'managed/claude-test', runTask, ...options });
  await app.ready();
  return { app, workspace, seen };
}

const validBody = {
  prompt: 'target/a.txt を更新してください。',
  allowedWritePaths: ['target/a.txt'],
  acceptanceChecks: [{ path: 'target/a.txt', contains: 'ACCEPTED' }],
};

test('権限なしは 403: authorize拒否では実行せずボディ検証も通さない', async () => {
  const { app, workspace, seen } = await buildApp({ authorize: () => false });
  const response = await app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: validBody });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'confined_task_forbidden');
  assert.equal(seen.length, 0);
  await app.close(); await rm(workspace, { recursive: true, force: true });
});

test('authorize例外も拒否（fail-closed / 閉じる方向の失敗）', async () => {
  const { app, workspace, seen } = await buildApp({ authorize: () => { throw new Error('認証基盤障害'); } });
  const response = await app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: validBody });
  assert.equal(response.statusCode, 403);
  assert.equal(seen.length, 0);
  await app.close(); await rm(workspace, { recursive: true, force: true });
});

test('モデル未設定は 503: このAPIは実行しない（設定修正を要求）', async () => {
  const { app, workspace, seen } = await buildApp({ authorize: () => true, model: undefined });
  const response = await app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: validBody });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'confined_model_not_configured');
  assert.equal(seen.length, 0);
  await app.close(); await rm(workspace, { recursive: true, force: true });
});

test('ボディはホワイトリスト3キーのみ: executable等の想定外キーは 400', async () => {
  const { app, workspace, seen } = await buildApp();
  for (const extra of [{ executable: 'cmd' }, { args: ['/c', 'dir'] }, { model: 'user/choice' }, { command: 'claude --yolo' }]) {
    const response = await app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: { ...validBody, ...extra } });
    assert.equal(response.statusCode, 400, JSON.stringify(extra));
    assert.equal(response.json().error.code, 'unknown_body_key');
  }
  assert.equal(seen.length, 0);
  await app.close(); await rm(workspace, { recursive: true, force: true });
});

test('許可書込みパスの門: ディレクトリ・ワイルドカード・全体・範囲外・秘密名は 400', async () => {
  const { app, workspace, seen } = await buildApp();
  const badPaths = [
    ['docs'],                 // 実在ディレクトリ（具体ファイル要求）
    ['.'],                    // 全体指定
    ['target/*.txt'],         // ワイルドカード
    ['../outside.txt'],       // 親階層脱出
    [path.join(workspace, 'target', 'a.txt')], // 絶対パス
    ['.env'],                 // 秘密ファイル
    ['config/認証台帳.txt'],   // 認証台帳
    ['.git/config'],          // Git管理用
  ];
  for (const allowedWritePaths of badPaths) {
    const response = await app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: { ...validBody, allowedWritePaths } });
    assert.equal(response.statusCode, 400, JSON.stringify(allowedWritePaths));
    // ボディ形状の拒否（invalid_allowed_write_paths）と方針検証の拒否（invalid_confined_request）のいずれも400で正当。
    assert.ok(['invalid_allowed_write_paths', 'invalid_confined_request'].includes(response.json().error.code), JSON.stringify(response.json()));
  }
  assert.equal(seen.length, 0);
  await app.close(); await rm(workspace, { recursive: true, force: true });
});

test('受入検査の門: 絶対パス等の不正checkは 400（実行前に固定できなければ拒否）', async () => {
  const { app, workspace, seen } = await buildApp();
  const response = await app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: { ...validBody, acceptanceChecks: [{ path: 'C:/Windows/win.ini' }] } });
  assert.equal(response.statusCode, 400);
  assert.equal(seen.length, 0);
  await app.close(); await rm(workspace, { recursive: true, force: true });
});

test('正常系: 管理者POSTでホスト固定モデルと具体許可パスが実行へ渡り、応答に依頼文を含めない', async () => {
  const { app, workspace, seen } = await buildApp({ authorize: () => true });
  const response = await app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: validBody });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.status, 'success');
  assert.equal(payload.model, 'managed/claude-test');
  assert.deepEqual(payload.changes, [{ path: 'target/a.txt', bytes: 9, beforeHash: 'b'.repeat(64), afterHash: 'a'.repeat(64) }]);
  // 応答へ依頼生データ（prompt）を載せない。
  assert.ok(!response.body.includes('更新してください'));
  assert.equal(seen.length, 1);
  const passed = seen[0] as { plan: { text: string; allowedWritePaths: string[] }; workspace: string; options: { model: string } };
  assert.equal(passed.options.model, 'managed/claude-test');
  assert.deepEqual(passed.plan.allowedWritePaths, ['target/a.txt']);
  assert.equal(passed.workspace, workspace);
  await app.close(); await rm(workspace, { recursive: true, force: true });
});

test('実行部が政策拒否を投げたら 400、想定外障害は情報伏せて 500', async () => {
  const rejecting = await buildApp({ authorize: () => true, runTask: (async () => { throw new Error('書き込み許可範囲外のため提案を拒否しました: x'); }) as never });
  const rejected = await rejecting.app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: validBody });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json().error.code, 'confined_task_rejected');
  const crashing = await buildApp({ authorize: () => true, runTask: (async () => { throw new Error('internal stack C:\\secret\\path'); }) as never });
  const crashed = await crashing.app.inject({ method: 'POST', url: '/api/workbench/confined-task', payload: validBody });
  assert.equal(crashed.statusCode, 500);
  assert.ok(!crashed.body.includes('secret'));
  await rejecting.app.close(); await crashing.app.close();
  await rm(rejecting.workspace, { recursive: true, force: true }); await rm(crashing.workspace, { recursive: true, force: true });
});
