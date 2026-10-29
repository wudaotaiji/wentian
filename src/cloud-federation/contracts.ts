/** 分散Cloudの契約です。金額は試験用のゼロ価格のみを扱い、本番WTCを発行しません。 */
export const PROTOCOL = 'wentian-cloud/1' as const;
export const PEER_PATH = '/api/cloud-federation/peer';
export const MAX_TEXT_BYTES = 64 * 1024;
export class FederationError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}
export interface PublicIdentity { nodeId: string; publicKey: string }
export interface Peer extends PublicIdentity { endpoint: string; enabled: boolean }
export interface Policy { enabled: boolean; maxConcurrent: number; minFreeMemoryBytes: number; minFreeDiskBytes: number }
export interface Task { service: string; input: unknown; objective: string }
export interface Decision { status: 'allow' | 'deny' | 'unknown'; reason: string }
export interface ReviewInput { task: Task; requester: string; policy: Policy; adapter: { id: string; description: string } }
export type Reviewer = (input: ReviewInput) => Promise<unknown>;
export interface ExecutionAdapter {
  id: string; description: string;
  validate(input: unknown): void;
  execute(input: unknown): Promise<unknown>;
}
export interface Order {
  id: string; requester: string; requestId: string; digest: string; task: Task;
  state: 'reserved' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown';
  expiresAt: number; createdAt: number; updatedAt: number; decision: Decision;
  result?: unknown; error?: string; price: { amount: 0; unit: 'trial-credit' };
}
export interface Envelope {
  protocol: typeof PROTOCOL; sender: string; recipient: string; path: string;
  groupId: string;
  timestamp: number; nonce: string; payload: unknown; signature: string;
}
export interface Outbound {
  id: string; peerId: string; requestId: string; task: Task;
  sessionId?: string;
  state: 'pending' | 'reserved' | 'submitted' | 'unknown' | 'observed';
  quoteId?: string; receipt?: Envelope; updatedAt: number;
}
export interface FederationState {
  policy: Policy; peers: Peer[]; orders: Order[]; outbound: Outbound[];
  nonces: Array<{ key: string; expiresAt: number }>;
  sessions?: A2ASession[];
}
export interface A2ASession {
  id: string; objective: string; state: 'running' | 'paused' | 'completed'; reason: string;
  steps: Array<{ action: unknown; state: 'planned' | 'observed' | 'unknown'; result?: unknown }>;
  updatedAt: number;
  peerId?: string; groupId?: string;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FederationError('オブジェクト形式の契約が必要です。');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new FederationError('文字列の契約が不正です。');
  return value;
}
export function validateTask(value: unknown): Task {
  const row = record(value);
  if (Object.keys(row).some(key => !['service', 'input', 'objective'].includes(key))) throw new FederationError('未対応のタスク項目です。');
  return { service: text(row.service, 100), input: row.input, objective: text(row.objective, 2000) };
}
export function validateDecision(value: unknown): Decision {
  try {
    const row = record(value);
    if (!['allow', 'deny', 'unknown'].includes(String(row.status))) throw new Error();
    return { status: row.status as Decision['status'], reason: text(row.reason, 2000) };
  } catch { return { status: 'unknown', reason: 'AIの構造化判断を検証できませんでした。' }; }
}
