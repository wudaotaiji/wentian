/** 実行予算（Execution Budget）を全試行で共有し、時間・回数・使用量・費用を制限します。 */
export interface ExecutionLimits {
  maxRuntimeMs: number;
  maxAttempts: number;
  maxTokens: number;
  maxCostUsd?: number;
  maxReplans: number;
}
export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = { maxRuntimeMs: 600_000, maxAttempts: 3, maxTokens: 500_000, maxReplans: 3 };

/** 利用者指定は上限を緩めず、ホスト（Host）が許可した範囲内でのみ縮小します。 */
export function parseExecutionLimits(raw: unknown, host: ExecutionLimits = DEFAULT_EXECUTION_LIMITS): ExecutionLimits {
  if (raw === undefined) return { ...host };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('実行予算（Execution Budget）はオブジェクトで指定してください。');
  const limits = { ...host };
  for (const key of ['maxRuntimeMs', 'maxAttempts', 'maxTokens', 'maxCostUsd', 'maxReplans'] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key !== 'maxCostUsd' && !Number.isSafeInteger(value)) || (['maxRuntimeMs', 'maxAttempts', 'maxTokens'].includes(key) && value === 0)) throw new Error(`実行予算（Execution Budget）の${key}が不正です。`);
    limits[key] = host[key] === undefined ? value : Math.min(host[key]!, value);
  }
  return limits;
}

export class BudgetExceededError extends Error {
  constructor(readonly reason: string) { super(`実行予算（Execution Budget）の上限に到達しました：${reason}`); }
}

export interface TokenPrice { inputPerMillion: number; outputPerMillion: number }
export class ExecutionBudget {
  private readonly started: number;
  attempts = 0;
  replans = 0;
  tokens = 0;
  costUsd = 0;
  costKnown = true;
  constructor(readonly limits: ExecutionLimits, private readonly now: () => number = Date.now) { this.started = now(); }
  remainingMs(): number { return Math.max(0, this.limits.maxRuntimeMs - (this.now() - this.started)); }
  remainingTokens(): number { return Math.max(0, this.limits.maxTokens - this.tokens); }
  check(): void {
    if (this.remainingMs() <= 0) throw new BudgetExceededError('実行時間');
    if (this.attempts >= this.limits.maxAttempts) throw new BudgetExceededError('試行回数');
    if (this.remainingTokens() <= 0) throw new BudgetExceededError('トークン数（Tokens）');
  }
  replan(): void {
    this.check();
    if (this.replans >= this.limits.maxReplans) throw new BudgetExceededError('再計画回数（Replans）');
    this.replans++;
  }
  /** 上流の最大出力を予約し、使用量不明の失敗でも予算を無料扱いにしません。 */
  reserve(input: number, output: number, price?: TokenPrice): { settle: (usage?: { prompt_tokens?: number; completion_tokens?: number }) => void; costUsd: number } {
    this.check();
    if (![input, output].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('予約するトークン数（Tokens）が不正です。');
    if (input + output > this.remainingTokens()) throw new BudgetExceededError('トークン予約');
    if (this.limits.maxCostUsd !== undefined && !price) throw new BudgetExceededError('費用単価未登録');
    const cost = price ? (input * price.inputPerMillion + output * price.outputPerMillion) / 1_000_000 : 0;
    if (this.limits.maxCostUsd !== undefined && this.costUsd + cost > this.limits.maxCostUsd) throw new BudgetExceededError('費用（Cost）');
    this.attempts++; this.tokens += input + output; this.costUsd += cost;
    if (!price) this.costKnown = false;
    let settled = false;
    return { costUsd: cost, settle: usage => {
      if (settled) return; settled = true;
      if (!usage || ![usage.prompt_tokens, usage.completion_tokens].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return;
      const actualInput = usage.prompt_tokens!, actualOutput = usage.completion_tokens!;
      this.tokens += actualInput + actualOutput - input - output;
      if (price) this.costUsd += ((actualInput - input) * price.inputPerMillion + (actualOutput - output) * price.outputPerMillion) / 1_000_000;
    } };
  }
}
