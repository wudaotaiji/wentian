/** 上流LLMの利用制限（HTTP 429・402）を、Wentian側の不具合と分けて扱うための小さな台帳です。 */

/** Retry-After が無い場合の既定待機（30秒）。lmstudioは公開レートを公表していないため、実測より厳しめに抑えます。 */
export const UPSTREAM_LIMIT_DEFAULT_MS = 30_000;
/** 1件の利用制限で保持する待機の上限（5分）。無限待機で常駐を止まらせないための下限ある打ち切りです。 */
export const UPSTREAM_LIMIT_MAX_MS = 300_000;
/** 短すぎる待機で即再投入しないための下限（1秒）。 */
export const UPSTREAM_LIMIT_MIN_MS = 1_000;
/** 利用制限として扱うHTTP状態。上流の容量不足と請求枠超過だけを指します。 */
export const UPSTREAM_LIMIT_STATUSES = [429, 402];

/** HTTP状態が上流の利用制限かどうかを判定します。5xx（上流障害）とは区別します。 */
export function isUpstreamLimit(status: number | undefined): boolean {
  return UPSTREAM_LIMIT_STATUSES.includes(Number(status));
}

/**
 * Retry-After（分 / Retry-After）を待機ミリ秒へ直します。
 * delta-seconds（秒数）とHTTP-date（日時）の両方を受け取り、不正値は既定値へ縮退します。
 */
export function parseRetryAfterMs(value: string | number | undefined, now = Date.now(), fallbackMs = UPSTREAM_LIMIT_DEFAULT_MS, maxMs = UPSTREAM_LIMIT_MAX_MS): number {
  const clamp = (ms: number) => Math.min(maxMs, Math.max(UPSTREAM_LIMIT_MIN_MS, Math.round(ms)));
  if (value === undefined || value === '') return fallbackMs;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? clamp(value * 1000) : fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(value);
  // 日時として読めない値を0秒と誤認せず、既定待機へ戻します。
  if (!Number.isFinite(date)) return fallbackMs;
  // 過去日時（クロックずれ・古いヘッダー）は「今すぐ再試行」とは読まず、待機下限での高速再投入を止めるため既定待機へ戻します。
  if (date <= now) return fallbackMs;
  return clamp(date - now);
}

/** プロバイダー単位で「いつから再試行できるか」だけをプロセス内へ保持します。秘密情報・応答本文は保存しません。 */
export class UpstreamLimitWindow {
  private readonly retryAvailableAt = new Map<string, number>();
  constructor(private readonly defaultMs = UPSTREAM_LIMIT_DEFAULT_MS, private readonly maxMs = UPSTREAM_LIMIT_MAX_MS) {}

  /** 利用制限を受け入れ、Retry-After から再試行可能時刻を記録します。既存より後ろへ伸びる場合だけ更新します。 */
  recordLimit(providerId: string, retryAfter: string | undefined, now = Date.now()): { waitMs: number; retryAvailableAt: string } {
    const waitMs = parseRetryAfterMs(retryAfter, now, this.defaultMs, this.maxMs);
    const target = Math.max(now + waitMs, this.retryAvailableAt.get(providerId) || 0);
    this.retryAvailableAt.set(providerId, target);
    return { waitMs: Math.max(0, target - now), retryAvailableAt: new Date(target).toISOString() };
  }

  /** 制限中であれば、再試行可能時刻までの残りミリ秒を返します。 */
  remainingMs(providerId: string, now = Date.now()): number | undefined {
    const until = this.retryAvailableAt.get(providerId);
    if (until === undefined) return undefined;
    if (until <= now) { this.retryAvailableAt.delete(providerId); return undefined; }
    return until - now;
  }

  /** 制限中かどうか。候補選択で即再投入を防ぐために使います。 */
  limited(providerId: string, now = Date.now()): boolean {
    return this.remainingMs(providerId, now) !== undefined;
  }

  /** 再試行可能時刻のISO文字列。なければundefined（=制限記録なし）。 */
  retryAvailableAtIso(providerId: string, now = Date.now()): string | undefined {
    const remaining = this.remainingMs(providerId, now);
    return remaining === undefined ? undefined : new Date(now + remaining).toISOString();
  }

  /** 応答に詰められる再試行待機情報。待機中と再試行可能を台帳で区別できるようにします。 */
  state(now = Date.now()): { status: 'available' | 'waiting'; retryAvailableAt?: string; waitMs?: number } {
    const waiting = [...this.retryAvailableAt].map(([id, until]) => ({ id, until })).filter(item => item.until > now).sort((a, b) => b.until - a.until)[0];
    return waiting ? { status: 'waiting', retryAvailableAt: new Date(waiting.until).toISOString(), waitMs: waiting.until - now } : { status: 'available' };
  }

  /** 成功応答をもらった時点で、そのプロバイダーの待機を解除します。 */
  clear(providerId: string): void { this.retryAvailableAt.delete(providerId); }

  /** /health などの状態確認向け。全プロバイダーの残り待機をISO時刻で出します。 */
  snapshot(now = Date.now()): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [id, until] of this.retryAvailableAt) if (until > now) result[id] = new Date(until).toISOString();
    return result;
  }
}

/** CLI側が守る、上流利用制限への待機予算です。回数と総時間の上限を明文化して無限再試行を止めます。 */
export interface LimitWaitBudget {
  /** 1依頼で許す待機回数。 */
  maxWaits: number;
  /** 1依頼で許す合計待機時間。 */
  maxTotalMs: number;
  /** Retry-After が無い時の初回待機。回数に応じて伸ばします。 */
  baseMs: number;
  /** 1回の待機の上限。Retry-After が大きくても依頼全体を止めません。 */
  maxWaitMs: number;
}
export const DEFAULT_LIMIT_WAIT_BUDGET: LimitWaitBudget = { maxWaits: 3, maxTotalMs: 180_000, baseMs: 15_000, maxWaitMs: 60_000 };
export interface LimitWaitPlan { waitMs: number; allowed: boolean; reason: 'wait' | 'max_waits' | 'max_total' }

/** 次回待機が許可できるかを予算から判定します。許可できない場合は打ち切り理由を返します。 */
export function planLimitWait(waits: number, totalMs: number, retryAfter: string | undefined, budget: LimitWaitBudget = DEFAULT_LIMIT_WAIT_BUDGET, now = Date.now()): LimitWaitPlan {
  if (waits >= budget.maxWaits) return { waitMs: 0, allowed: false, reason: 'max_waits' };
  const fromHeader = retryAfter === undefined || retryAfter === '' ? undefined : parseRetryAfterMs(retryAfter, now, budget.baseMs, budget.maxWaitMs);
  // Retry-After 指定は尊重し、無い場合だけ指数的に伸ばします。
  const waitMs = fromHeader ?? Math.min(budget.maxWaitMs, budget.baseMs * (2 ** waits));
  if (totalMs + waitMs > budget.maxTotalMs) return { waitMs: 0, allowed: false, reason: 'max_total' };
  return { waitMs, allowed: true, reason: 'wait' };
}
