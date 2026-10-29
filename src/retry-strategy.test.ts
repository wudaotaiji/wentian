import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateBackoff, isRetryableError, NonRetryableError, retryWithBackoff } from './retry-strategy.js';

test('isRetryableError: AbortError は false', () => {
  assert.equal(isRetryableError({ name: 'AbortError' }), false);
  assert.equal(isRetryableError({ code: 'ABORT_ERR' }), false);
});

test('isRetryableError: 401/403/400 は false', () => {
  assert.equal(isRetryableError({ status: 401 }), false);
  assert.equal(isRetryableError({ status: 403 }), false);
  assert.equal(isRetryableError({ status: 400 }), false);
  assert.equal(isRetryableError({ statusCode: 422 }), false);
});

test('isRetryableError: 502/503/504/408/429 は true', () => {
  assert.equal(isRetryableError({ status: 502 }), true);
  assert.equal(isRetryableError({ status: 503 }), true);
  assert.equal(isRetryableError({ status: 504 }), true);
  assert.equal(isRetryableError({ status: 408 }), true);
  assert.equal(isRetryableError({ status: 429 }), true);
});

test('isRetryableError: ネットワークエラーコードは true', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']) {
    assert.equal(isRetryableError({ code }), true, `${code} should be retryable`);
  }
});

test('isRetryableError: NonRetryableError は false', () => {
  const err = new NonRetryableError('test');
  assert.equal(isRetryableError(err), false);
});

test('calculateBackoff: 指数バックオフで増加する', () => {
  const a1 = calculateBackoff(1, 1000, 30000);
  const a2 = calculateBackoff(2, 1000, 30000);
  const a3 = calculateBackoff(3, 1000, 30000);
  // jitterがあるので幅がある。平均値の比較
  assert.ok(a1 >= 800 && a1 <= 1200, `a1=${a1}`);
  assert.ok(a2 >= 1600 && a2 <= 2400, `a2=${a2}`);
  assert.ok(a3 >= 3200 && a3 <= 4800, `a3=${a3}`);
});

test('calculateBackoff: maxDelay で頭打ち', () => {
  const a10 = calculateBackoff(10, 1000, 5000);
  assert.ok(a10 <= 6000, 'maxDelay*1.2以内');
});

test('retryWithBackoff: 1回目で成功', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => { calls += 1; return 'ok'; }, { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(calls, 1);
  assert.equal(result.value, 'ok');
  assert.equal(result.attempts, 1);
  assert.equal(result.totalDelayMs, 0);
});

function networkError(code: string, msg: string): Error & { code: string } {
  const err = new Error(msg) as Error & { code: string };
  err.code = code;
  return err;
}

test('retryWithBackoff: 一時的な失敗はリトライして成功', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls += 1;
    if (calls < 3) throw networkError('ECONNRESET', 'connection reset');
    return 'success';
  }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 });
  assert.equal(calls, 3);
  assert.equal(result.value, 'success');
  assert.equal(result.attempts, 3);
  assert.ok(result.totalDelayMs > 0);
});

test('retryWithBackoff: NonRetryableErrorは即座にthrow', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(async () => { calls += 1; throw new NonRetryableError('forbidden'); }, { maxAttempts: 5, baseDelayMs: 1 }),
    /forbidden/,
  );
  assert.equal(calls, 1);
});

test('retryWithBackoff: maxAttempts を超えると失敗', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(async () => { calls += 1; throw networkError('ECONNRESET', 'reset'); }, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 }),
    /reset/,
  );
  assert.equal(calls, 2);
});

test('retryWithBackoff: onRetry hook が各retryで呼ばれる', async () => {
  let calls = 0;
  const retries: number[] = [];
  const result = await retryWithBackoff(async () => {
    calls += 1;
    if (calls < 3) throw networkError('ETIMEDOUT', 'timeout');
    return 'ok';
  }, {
    maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5,
    onRetry: (attempt) => retries.push(attempt),
  });
  assert.equal(result.value, 'ok');
  // 3回目で成功するので retry hook は 2回 (attempt 1, 2)
  assert.deepEqual(retries, [1, 2]);
});
