import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { managedConnection, type AgentConnection } from './agent-connection-policy.js';

export type WorkCapability = 'reading' | 'coding' | 'testing' | 'verification';
export interface AgentWorkEvidence {
  revision: 1; identity: string; checkedAt: string; expiresAt: string; retryAt: string;
  status: 'passed' | 'failed'; capabilities: Partial<Record<WorkCapability, boolean>>;
  evidenceDirectory: string; reason: string;
  /** 同一設定で続いた失敗回数。成功時に0へ戻します。 */
  failures?: number;
  /** 連続失敗が上限に達し、自動再試行を停止して人へ引き渡した状態です。 */
  attentionRequired?: boolean;
  /** 上流障害とWentian側の未完了を分ける失敗要因です。 */
  failureKind?: WorkFailureKind;
  /** 人が同じ作業検証を手動再実行できるPowerShellコマンドです。 */
  manualCheckCommand?: string;
  /** 失敗した起動の完全な実行ファイル・引数・作業場所。秘密値はマスクします。 */
  manualCheckExecution?: { executable: string; args: string[]; cwd: string };
}
/** 保守専用の内部トークンです。HTTP・依頼文から能力検証の制限を解除できません。 */
export const WORK_VERIFICATION_PROBE = Symbol('Wentian内部作業能力検証');
/** 失敗時の再試行待ちの初期値（15分）。上流利用制限でも短い間隔で実作業を再投入しないための下限です。 */
export const WORK_RETRY_BASE_MS = 900_000;
/** 失敗を繰り返した場合の再試行待ちの上限（6時間）。 */
export const WORK_RETRY_MAX_MS = 21_600_000;
/** 同じ実装でこれだけ連続失敗したら、自動再試行をやめて人へ引き渡します。 */
export const WORK_ATTENTION_THRESHOLD = 3;
/** 利用者対応待ちへ切り替えた後の再確認間隔（24時間）。 */
export const WORK_ATTENTION_RETRY_MS = 86_400_000;
/** 能力検証の失敗要因。上流障害とWentian側の未完了を台帳で分けます。 */
export type WorkFailureKind = 'upstream_limit' | 'upstream_error' | 'timeout' | 'cancelled' | 'work_incomplete' | 'unsafe_process' | 'unknown';
export function workCachePath(): string {
  return process.env.WENTIAN_AGENT_WORK_CACHE || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian/agent-work-capabilities.json');
}
export function readWorkEvidence(): Record<string, AgentWorkEvidence> {
  try { return JSON.parse(readFileSync(workCachePath(), 'utf8')).agents || {}; } catch { return {}; }
}
/** モデル・設定・CLI版が変われば、旧能力検証を引き継ぎません。 */
export function workIdentity(connection: AgentConnection, cliVersion?: string): string {
  return createHash('sha256').update(JSON.stringify({ probeRevision:3,model: connection.model, mode: connection.mode,provider:connection.provider,baseUrl:connection.baseUrl, fingerprint: connection.fingerprint, policyHash: connection.policyHash, cliVersion: cliVersion || connection.cliVersion })).digest('hex');
}
export function workAllowsExecution(agent: { id: string; version?: string; connection?: AgentConnection; workEvidence?: AgentWorkEvidence }, capability: WorkCapability, now = Date.now()): boolean {
  const connection = agent.connection || managedConnection(agent.id);
  const evidence = readWorkEvidence()[agent.id] || agent.workEvidence;
  return Boolean(connection && evidence?.revision === 1 && evidence.identity === workIdentity(connection, agent.version)
    && evidence.capabilities[capability] === true && Date.parse(evidence.expiresAt) > now);
}
/** 連続失敗回数から次の再試行時刻を計算します。失敗が続くほど間隔を伸ばし、上限で打ち切ります。 */
export function workFailureRetryAt(failures: number, now = Date.now()): number {
  if (failures >= WORK_ATTENTION_THRESHOLD) return now + WORK_ATTENTION_RETRY_MS;
  return now + Math.min(WORK_RETRY_MAX_MS, WORK_RETRY_BASE_MS * (2 ** Math.max(0, failures - 1)));
}
/** 失敗要因を分類します。上流の利用制限・上流障害と、Wentian側の実作業未完了を混同しません。 */
export function classifyWorkFailure(error: unknown): WorkFailureKind {
  const failure = (error as { failure?: { upstreamStatus?: number; gatewayStatus?: number } })?.failure;
  const status = failure?.upstreamStatus;
  if (status === 429 || status === 402) return 'upstream_limit';
  const name = (error as { name?: string })?.name || '';
  const reason = error instanceof Error ? error.message : String(error ?? '');
  if (name === 'TimeoutError' || /時間超過|timed?\s?out|timeout/i.test(reason)) return 'timeout';
  if (name === 'AbortError' || /中断|aborted/i.test(reason)) return 'cancelled';
  if ((error as { termination?: { verifiedStopped?: boolean } })?.termination?.verifiedStopped === false) return 'unsafe_process';
  if (status && status >= 500) return 'upstream_error';
  if (/\b(?:429|402)\b|rate.?limit|quota|利用制限|無料枠/i.test(reason)) return 'upstream_limit';
  if (/HTTP\s*5\d\d|ECONNREFUSED|ENOTFOUND|fetch failed|すべての候補プロバイダー/i.test(reason)) return 'upstream_error';
  // 上のいずれにも当たらない不一致は、上流のせいではなく実作業が条件を満たさなかった扱いにします。
  return 'work_incomplete';
}
/** 作業者が実作業能力の有無と理由を一目で確認できる状態名称を返します。 */
export function workEvidenceState(evidence: AgentWorkEvidence | undefined, now = Date.now()): 'unverified' | 'passed' | 'retry_pending' | 'attention_required' | 'expired' {
  if (!evidence || evidence.revision !== 1) return 'unverified';
  if (evidence.status === 'passed') return Date.parse(evidence.expiresAt) > now ? 'passed' : 'expired';
  if (evidence.attentionRequired) return 'attention_required';
  return Date.parse(evidence.retryAt) > now ? 'retry_pending' : 'unverified';
}
