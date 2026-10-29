import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMIT_WAIT_BUDGET, UPSTREAM_LIMIT_MAX_MS, UpstreamLimitWindow, isUpstreamLimit, parseRetryAfterMs, planLimitWait } from './upstream-limit-window.js';

test('Retry-Afterは秒数・HTTP日付の両方を読み、範囲へ縮退する', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  assert.equal(parseRetryAfterMs('7', now), 7_000);
  assert.equal(parseRetryAfterMs(7, now), 7_000);
  assert.equal(parseRetryAfterMs('Fri, 02 Oct 2026 12:00:20 GMT', now), 20_000);
  // 未来日時・不正値・大きすぎる値をそのまま待たせず、上限と既定値へ縮退します。
  assert.equal(parseRetryAfterMs('Fri, 02 Oct 2027 12:00:00 GMT', now), UPSTREAM_LIMIT_MAX_MS);
  assert.equal(parseRetryAfterMs('まれ', now), 30_000);
  assert.equal(parseRetryAfterMs(undefined, now), 30_000);
  assert.equal(parseRetryAfterMs('-5', now), 1_000);
  // 過去の日時は0待機と誤認せず、既定待機へ戻します。
  assert.equal(parseRetryAfterMs('Fri, 02 Oct 2026 11:00:00 GMT', now), 30_000);
});

test('利用制限は再試行可能時刻まで候補から外れ、成功で解除される', () => {
  const limits = new UpstreamLimitWindow();
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  assert.equal(limits.limited('lmstudio', now), false);
  const record = limits.recordLimit('lmstudio', '45', now);
  assert.equal(record.waitMs, 45_000);
  assert.equal(record.retryAvailableAt, '2026-10-02T12:00:45.000Z');
  assert.equal(limits.limited('lmstudio', now + 44_000), true);
  assert.deepEqual(limits.snapshot(now + 44_000), { 'lmstudio': '2026-10-02T12:00:45.000Z' });
  assert.deepEqual(limits.state(now + 44_000), { status: 'waiting', retryAvailableAt: '2026-10-02T12:00:45.000Z', waitMs: 1_000 });
  // 短いRetry-Afterで待機が伸び戻らないよう、後ろへ伸びたものを維持します。
  limits.recordLimit('lmstudio', '10', now);
  assert.equal(limits.retryAvailableAtIso('lmstudio', now), '2026-10-02T12:00:45.000Z');
  assert.equal(limits.limited('lmstudio', now + 45_000), false);
  assert.deepEqual(limits.state(now + 45_000), { status: 'available' });
  limits.recordLimit('lmstudio', '45', now);
  limits.clear('lmstudio');
  assert.equal(limits.limited('lmstudio', now), false);
  assert.deepEqual(limits.snapshot(now), {});
});

test('上流の利用制限と上流障害をHTTP状態で区別する', () => {
  assert.equal(isUpstreamLimit(429), true);
  assert.equal(isUpstreamLimit(402), true);
  assert.equal(isUpstreamLimit(503), false);
  assert.equal(isUpstreamLimit(400), false);
  assert.equal(isUpstreamLimit(undefined), false);
});

test('待機予算は回数と累計時間の上限で打ち切り、Retry-Afterを優先する', () => {
  const budget = { ...DEFAULT_LIMIT_WAIT_BUDGET, baseMs: 10_000, maxWaitMs: 20_000, maxTotalMs: 45_000, maxWaits: 3 };
  // Retry-After 指定は既定より大きくても上限内で尊重し、無い場合だけ指数的に伸ばします。
  assert.deepEqual(planLimitWait(0, 0, '5', budget), { waitMs: 5_000, allowed: true, reason: 'wait' });
  assert.deepEqual(planLimitWait(0, 0, undefined, budget), { waitMs: 10_000, allowed: true, reason: 'wait' });
  assert.equal(planLimitWait(1, 10_000, undefined, budget).waitMs, 20_000);
  assert.equal(planLimitWait(0, 0, '9999', budget).waitMs, 20_000);
  // 累計予算を超える待機は許可せず、打ち切り理由を残します。
  assert.deepEqual(planLimitWait(1, 30_000, undefined, budget), { waitMs: 0, allowed: false, reason: 'max_total' });
  assert.deepEqual(planLimitWait(3, 0, '5', budget), { waitMs: 0, allowed: false, reason: 'max_waits' });
});
