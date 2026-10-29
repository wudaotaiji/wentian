/** 状態変更を既定無効・明示承認・監査付きで実行するアダプター群。 */
import { randomBytes } from 'node:crypto';
import type { JsonlEventStore } from './storage.js';

export type LifecycleAction = 'load' | 'unload';
export interface LifecycleTarget { provider: string; model: string; action: LifecycleAction; contextTokens?: number; keepAliveSeconds?: number }
export interface LifecycleContext { authenticated: boolean; approvalToken?: string; dryRun?: boolean }
export interface LifecycleResult { executed: boolean; verified: boolean; message: string }

export interface LifecycleAdapter {
  readonly provider: string;
  plan(target: LifecycleTarget): Promise<Record<string, unknown>>;
  execute(target: LifecycleTarget, timeoutMs: number): Promise<void>;
  verify(target: LifecycleTarget, timeoutMs: number): Promise<boolean>;
}

type Approval = { target: string; expiresAt: number };

export class LifecycleController {
  private approvals = new Map<string, Approval>();
  constructor(private options: {
    enabled?: boolean;
    timeoutMs?: number;
    approvalTtlMs?: number;
    adapters: LifecycleAdapter[];
    audit?: JsonlEventStore;
  }) {}

  issueApproval(target: LifecycleTarget, authenticated: boolean): string {
    if (!authenticated) throw new Error('承認トークンの発行には認証が必要です。');
    const token = randomBytes(32).toString('base64url');
    this.approvals.set(token, { target: JSON.stringify(target), expiresAt: Date.now() + (this.options.approvalTtlMs ?? 60_000) });
    return token;
  }

  async run(target: LifecycleTarget, context: LifecycleContext): Promise<LifecycleResult> {
    const adapter = this.options.adapters.find((item) => item.provider === target.provider);
    if (!adapter) throw new Error(`未対応プロバイダーです: ${target.provider}`);
    const plan = await adapter.plan(target);
    if (context.dryRun !== false) return { executed: false, verified: false, message: `dry-run: ${JSON.stringify(plan)}` };
    if (!this.options.enabled) throw new Error('状態変更機能は無効です。');
    if (!context.authenticated) throw new Error('状態変更には認証が必要です。');
    const approval = context.approvalToken ? this.approvals.get(context.approvalToken) : undefined;
    if (!approval || approval.expiresAt < Date.now() || approval.target !== JSON.stringify(target)) throw new Error('有効な明示承認トークンが必要です。');
    this.approvals.delete(context.approvalToken!); // 1回限り（One-time）の承認。
    await this.audit(target, 'requested', true);
    try {
      const timeoutMs = this.options.timeoutMs ?? 10_000;
      await adapter.execute(target, timeoutMs);
      const verified = await adapter.verify(target, timeoutMs);
      await this.audit(target, verified ? 'verified' : 'verification_failed', verified);
      return { executed: true, verified, message: verified ? '操作後の状態を確認しました。' : '操作は完了しましたが状態確認に失敗しました。' };
    } catch (error) {
      await this.audit(target, 'failed', false);
      throw error;
    }
  }

