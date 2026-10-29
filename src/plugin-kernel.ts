/** Wentianの交換可能な能力分類です。Kernel自身は具体能力を一切実装しません。 */
export type WentianPluginKind = 'model' | 'tool' | 'skill' | 'session' | 'sandbox' | 'storage' | 'loop' | 'scheduler' | 'ui' | 'planner' | 'selector' | 'runner' | 'repair' | 'verifier' | 'memory';

export type WentianServiceKey<T = unknown> = string & { readonly __serviceType?: T };
export const serviceKey = <T>(name: string): WentianServiceKey<T> => name as WentianServiceKey<T>;

export interface WentianPluginEvent {
  sequence: number;
  occurredAt: string;
  type: string;
  source: string;
  detail?: unknown;
}

export interface WentianPluginContext {
  readonly pluginId: string;
  provide<T>(key: WentianServiceKey<T>, value: T): () => void;
  resolve<T>(key: WentianServiceKey<T>): T;
  optional<T>(key: WentianServiceKey<T>): T | undefined;
  on<T = unknown>(type: string, listener: (detail: T, event: WentianPluginEvent) => void | Promise<void>): () => void;
  emit(type: string, detail?: unknown): Promise<void>;
}

export interface WentianPluginDefinition<TConfig = unknown> {
  id: string;
  kind: WentianPluginKind;
  version: string;
  requires?: string[];
  provides?: string[];
  setup(context: WentianPluginContext, config: TConfig): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface WentianPluginSpec {
  id: string;
  enabled?: boolean;
  config?: unknown;
}

interface LoadedPlugin {
  definition: WentianPluginDefinition;
  disposers: Array<() => void | Promise<void>>;
  loadedAt: string;
}

/**
 * 具体機能を持たず、Pluginの依存解決・Service Seam・Event・Lifecycleだけを管理するMeta Kernelです。
 * ServiceはStackとして保持するため、Overlay Pluginを外すと直前Providerへ自動的に戻ります。
 */
export class WentianPluginKernel {
  private readonly definitions = new Map<string, WentianPluginDefinition>();
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly services = new Map<string, Array<{ owner: string; value: unknown }>>();
  private readonly listeners = new Map<string, Array<{ owner: string; listener: (detail: unknown, event: WentianPluginEvent) => void | Promise<void> }>>();
  private readonly events: WentianPluginEvent[] = [];
  private sequence = 0;

