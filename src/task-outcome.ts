import type { OrchestrationResult } from './external-orchestrator.js';
import type { ExecutionMode } from './execution-policy.js';

export interface TaskExecution { source: 'gateway' | 'external'; agent?: string; model?: string; configuredModel?: string; requestedModel?: string; provider?: string; elapsedMs: number }

export interface TaskOutcome {
  version: '1.0'; status: 'success' | 'needs_review' | 'failed' | 'timeout' | 'cancelled' | 'proposal';
  exitCode: number; executionMode?: ExecutionMode; taskId?: string; manifestPath?: string; reason?: string;
  failure?: { gatewayStatus: number; upstreamStatus?: number; provider?: string; retryAfter?: string };
  execution?: TaskExecution;
}
/** Gatewayの構造化された診断を、文字列の解析に依存せず台帳へ引き継ぎます。 */
export class GatewayRequestError extends Error {
  constructor(message: string, readonly failure: NonNullable<TaskOutcome['failure']>) { super(message); this.name = 'GatewayRequestError'; }
}
/** 表示・JSON・終了コード・台帳が、同じ最終判定を使用します。 */
export function taskOutcome(status: TaskOutcome['status'], detail: Partial<TaskOutcome> = {}): TaskOutcome {
  return { version: '1.0', ...detail, status, exitCode: ({ success: 0, proposal: 0, needs_review: 2, failed: 1, timeout: 124, cancelled: 130 })[status] };
}
export function orchestrationOutcome(result: Pick<OrchestrationResult, 'status' | 'reports' | 'taskId' | 'note'> & Partial<OrchestrationResult>): TaskOutcome {
  if (result.interruption) return taskOutcome(result.interruption, { taskId: result.taskId, manifestPath: result.manifestPath, reason: result.note || '実行を中断しました。' });
  const failed = ['failed', 'blocked', 'fallback'].includes(result.status) || ['failed', 'blocked'].includes(result.acceptance?.status || '');
  const timeout = failed && (result.reports.some(report => !report.success && ['timeout', 'stalled'].includes(report.failureKind || '')) || result.acceptance?.commands.some(command => /時間超過/.test(command.reason || '')));
  return taskOutcome(timeout ? 'timeout' : failed ? 'failed' : result.status === 'completed' ? 'success' : result.status === 'planned' ? 'proposal' : 'needs_review', { taskId: result.taskId, manifestPath: result.manifestPath, reason: result.note });
}
export function errorOutcome(error: unknown): TaskOutcome {
  const reason = error instanceof Error ? error.message : String(error);
  const timeout = (error as { name?: string })?.name === 'TimeoutError' || /timeout(?:\s|:|しました)|時間超過|timed out/i.test(reason);
  return taskOutcome(timeout ? 'timeout' : (error as { name?: string })?.name === 'AbortError' || /Escキー|中断|aborted/i.test(reason) ? 'cancelled' : 'failed', { reason, ...(error instanceof GatewayRequestError ? { failure: error.failure } : {}) });
}
