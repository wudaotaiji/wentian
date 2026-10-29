/**
 * LLM呼び出しのリトライ戦略: 5層アーキテクチャ拡張 Phase 8。
 * 設計参照: docs/ARCHITECTURE.md
 *
 * ネットワーク系エラー (ECONNRESET, ETIMEDOUT, ENOTFOUND, 502/503/504) は
 * 指数バックオフで最大 maxAttempts 回リトライする。
 * 認証エラー (401/403) や リクエスト不正 (400) は即座にエラー返却。
 */

const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ETIMEOUT']);
const RETRYABLE_HTTP_STATUS = new Set([502, 503, 504, 408, 429]);
const NON_RETRYABLE_HTTP_STATUS = new Set([400, 401, 403, 404, 422]);

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** リトライ毎に呼ばれるhook (進捗ログ用) */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export class NonRetryableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** エラーがretryableか判定します。 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  // 既に NonRetryableError ならretryしない
  if (error instanceof NonRetryableError) return false;
  if (typeof error !== 'object') return true;
  const e = error as { code?: string; status?: number; statusCode?: number; cause?: unknown; name?: string };
  if (e.code && NETWORK_ERROR_CODES.has(e.code)) return true;
  const status = e.status || e.statusCode;
  if (status && RETRYABLE_HTTP_STATUS.has(status)) return true;
  if (status && NON_RETRYABLE_HTTP_STATUS.has(status)) return false;
  // AbortError はretryしない (ユーザー中断)
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return false;
  // ネットワークエラーメッセージパターン
  const message = (error as { message?: string }).message?.toLowerCase() || '';
  if (message.includes('network') || message.includes('econnreset') || message.includes('etimedout') || message.includes('socket hang up')) return true;
  // デフォルトはretryable (LLMの一時的な失敗を想定)
  return true;
}

/** 指数バックオフでdelayを計算します。 */
export function calculateBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  // attempt=1 → baseDelay, attempt=2 → baseDelay*2, ...
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  // jitter (±20%)
  const jitter = exp * (0.8 + Math.random() * 0.4);
  return Math.floor(jitter);
}

export interface RetryResult<T> {
  value: T;
  attempts: number;
  totalDelayMs: number;
}

/** リトライ付きで関数を実行します。 */
export async function retryWithBackoff<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<RetryResult<T>> {
  const maxAttempts = options.maxAttempts || 3;
  const baseDelay = options.baseDelayMs || 1_000;
  const maxDelay = options.maxDelayMs || 30_000;
  let totalDelay = 0;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { value, attempts: attempt, totalDelayMs: totalDelay };
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error)) throw error;
      if (attempt >= maxAttempts) break;
      const delay = calculateBackoff(attempt, baseDelay, maxDelay);
      totalDelay += delay;
      options.onRetry?.(attempt, error instanceof Error ? error : new Error(String(error)), delay);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