  register(definition: WentianPluginDefinition): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(definition.id)) throw new Error(`Plugin IDが不正です: ${definition.id}`);
    if (this.definitions.has(definition.id)) throw new Error(`Pluginが重複しています: ${definition.id}`);
    this.definitions.set(definition.id, definition);
  }

  has(id: string): boolean { return this.loaded.has(id); }

  resolve<T>(key: WentianServiceKey<T>): T {
    const value = this.optional(key);
    if (value === undefined) throw new Error(`Service Providerがありません: ${key}`);
    return value;
  }

  optional<T>(key: WentianServiceKey<T>): T | undefined {
    return this.services.get(key)?.at(-1)?.value as T | undefined;
  }

  /** Profileを依存順にロードし、途中失敗時は今回分だけ逆順でRollbackします。 */
  async load(specs: WentianPluginSpec[]): Promise<void> {
    const enabled = specs.filter(spec => spec.enabled !== false);
    const requested = new Map(enabled.map(spec => [spec.id, spec]));
    const visiting = new Set<string>();
    const ordered: WentianPluginSpec[] = [];
    const visit = (id: string) => {
      if (this.loaded.has(id) || ordered.some(spec => spec.id === id)) return;
      if (visiting.has(id)) throw new Error(`Plugin依存関係が循環しています: ${[...visiting, id].join(' -> ')}`);
      const definition = this.definitions.get(id);
      if (!definition) throw new Error(`未登録Pluginです: ${id}`);
      visiting.add(id);
      for (const dependency of definition.requires || []) {
        if (!requested.has(dependency) && !this.loaded.has(dependency)) throw new Error(`${id}が必要とするPluginがProfileにありません: ${dependency}`);
        visit(dependency);
      }
      visiting.delete(id);
      ordered.push(requested.get(id) || { id });
    };
    for (const spec of enabled) visit(spec.id);
    const newlyLoaded: string[] = [];
    try {
      for (const spec of ordered) {
        if (this.loaded.has(spec.id)) continue;
        await this.loadOne(this.definitions.get(spec.id)!, spec.config);
        newlyLoaded.push(spec.id);
      }
    } catch (error) {
      for (const id of newlyLoaded.reverse()) await this.unload(id, true);
      throw error;
    }
  }

  /** 利用中Pluginを保護しつつ、登録した副作用をすべて逆順で解除します。 */
  async unload(id: string, force = false): Promise<void> {
    const current = this.loaded.get(id);
    if (!current) return;
    const dependents = [...this.loaded.values()].filter(plugin => plugin.definition.requires?.includes(id)).map(plugin => plugin.definition.id);
    if (dependents.length && !force) throw new Error(`${id}はロード済みPluginから利用中です: ${dependents.join(', ')}`);
    for (const dependent of dependents) await this.unload(dependent, true);
    for (const dispose of [...current.disposers].reverse()) await dispose();
    this.loaded.delete(id);
    await this.emitFrom('kernel', 'plugin.unloaded', { id });
  }

  async dispose(): Promise<void> {
    for (const id of [...this.loaded.keys()].reverse()) await this.unload(id, true);
  }

  snapshot(): { plugins: Array<{ id: string; kind: WentianPluginKind; version: string; loadedAt: string }>; services: Array<{ key: string; provider: string }>; events: WentianPluginEvent[] } {
    return {
      plugins: [...this.loaded.values()].map(item => ({ id: item.definition.id, kind: item.definition.kind, version: item.definition.version, loadedAt: item.loadedAt })),
      services: [...this.services.entries()].flatMap(([key, stack]) => stack.at(-1) ? [{ key, provider: stack.at(-1)!.owner }] : []),
      // 管理APIへ秘密値を露出しないよう、Eventの認証系KeyはSnapshot生成時に伏字化します。
      events: this.events.map(event => ({ ...event, detail: sanitizeEventDetail(event.detail) })),
    };
  }

  private async loadOne(definition: WentianPluginDefinition, config: unknown): Promise<void> {
    const disposers: Array<() => void | Promise<void>> = [];
    const context: WentianPluginContext = {
      pluginId: definition.id,
      provide: <T>(key: WentianServiceKey<T>, value: T) => {
        const stack = this.services.get(key) || [];
        const entry = { owner: definition.id, value };
        stack.push(entry); this.services.set(key, stack);
        const dispose = () => { const current = this.services.get(key) || []; const next = current.filter(item => item !== entry); if (next.length) this.services.set(key, next); else this.services.delete(key); };
        disposers.push(dispose); return dispose;
      },
      resolve: key => this.resolve(key), optional: key => this.optional(key),
      on: (type, listener) => {
        const rows = this.listeners.get(type) || [];
        const entry = { owner: definition.id, listener: listener as (detail: unknown, event: WentianPluginEvent) => void | Promise<void> };
        rows.push(entry); this.listeners.set(type, rows);
        const dispose = () => { const next = (this.listeners.get(type) || []).filter(item => item !== entry); if (next.length) this.listeners.set(type, next); else this.listeners.delete(type); };
        disposers.push(dispose); return dispose;
      },
      emit: (type, detail) => this.emitFrom(definition.id, type, detail),
    };
    try {
      const pluginDispose = await definition.setup(context, config);
      if (pluginDispose) disposers.push(pluginDispose);
      this.loaded.set(definition.id, { definition, disposers, loadedAt: new Date().toISOString() });
      await this.emitFrom('kernel', 'plugin.loaded', { id: definition.id, kind: definition.kind, version: definition.version });
    } catch (error) {
      for (const dispose of disposers.reverse()) await dispose();
      throw error;
    }
  }

  private async emitFrom(source: string, type: string, detail?: unknown): Promise<void> {
    const event = { sequence: ++this.sequence, occurredAt: new Date().toISOString(), type, source, detail };
    this.events.push(event);
    if (this.events.length > 10_000) this.events.splice(0, this.events.length - 10_000);
    for (const entry of [...(this.listeners.get(type) || []), ...(this.listeners.get('*') || [])]) await entry.listener(detail, event);
  }
}

function sanitizeEventDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeEventDetail);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /(?:api.?key|authorization|token|secret|password|credential)/i.test(key) ? '[REDACTED]' : sanitizeEventDetail(item)]));
}