  private async audit(target: LifecycleTarget, state: string, success: boolean): Promise<void> {
    await this.options.audit?.append({ kind: 'audit', provider: target.provider, model: target.model, action: target.action, state, success });
  }
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

/** Ollama は keep_alive を使ってロード／アンロードする。 */
export class OllamaLifecycleAdapter implements LifecycleAdapter {
  readonly provider: string;
  constructor(provider: string, private baseUrl: string) { this.provider = provider; }
  async plan(target: LifecycleTarget) { return { endpoint: '/api/generate', model: target.model, action: target.action }; }
  async execute(target: LifecycleTarget, timeoutMs: number) {
    if (target.contextTokens !== undefined && (!Number.isSafeInteger(target.contextTokens) || target.contextTokens < 1)) throw new Error('文脈長（Context Length）が不正です。');
    if (target.keepAliveSeconds !== undefined && (!Number.isSafeInteger(target.keepAliveSeconds) || target.keepAliveSeconds < 1)) throw new Error('駐留時間（Keep Alive）が不正です。');
    await request(`${this.baseUrl.replace(/\/$/, '')}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: target.model, prompt: '', stream: false,
      keep_alive: target.action === 'unload' ? 0 : target.keepAliveSeconds !== undefined ? `${target.keepAliveSeconds}s` : '5m',
      ...(target.contextTokens ? { options: { num_ctx: target.contextTokens } } : {}) }) }, timeoutMs);
  }
  async verify(target: LifecycleTarget, timeoutMs: number) {
    const body = await request(`${this.baseUrl.replace(/\/$/, '')}/api/ps`, {}, timeoutMs);
    const loaded = (body?.models ?? []).some((item: any) => (item.name ?? item.model) === target.model);
    return target.action === 'load' ? loaded : !loaded;
  }
}

/** LM Studio / llama.cpp は環境ごとの差を注入可能な汎用 HTTP アダプター。 */
export class HttpLifecycleAdapter implements LifecycleAdapter {
  readonly provider: string;
  constructor(provider: string, private callbacks: {
    plan: (target: LifecycleTarget) => Record<string, unknown>;
    execute: (target: LifecycleTarget, timeoutMs: number) => Promise<void>;
    verify: (target: LifecycleTarget, timeoutMs: number) => Promise<boolean>;
  }) { this.provider = provider; }
  async plan(target: LifecycleTarget) { return this.callbacks.plan(target); }
  execute(target: LifecycleTarget, timeoutMs: number) { return this.callbacks.execute(target, timeoutMs); }
  verify(target: LifecycleTarget, timeoutMs: number) { return this.callbacks.verify(target, timeoutMs); }
}

/** LM StudioのネイティブAPI（Native API）で、自分がロードしたインスタンスだけを退避します。 */
export class LmStudioLifecycleAdapter implements LifecycleAdapter {
  private readonly instances = new Map<string, string>();
  constructor(readonly provider: string, private readonly baseUrl: string, private readonly apiKey?: string) {}
  private call(path: string, init: RequestInit, timeoutMs: number) {
    return request(`${this.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/api/v1/models${path}`, { ...init,
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) } }, timeoutMs);
  }
  async plan(target: LifecycleTarget) { return { model: target.model, action: target.action, contextTokens: target.contextTokens }; }
  async execute(target: LifecycleTarget, timeoutMs: number): Promise<void> {
    if (target.action === 'load') {
      const result = await this.call('/load', { method: 'POST', body: JSON.stringify({ model: target.model, context_length: target.contextTokens, echo_load_config: true }) }, timeoutMs);
      if (typeof result.instance_id !== 'string') throw new Error('ロード済みインスタンス（Loaded Instance）のIDを取得できません。');
      this.instances.set(target.model, result.instance_id);
    } else {
      const instance = this.instances.get(target.model);
      if (!instance) throw new Error('他アプリがロードしたインスタンス（Instance）は退避しません。');
      await this.call('/unload', { method: 'POST', body: JSON.stringify({ instance_id: instance }) }, timeoutMs);
    }
  }
  async verify(target: LifecycleTarget, timeoutMs: number): Promise<boolean> {
    const result = await this.call('', {}, timeoutMs);
    const instance = this.instances.get(target.model);
    const present = result.models?.some((model: any) => model.key === target.model && model.loaded_instances?.some((item: any) => item.id === instance));
    if (target.action === 'unload' && !present) this.instances.delete(target.model);
    return target.action === 'load' ? Boolean(present) : !present;
  }
}

export interface ComfyJob { id: string; status: 'queued' | 'running' | 'completed' | 'failed'; raw?: unknown }
export class ComfyUiJobAdapter {
  constructor(private baseUrl: string) {}
  async submit(workflow: Record<string, unknown>, timeoutMs = 10_000): Promise<ComfyJob> {
    const body = await request(`${this.baseUrl.replace(/\/$/, '')}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow }) }, timeoutMs);
    return { id: String(body.prompt_id), status: 'queued' };
  }
  async status(id: string, timeoutMs = 10_000): Promise<ComfyJob> {
    const body = await request(`${this.baseUrl.replace(/\/$/, '')}/history/${encodeURIComponent(id)}`, {}, timeoutMs);
    const item = body?.[id];
    if (!item) return { id, status: 'queued', raw: body };
    const status = item.status?.completed ? 'completed' : item.status?.status_str === 'error' ? 'failed' : 'running';
    return { id, status, raw: item };
  }
}
