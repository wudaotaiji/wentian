import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildAgentStatusReport, formatAgentStatusReport } from './agent-status-report.js';
import { connectionStorePath } from './agent-connection-policy.js';
import { workCachePath, type AgentWorkEvidence } from './agent-work-policy.js';

/** 保存済みの接続記録の形（実運用の台帳と同じ最小構成）。 */
const connection = (over: Record<string, unknown> = {}) => ({ mode: 'free', model: 'goose/example-free', status: 'verified', checkedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), fingerprint: 'test-config', policyHash: 'test-policy', ...over });
/** 保存済みの能力記録の形。本人申告を混ぜないため、検証が書いた台帳そのものを置いて整地します。 */
const evidence = (over: Partial<AgentWorkEvidence>): AgentWorkEvidence => ({ revision: 1, identity: 'test-identity', checkedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), retryAt: new Date(Date.now() + 900_000).toISOString(), status: 'failed', capabilities: {}, evidenceDirectory: 'test-evidence', reason: '', ...over });

/** 状態報告は台帳の読み取りだけで作るため、テスト前の整地も台帳ファイルの書き出しだけになります。 */
async function resetStores(agents: Record<string, unknown> = {}, work: Record<string, AgentWorkEvidence> = {}) {
  for (const target of [connectionStorePath(), workCachePath()]) await mkdir(path.dirname(target), { recursive: true });
  await writeFile(connectionStorePath(), JSON.stringify({ agents }));
  await writeFile(workCachePath(), JSON.stringify({ agents: work }));
}

test('保存済みの記録だけで状態を作り、接続確認と実作業能力を分けて報告する', async () => {
  const health = await mkdtemp(path.join(tmpdir(), 'wentian-status-health-'));
  await writeFile(path.join(health, 'summary.json'), JSON.stringify({ runs: [{ run_id: 'recent', observed_time: new Date().toISOString(),
    agents: [{ name: 'goose', result: 'health_and_design_review_success' }, { name: 'crush', result: 'health_and_readonly_review_success' }] }] }));
  await resetStores({
    // 接続確認済みでも実作業能力が未合格なら、実作業を任せられるとは書きません。
    goose: connection(),
    crush: connection({ status: 'failed', reason: '上流プロバイダーが利用制限で応答しませんでした。', stage: 'probe', model: 'crush/example-free',
      attempts: [{ model: 'crush/example-free', status: 'failed', reason: 'upstream_limit' }] }),
    // 合格記録でも有効期限を越えたら確認済みへ数えません。
    kilo: connection({ status: 'verified', expiresAt: new Date(Date.now() - 1).toISOString(), model: 'kilo/kilo-auto/free' }),
  }, {
    goose: evidence({ status: 'passed', capabilities: { reading: true, coding: true }, reason: 'ホスト検収に合格しました。', evidenceDirectory: 'C:\\wentian\\evidence\\goose' }),
    crush: evidence({ status: 'failed', failureKind: 'upstream_limit', failures: 2, retryAt: new Date(Date.now() + 900_000).toISOString(), reason: '上流の利用制限で再試行待ちです。' }),
    kilo: evidence({ status: 'failed', failureKind: 'work_incomplete', failures: 3, attentionRequired: true, retryAt: new Date(Date.now() + 86_400_000).toISOString(), reason: '同一設定の連続失敗で利用者対応待ちです。' }),
  });
  const report = await buildAgentStatusReport({ directory: health, now: Date.now() });
  const row = (id: string) => report.agents.find(agent => agent.id === id)!;
  assert.equal(report.summary.total, 10);
  assert.equal(report.summary.managed, 10);
  // ローカルモデルも管理対象ですが、保存済み証拠がなければ合格にしません。
  for (const id of ['ollama', 'lmstudio']) {
    assert.equal(row(id).managed, true);
    assert.equal(row(id).connectionState, 'unverified');
    assert.equal(row(id).workState, 'unverified');
    assert.deepEqual(row(id).capabilities, {});
  }
  assert.deepEqual({ verified: report.summary.connectionVerified, work: report.summary.workVerified, retry: report.summary.retryPending, attention: report.summary.attentionRequired, unverified: report.summary.unverified },
    { verified: 1, work: 1, retry: 1, attention: 1, unverified: 7 }, '接続確認と実作業検証の内訳が台帳と一致しません。');
  assert.equal(row('goose').connectionState, 'verified');
  assert.equal(row('goose').workState, 'passed');
  assert.deepEqual(row('goose').capabilities, { reading: true, coding: true });
  assert.equal(row('crush').connectionState, 'failed');
  assert.equal(row('crush').workState, 'retry_pending');
  assert.equal(row('crush').workFailureKind, 'upstream_limit');
  assert.equal(row('kilo').connectionState, 'expired', '期限を越えた接続記録を確認済みへ数えています。');
  assert.equal(row('kilo').workState, 'attention_required');
  assert.equal(row('opencode').workState, 'unverified');
  // 判断根拠を隠さないため、キャッシュの出所・保存場所・鮮度を報告本体へ出します。
  assert.equal(report.cache.healthSource, path.join(health, 'summary.json'));
  assert.equal(report.cache.healthFreshWithin24Hours, true);
  assert.equal(report.cache.connectionStore, connectionStorePath());
  assert.equal(report.cache.workStore, workCachePath());
  const text = formatAgentStatusReport(report);
  assert.match(text, /実作業能力: 合格 \/ 認定 読・実/);
  assert.match(text, /接続: 失敗（無料モデル \/ crush\/example-free）/);
  assert.match(text, /モデル試行: crush\/example-free=failed/);
  assert.match(text, /実作業能力: 再試行待ち/);
  assert.match(text, /連続失敗: 2回 \/ 種別 upstream_limit/);
  assert.match(text, /次回再試行予定: /);
  assert.match(text, /実作業能力: 対応待ち/);
  assert.match(text, /検証資料: /);
  // 接続確認済みだけを見て実作業を任せる誤読を防ぐ注記を、必ず最終行へ置きます。
  assert.match(text, /接続確認済みは実作業の保証ではありません。/);
});

test('Health Check Cacheを読み取れない場合はCLIを起動せず再確認扱いで報告する', async () => {
  await resetStores();
  const missing = path.join(await mkdtemp(path.join(tmpdir(), 'wentian-status-empty-')), 'missing-cache');
  const startedAt = Date.now();
  const report = await buildAgentStatusReport({ directory: missing, now: Date.now() });
  // 報告作成が実測を兼ねると、状態確認そのものがAgentsを起動して時間とTokensを消費します。ここでは読み取りだけのはずです。
  assert.ok(Date.now() - startedAt < 20_000, '状態報告の作成がCLI生存確認を実行しています。');
  assert.equal(report.cache.healthFreshWithin24Hours, false);
  assert.equal(report.summary.workVerified, 0);
  assert.equal(report.summary.unverified, 10);
  assert.equal(report.agents.every(agent => agent.liveState === undefined), true, '生存確認の記録がないAgentへ観測結果を付けています。');
  assert.match(formatAgentStatusReport(report), /生存確認の記録なし（goose）/);
  assert.match(formatAgentStatusReport(report), /実作業能力: 未検証 \/ 認定 なし/);
});
