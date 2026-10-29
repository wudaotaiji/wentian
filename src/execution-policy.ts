import path from 'node:path';
import type { AgentPlan } from './agent-planner.js';
import type { AcceptanceCheck } from './delivery-verification.js';
import type { ExecutionLimits } from './execution-budget.js';

export type ExecutionMode = 'auto' | 'direct' | 'delegate' | 'propose';
export interface ExecutionOptions { mode?: ExecutionMode; allowedWritePaths?: string[]; acceptanceChecks?: AcceptanceCheck[]; timeoutMs?: number; waitForUpstreamLimit?: boolean; budget?: Partial<ExecutionLimits> }

/** 利用者の明示した実行方式を、AIの分類結果や制作語の検出より優先します。 */
export function resolveExecutionMode(input: string, mode?: ExecutionMode): ExecutionMode {
  if (mode && !['auto', 'direct', 'delegate', 'propose'].includes(mode)) throw new Error('実行モードはauto/direct/delegate/proposeから指定してください。');
  if (mode && mode !== 'auto') return mode;
  return 'auto';
}

/** 許可一覧は具体的なパスに限定します。曖昧な範囲をプロジェクト全体へ拡大しません。 */
export function inferAllowedWritePaths(input: string): string[] | undefined {
  const scope = input.match(/(?:書[き]?込[み]?許可範囲|書き込み範囲|編集対象|変更対象|allowed write paths)\s*[:：]\s*([^\r\n。]+)/i)?.[1];
  if (!scope) return undefined;
  const report = input.match(/報告先\s*[:：]\s*([^\r\n。]+)/)?.[1]?.trim();
  return scope.split(/[、,，]/).map(item => {
    let token = item.trim().replace(/(?:のみ|だけ)$/, '').trim().replace(/^[`"「『]|[`"」』]$/g, '');
    if (token === '報告先ファイル' && report) token = report;
    if (!token || /\s|[：:](?![\\/])|[、。]|関連|専用|呼出し|その他|など/.test(token) || /[*?]/.test(token)) throw new Error('書き込み範囲が曖昧です。--allow-writeで具体的なファイル一覧を指定してください。');
    return token;
  });
}

export function applyExecutionPolicy(plan: AgentPlan, input: string, options: ExecutionOptions = {}): AgentPlan {
  // CLIの明示オプションを最優先し、未指定時の自然言語の実行方式はLLMの計画を採用します。
  const mode = options.mode && options.mode !== 'auto' ? resolveExecutionMode(input, options.mode) : plan.executionMode || 'auto';
  plan.executionMode = mode;
  try {
    const inferred = options.allowedWritePaths ?? inferAllowedWritePaths(input);
    // 依頼文に作業先の絶対Pathが明示され、AIがその場所への制作と判断した場合は、
    // 同じ明示Pathを作業場所全体の許可範囲として扱います。別のPathへは広げません。
    plan.allowedWritePaths = inferred ?? (plan.operation === 'write' && plan.targetPath ? ['.'] : []);
  }
  catch { plan.allowedWritePaths = ['__WENTIAN_AMBIGUOUS_SCOPE__']; }
  if (mode === 'direct' || mode === 'propose') plan.delegation.enabled = false;
  if (mode === 'delegate') { plan.delegation.enabled = true; plan.delegation.objective ||= input; }
  if (mode === 'propose') {
    plan.requiredCapabilities = plan.requiredCapabilities.filter(value => !['file_write', 'terminal'].includes(value));
    plan.tools = plan.tools.filter(value => !['write_file', 'run_command'].includes(value));
    plan.allowedWritePaths = [];
  }
  return plan;
}

/** ファイル名・ディレクトリの指定を、実作業場所からの相対パスへ正規化します。 */
export function normalizeWritePaths(workspace: string, paths: string[]): string[] {
  return [...new Set(paths.map(value => {
    if (value === '__WENTIAN_AMBIGUOUS_SCOPE__') throw new Error('書き込み範囲が曖昧です。--allow-writeで具体的なファイル一覧を指定してください。');
    if (!value.trim() || value.includes('\0') || /[*?]/.test(value)) throw new Error('書き込み許可パスが不正です。');
    const directory = /[\\/]$/.test(value);
    const relative = path.relative(path.resolve(workspace), path.resolve(workspace, value));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('書き込み許可パスは作業場所内に限定してください。');
    return relative ? relative.replaceAll('\\', '/') + (directory ? '/' : '') : '.';
  }))];
}

export function assertWriteAllowed(workspace: string, target: string, allowed: string[]): void {
  const relative = path.relative(path.resolve(workspace), path.resolve(target)).replaceAll('\\', '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || relative.split('/').some(part => part.toLowerCase() === '.git')) throw new Error('作業場所外・Git管理領域への書き込みを拒否しました。');
  const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
  const match = normalizeWritePaths(workspace, allowed).some(value => {
    const candidate = process.platform === 'win32' ? value.toLowerCase() : value;
    return candidate === '.' || key === candidate || (candidate.endsWith('/') && key.startsWith(candidate));
  });
  if (!match) throw new Error(`書き込み許可範囲外のため実行前に拒否しました: ${relative}`);
}
