/** モデル駐留管理（Model Residency Manager）。稼働中のモデルと外部ロード済みモデルを保護します。 */
import { evaluateModelSafety, type CandidateRequest, type ManagedModel, type MemorySnapshot } from './manager.js';
import type { LifecycleAdapter } from './lifecycle.js';

export interface ResidencySnapshot { models: ManagedModel[]; memory: MemorySnapshot }
export class ModelResidencyManager {
  private readonly active = new Map<string, number>();
  private readonly owned = new Set<string>();
  private readonly lastUsed = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    enabled: boolean;
    adapters: LifecycleAdapter[];
    snapshot: () => Promise<ResidencySnapshot>;
    timeoutMs?: number;
    keepAliveSeconds?: number;
    audit?: (input: { model: string; action: string; verified: boolean }) => Promise<void>;
  }) {}
  get enabled(): boolean { return this.options.enabled; }
  status() { return { enabled: this.enabled, managedModels: [...this.owned], active: Object.fromEntries(this.active), lastUsed: Object.fromEntries(this.lastUsed) }; }
  /** LRU（Least Recently Used）候補は、この管理者がロードした非稼働モデルだけです。 */
  evictionCandidates(models: ManagedModel[], keep: string): ManagedModel[] {
    return models.filter(model => model.loaded && model.id !== keep && this.owned.has(model.id) && !this.active.get(model.id))
      .sort((a, b) => (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0));
  }
  async acquire(id: string, request: CandidateRequest, signal?: AbortSignal, remainingMs?: () => number): Promise<() => void> {
    if (!this.enabled) return () => undefined;
    let release = () => undefined as void;
    const operation = this.queue.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      let state = await this.options.snapshot();
      let model = state.models.find(item => item.id === id);
      if (!model) throw new Error('駐留対象モデル（Resident Model）が見つかりません。');
      if (model.metadata?.resourceScope === 'remote') return;
      const adapter = this.options.adapters.find(item => item.provider === model!.provider);
      if (!adapter) throw new Error('モデル駐留（Model Residency）の実行先が未対応です。');
      let safety = evaluateModelSafety(model, state.memory, undefined, request);
      for (const candidate of this.evictionCandidates(state.models, id)) {
        if (safety.level !== 'blocked') break;
        signal?.throwIfAborted();
        const eviction = this.options.adapters.find(item => item.provider === candidate.provider);
        if (!eviction) continue;
        await this.change(eviction, candidate, 'unload', undefined, remainingMs);
        this.owned.delete(candidate.id);
        // 推定解放量だけでロードを許可せず、実メモリを再観測します。
        state = await this.options.snapshot(); model = state.models.find(item => item.id === id) ?? model;
        safety = evaluateModelSafety(model, state.memory, undefined, request);
      }
      if (safety.level === 'blocked') throw new Error(`駐留メモリ（Residency Memory）が不足しています：${safety.reasons.join(' ')}`);
      signal?.throwIfAborted();
      if (!model.loaded) { await this.change(adapter, model, 'load', request, remainingMs); this.owned.add(id); }
      signal?.throwIfAborted();
      this.active.set(id, (this.active.get(id) ?? 0) + 1); this.lastUsed.set(id, Date.now());
      let released = false;
      release = () => { if (released) return; released = true; const count = (this.active.get(id) ?? 1) - 1;
        if (count > 0) this.active.set(id, count); else this.active.delete(id); this.lastUsed.set(id, Date.now()); };
    });
    this.queue = operation;
    await operation;
    return release;
  }
  /** 予熱（Preload）は同じ資源評価・直列化を通し、推論中モデルを退避しません。 */
  async preload(id: string, request: CandidateRequest, signal?: AbortSignal): Promise<void> { const release = await this.acquire(id, request, signal); release(); }
  /** 期限切れ（TTL）の管理対象だけを退避し、予熱済みモデルの永続占有を防ぎます。 */
  async sweep(now = Date.now()): Promise<void> {
    if(!this.enabled)return;
    const operation=this.queue.catch(()=>undefined).then(async()=>{const state=await this.options.snapshot();for(const model of this.evictionCandidates(state.models,'')){
      if(now-(this.lastUsed.get(model.id)??now)<(this.options.keepAliveSeconds??300)*1000)continue;
      const adapter=this.options.adapters.find(item=>item.provider===model.provider);if(adapter){await this.change(adapter,model,'unload');this.owned.delete(model.id);}
    }});this.queue=operation;await operation;
  }
  private async change(adapter: LifecycleAdapter, model: ManagedModel, action: 'load' | 'unload', request?: CandidateRequest, remainingMs?: () => number): Promise<void> {
    const target = { provider: String(model.provider), model: model.providerModelId, action,
      contextTokens: request ? Math.max(2048, Math.max(request.promptTokens ?? 0, request.minimumContextTokens ?? 0) + (request.maxOutputTokens ?? 0)) : undefined,
      keepAliveSeconds: this.options.keepAliveSeconds ?? 300 };
    // キュー待機・退避・ロード・確認も依頼全体の実時間予算から差し引きます。
    const timeout = (maximum: number) => {
      const available = remainingMs ? Math.min(maximum, remainingMs()) : maximum;
      if (available <= 0) throw new Error('駐留操作（Residency Operation）の実行時間予算が尽きました。');
      return available;
    };
    await adapter.execute(target, timeout(this.options.timeoutMs ?? 120_000));
    const verified = await adapter.verify(target, timeout(5000));
    await this.options.audit?.({ model: model.id, action, verified });
    if (!verified) throw new Error('モデル駐留操作（Residency Operation）後の状態確認に失敗しました。');
  }
}
