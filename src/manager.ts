/**
 * Wentian Local AI Manager の中核モジュール。
 *
 * このファイルは HTTP サーバーに依存しない。ホスト資源の観測、モデルの検出、
 * 安全性評価、候補の順位付け、実行結果の観測を提供する。モデルのアンロード等、
 * 破壊的・状態変更を伴う操作は実行せず、明示的な計画だけを返す。
 */
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readNodeReservations } from './node-resource-reservations.js';

const execFileAsync = promisify(execFile);

export type SafetyLevel = 'safe' | 'warning' | 'blocked';
export type ProviderKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'comfyui' | 'other';
export type TaskKind = 'general' | 'coding' | 'reasoning' | 'tool' | 'vision';

export interface MemorySnapshot {
  observedAt: string;
  ram: { totalBytes: number; freeBytes: number; usedBytes: number; reservedBytes?:number };
  gpus: GpuSnapshot[];
  comfyui?: { available: boolean; estimatedVramUsedBytes?: number; error?: string };
  warnings: string[];
}

export interface GpuSnapshot {
  index: number;
  name: string;
  vendor?: 'nvidia' | 'amd' | 'intel';
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  reservedBytes?:number;
}

export interface ModelCapabilities {
  coding?: number;
  reasoning?: number;
  tool?: number;
  vision?: number;
  contextTokens?: number;
  /** 利用側が独自の評価軸を追加できる拡張領域。値は 0..1 を推奨する。 */
  [name: string]: number | undefined;
}

export interface ManagedModel {
  id: string;
  provider: ProviderKind | string;
  providerModelId: string;
  loaded: boolean;
  sizeBytes?: number;
  estimatedRuntimeBytes?: number;
  capabilities?: ModelCapabilities;
  metadata?: Record<string, unknown>;
}

export interface ProviderEndpoint {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
  enabled?: boolean;
  priority?: number;
}

export interface DiscoveryResult {
  provider: string;
  models: ManagedModel[];
  ok: boolean;
  error?: string;
}

export interface SafetyPolicy {
  /** 断片化（Fragmentation）や一時作業領域に備えるVRAM余裕率です。 */
  fragmentationReserveRatio?: number;
  /** OS と他アプリケーションのため、常に残す RAM。 */
  reserveRamBytes: number;
  /** Desktop、ComfyUI 等のため、常に残す VRAM。 */
  reserveVramBytes: number;
  /** Warning とする余裕率。1.2 は必要量の 20% 増し。 */
  warningHeadroomRatio: number;
  /** VRAM が取得できない時、RAM 評価のみで許可するか。 */
  allowUnknownVram: boolean;
}

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  reserveRamBytes: 4 * 1024 ** 3,
  reserveVramBytes: 1024 ** 3,
  warningHeadroomRatio: 1.2,
  allowUnknownVram: true,
};

export interface SafetyEvaluation {
  level: SafetyLevel;
  reasons: string[];
  requiredBytes: number;
  availableRamBytes: number;
  availableVramBytes?: number;
}

export interface CandidateRequest {
  task: TaskKind;
  minimumContextTokens?: number;
  requiresVision?: boolean;
  requiresTool?: boolean;
  preferLoaded?: boolean;
  maxOutputTokens?: number;
  promptTokens?: number;
  batchSize?: number;
  performance?: MetricsRegistry;
  difficulty?: number;
  quality?: 'economy' | 'balanced' | 'quality' | 'max';
}

export interface RankedCandidate {
  model: ManagedModel;
  safety: SafetyEvaluation;
  score: number;
  scoreReasons: string[];
}

export interface RequestMetric {
  requestId?: string;
  ramUsedBytes?: number;
  vramUsedBytes?: number;
  routingMs?: number;
  qualityAccepted?: boolean;
  verified?: boolean;
  costUsd?: number;
  provider: string;
  model: string;
  startedAt: string;
  latencyMs: number;
  ttftMs?: number;
  success: boolean;
  error?: string;
  task?: TaskKind;
  promptTokens?: number;
  outputTokens?: number;
}

/** リクエストに伴うキー・バリューキャッシュ（KV Cache）の追加量を保守的に見積もります。 */
export function estimateRequestMemoryBytes(model: ManagedModel, request: CandidateRequest): number {
  const tokens = Math.max(0, request.minimumContextTokens ?? 0, request.promptTokens ?? 0) + Math.max(0, request.maxOutputTokens ?? 0);
  const residentContext = Number(model.metadata?.residentContextTokens) || 0;
  const additionalTokens = model.loaded ? Math.max(0, tokens - residentContext) : tokens;
  // 実アーキテクチャが未登録の場合は、トークン当たり256 KiBを暫定値として使います。
  const perToken = Number(model.metadata?.kvBytesPerToken) || 256 * 1024;
  return Math.ceil(additionalTokens * Math.max(1, request.batchSize ?? 1) * Math.max(1, perToken) + (request.requiresVision ? 512 * 1024 ** 2 : 0));
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenSuccessThreshold: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

type CircuitEntry = {
  state: CircuitState;
  failures: number;
  halfOpenSuccesses: number;
  openedAt?: number;
};

/** URL の末尾を整え、OpenAI 互換 URL からプロバイダー固有 API の基点を得る。 */
function providerRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function getJson(url: string, timeoutMs: number, apiKey?: string): Promise<any> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json();
}

/**
 * OS RAM と NVIDIA GPU VRAM を観測する。nvidia-smi がない PC でも例外にせず、
 * RAM のスナップショットと警告を返す。
 */
export async function observeMemory(options: {
  nvidiaSmiPath?: string;
  rocmSmiPath?: string;
  xpuSmiPath?: string;
  comfyuiBaseUrl?: string;
  timeoutMs?: number;
  ignoreNodeReservations?:boolean;
} = {}): Promise<MemorySnapshot> {
  const total = os.totalmem();
  const free = os.freemem();
  const warnings: string[] = [];
  const gpus: GpuSnapshot[] = [];
  const timeoutMs = options.timeoutMs ?? 2000;

  try {
    const args = ['--query-gpu=index,name,memory.total,memory.free,memory.used', '--format=csv,noheader,nounits'];
    const { stdout } = await execFileAsync(options.nvidiaSmiPath ?? 'nvidia-smi', args, {
      timeout: timeoutMs,
      windowsHide: true,
    });
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      const fields = line.split(',').map((value: string) => value.trim());
      if (fields.length < 5) continue;
      const [index, name, totalMiB, freeMiB, usedMiB] = fields;
      const values = [index, totalMiB, freeMiB, usedMiB].map(Number);
      if (values.some((value) => !Number.isFinite(value))) continue;
      gpus.push({
        index: values[0], name, vendor: 'nvidia', totalBytes: values[1] * 1024 ** 2,
        freeBytes: values[2] * 1024 ** 2, usedBytes: values[3] * 1024 ** 2,
      });
    }
  } catch (error) {
    warnings.push(`NVIDIA VRAM を取得できませんでした: ${String(error)}`);
  }

  if (!gpus.length) {
    const probes = [
      { vendor: 'amd' as const, command: options.rocmSmiPath ?? 'rocm-smi', args: ['--showmeminfo', 'vram', '--json'] },
      { vendor: 'intel' as const, command: options.xpuSmiPath ?? 'xpu-smi', args: ['dump', '--device', '-1', '--metrics', 'MEMORY', '--number', '1', '--json'] },
    ];
    for (const probe of probes) {
      try {
        const { stdout } = await execFileAsync(probe.command, probe.args, { timeout: timeoutMs, windowsHide: true });
        const detected = parseVendorMemoryJson(stdout, probe.vendor);
        if (detected.length) { gpus.push(...detected); break; }
      } catch (error) {
        warnings.push(`${probe.vendor.toUpperCase()} VRAM を取得できませんでした: ${String(error)}`);
      }
    }
  }

  let comfyui: MemorySnapshot['comfyui'];
  if (options.comfyuiBaseUrl) {
    try {
      const stats = await getJson(`${providerRoot(options.comfyuiBaseUrl)}/system_stats`, timeoutMs);
      const devices = Array.isArray(stats?.devices) ? stats.devices : [];
      const used = devices.reduce((sum: number, device: any) => {
        const totalVram = Number(device?.vram_total ?? 0);
        const freeVram = Number(device?.vram_free ?? 0);
        return sum + Math.max(0, totalVram - freeVram);
      }, 0);
      comfyui = { available: true, estimatedVramUsedBytes: used || undefined };
    } catch (error) {
      comfyui = { available: false, error: String(error) };
      warnings.push('ComfyUI の使用量を取得できませんでした。');
    }
  }

  const reservations=options.ignoreNodeReservations?[]:await readNodeReservations();
  const reservedRam=reservations.reduce((n,r)=>n+r.memoryBytes,0);
  for(const gpu of gpus)gpu.reservedBytes=reservations.filter(r=>r.gpuIndex===gpu.index).reduce((n,r)=>n+r.gpuMemoryBytes,0);
  if(reservations.length)warnings.push('アプリの論理予約をAIの資源判定へ反映します。実測の使用量とは別の値です。');
  return {
    observedAt: new Date().toISOString(),
    ram: { totalBytes: total, freeBytes: free, usedBytes: total - free,...(reservedRam?{reservedBytes:reservedRam}:{}) },
    gpus, comfyui, warnings,
  };
}

/** ROCm SMI / XPU SMIの版差があるJSONをキー名で安全に正規化する。 */
export function parseVendorMemoryJson(text: string, vendor: 'amd' | 'intel'): GpuSnapshot[] {
  let root: unknown;try { root = JSON.parse(text); } catch { return []; }
  const objects: Record<string, unknown>[]=[];const visit=(value:unknown)=>{if(Array.isArray(value))for(const item of value)visit(item);else if(value&&typeof value==='object'){objects.push(value as Record<string,unknown>);for(const item of Object.values(value))visit(item)}};visit(root);
  const read=(object:Record<string,unknown>,pattern:RegExp)=>{const entry=Object.entries(object).find(([key,value])=>pattern.test(key)&&Number.isFinite(Number(typeof value==='object'&&(value as any)?.value!==undefined?(value as any).value:value)));return entry?Number(typeof entry[1]==='object'?(entry[1] as any).value:entry[1]):undefined};
  const output:GpuSnapshot[]=[];for(const object of objects){let total=read(object,/vram.*total|memory.*total|total.*memory/i),used=read(object,/vram.*used|memory.*used|used.*memory/i),free=read(object,/vram.*free|memory.*free|free.*memory/i);if(total===undefined||used===undefined)continue;const units=total<1024**3?1024**2:1;total*=units;used*=units;free=free===undefined?Math.max(0,total-used):free*units;if(total>0&&!output.some(g=>g.totalBytes===total&&g.usedBytes===used))output.push({index:output.length,name:`${vendor.toUpperCase()} GPU ${output.length}`,vendor,totalBytes:total,usedBytes:used,freeBytes:free})}return output;
}

/**
 * モデル名やファイルサイズから実行時メモリを保守的に推定する。
 * 実サイズがある場合は KV Cache 等のため 20% と 512 MiB を加算する。
 */
export function estimateModelRuntimeBytes(model: Pick<ManagedModel, 'providerModelId' | 'sizeBytes'>): number {
  if (model.sizeBytes && model.sizeBytes > 0) return Math.ceil(model.sizeBytes * 1.2 + 512 * 1024 ** 2);
  const name = model.providerModelId.toLowerCase();
  const parameterMatch = name.match(/(?:^|[-_:])(\d+(?:\.\d+)?)b(?:[-_:]|$)/);
  const parameters = parameterMatch ? Number(parameterMatch[1]) * 1e9 : 7e9;
  let bytesPerParameter = 0.75; // 量子化方式不明時は約 6-bit 相当として安全側に寄せる。
  if (/q2|2bit/.test(name)) bytesPerParameter = 0.4;
  else if (/q3|3bit/.test(name)) bytesPerParameter = 0.55;
  else if (/q4|4bit/.test(name)) bytesPerParameter = 0.65;
  else if (/q5|5bit/.test(name)) bytesPerParameter = 0.8;
  else if (/q8|8bit/.test(name)) bytesPerParameter = 1.1;
  else if (/fp16|f16/.test(name)) bytesPerParameter = 2.1;
  return Math.ceil(parameters * bytesPerParameter + 1024 ** 3);
}

/** プロバイダーが公開する範囲でモデル一覧とロード済み状態を検出する。 */
export async function discoverProviderModels(endpoint: ProviderEndpoint, timeoutMs = 2500): Promise<DiscoveryResult> {
  if (endpoint.enabled === false) return { provider: endpoint.id, models: [], ok: true };
  try {
    const root = providerRoot(endpoint.baseUrl);
    if (endpoint.kind === 'ollama') {
      const [tags, running] = await Promise.all([
        getJson(`${root}/api/tags`, timeoutMs),
        getJson(`${root}/api/ps`, timeoutMs).catch(() => ({ models: [] })),
      ]);
      const loaded = new Map<string, any>((running?.models ?? []).map((item: any) => [String(item.name ?? item.model), item]));
      const models = await Promise.all((tags?.models ?? []).map(async (item: any): Promise<ManagedModel> => {
        const name = String(item.name ?? item.model);
        const details = await fetch(`${root}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json', ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(timeoutMs) }).then(response => response.ok ? response.json() : {}).catch(() => ({})) as any;
        const capabilities = details.capabilities ?? item.capabilities ?? [];
        const info = details.model_info ?? {};
        const architecture = info['general.architecture'];
        const layers = Number(info[`${architecture}.block_count`]);
        const kvHeads = Number(info[`${architecture}.attention.head_count_kv`]);
        const heads = Number(info[`${architecture}.attention.head_count`]);
        const embedding = Number(info[`${architecture}.embedding_length`]);
        // GQAのキー・バリューキャッシュ（KV Cache）は層数×KVヘッド×ヘッド次元×K/V×FP16で見積もります。
        const kvBytesPerToken = layers > 0 && kvHeads > 0 && heads > 0 && embedding > 0 ? layers * kvHeads * embedding / heads * 4 : undefined;
        const resident = loaded.get(name);
        return {
        id: `${endpoint.id}/${item.name ?? item.model}`,
        provider: endpoint.id,
        providerModelId: String(item.name ?? item.model),
        loaded: loaded.has(name),
        sizeBytes: Number(item.size) || undefined,
        capabilities: { tool: capabilities.includes('tools') ? 1 : 0, vision: capabilities.includes('vision') ? 1 : 0,
          contextTokens: Number(info[`${architecture}.context_length`] ?? item.details?.context_length) || undefined },
        metadata: { digest: item.digest, details: item.details, kvBytesPerToken, residentContextTokens: resident?.context_length,
          residentVramBytes: resident?.size_vram, modelFamily: item.details?.family, ...(item.remote_model ? { resourceScope: 'remote' } : {}) },
      }; }));
      return { provider: endpoint.id, models, ok: true };
    }

    if (endpoint.kind === 'lmstudio') {
      const native = await getJson(`${root}/api/v1/models`, timeoutMs, endpoint.apiKey).catch(() => undefined);
      if (Array.isArray(native?.models)) return { provider: endpoint.id, ok: true, models: native.models.filter((item: any) => item.type === 'llm').map((item: any): ManagedModel => ({
        id: `${endpoint.id}/${item.key}`, provider: endpoint.id, providerModelId: item.key, sizeBytes: item.size_bytes,
        loaded: Boolean(item.loaded_instances?.length), capabilities: { contextTokens: item.max_context_length,
          vision: item.capabilities?.vision ? 1 : 0, tool: item.capabilities?.trained_for_tool_use ? 1 : 0 },
        metadata: { modelFamily: item.architecture, residentContextTokens: item.loaded_instances?.[0]?.config?.context_length,
          quantization: item.quantization?.name, instanceIds: item.loaded_instances?.map((instance: any) => instance.id) },
      })) };
    }
    // LM Studio と llama.cpp は共通の /v1/models を利用する。loaded は API が
    // 明示する場合だけ採用し、不明を loaded=true と誤認しない。
    const listing = await getJson(`${root}/v1/models`, timeoutMs, endpoint.apiKey);
    const models = (listing?.data ?? []).map((item: any): ManagedModel => ({
      id: `${endpoint.id}/${String(item.id).replace(/^\/+/, '')}`,
      provider: endpoint.id,
      providerModelId: String(item.id),
      loaded: item.loaded === true || item.state === 'loaded',
      sizeBytes: Number(item.size ?? item.size_bytes) || undefined,
      metadata: { object: item.object, ownedBy: item.owned_by, state: item.state },
    }));
    return { provider: endpoint.id, models, ok: true };
  } catch (error) {
    return { provider: endpoint.id, models: [], ok: false, error: String(error) };
  }
}

export async function discoverAllModels(endpoints: ProviderEndpoint[], timeoutMs = 2500): Promise<DiscoveryResult[]> {
  return Promise.all(endpoints.filter((item) => item.kind !== 'comfyui').map((item) => discoverProviderModels(item, timeoutMs)));
}

/** モデルを新規ロードした場合の RAM/VRAM 安全性を評価する。 */
export function evaluateModelSafety(
  model: ManagedModel,
  memory: MemorySnapshot,
  policy: SafetyPolicy = DEFAULT_SAFETY_POLICY,
  request?: CandidateRequest,
): SafetyEvaluation {
  if (model.metadata?.resourceScope === 'remote') {
    return { level: 'safe', reasons: ['外部サービスのためローカルRAM/VRAM評価の対象外です。'], requiredBytes: 0, availableRamBytes: Math.max(0, memory.ram.freeBytes - (memory.ram.reservedBytes || 0) - policy.reserveRamBytes) };
  }
  const requiredBytes = (model.loaded ? 0 : (model.estimatedRuntimeBytes ?? estimateModelRuntimeBytes(model))) + (request ? estimateRequestMemoryBytes(model, request) : 0);
  const availableRamBytes = Math.max(0, memory.ram.freeBytes - (memory.ram.reservedBytes || 0) - policy.reserveRamBytes);
  const availableVramBytes = memory.gpus.length
    ? Math.max(...memory.gpus.map((gpu) => Math.max(0, gpu.freeBytes - (gpu.reservedBytes || 0) - policy.reserveVramBytes) * (1 - Math.max(0, Math.min(1, policy.fragmentationReserveRatio ?? 0.1)))))
    : undefined;
  const reasons: string[] = [];

  if (model.loaded && requiredBytes === 0) return { level: 'safe', reasons: ['既にロード済みです。'], requiredBytes, availableRamBytes, availableVramBytes };
  const fitsRam = requiredBytes <= availableRamBytes;
  const fitsVram = availableVramBytes === undefined ? policy.allowUnknownVram && fitsRam : requiredBytes <= availableVramBytes;
  if (!fitsRam && !fitsVram) {
    reasons.push('安全余裕を差し引いた RAM と VRAM のどちらにも収まりません。');
    return { level: 'blocked', reasons, requiredBytes, availableRamBytes, availableVramBytes };
  }
  if (availableVramBytes === undefined) reasons.push('VRAM が不明なため RAM のみで評価しました。');
  const bestAvailable = Math.max(availableRamBytes, availableVramBytes ?? 0);
  if (requiredBytes * policy.warningHeadroomRatio > bestAvailable || availableVramBytes === undefined) {
    reasons.push('ロード後の空きメモリが安全余裕に近づく可能性があります。');
    return { level: 'warning', reasons, requiredBytes, availableRamBytes, availableVramBytes };
  }
  reasons.push('安全余裕を含めて利用可能メモリ内に収まります。');
  return { level: 'safe', reasons, requiredBytes, availableRamBytes, availableVramBytes };
}

// 既存利用者との互換性を保ち、選択ロジックはルーター（Router）へ分離します。
export { rankModelCandidates } from './router.js';

/**
 * 状態変更を自動実行せず、管理 API や UI が人間へ提示するアンロード候補を返す。
 */
export function planUnload(models: ManagedModel[], keepModelIds: string[] = []): {
  requiresExplicitApproval: true;
  candidates: ManagedModel[];
  reclaimedBytesEstimate: number;
} {
  const keep = new Set(keepModelIds);
  const candidates = models.filter((model) => model.loaded && !keep.has(model.id));
  return {
    requiresExplicitApproval: true,
    candidates,
    reclaimedBytesEstimate: candidates.reduce((sum, model) => sum + (model.estimatedRuntimeBytes ?? estimateModelRuntimeBytes(model)), 0),
  };
}

/** プロバイダー単位の簡潔なサーキットブレーカー。状態はプロセス内だけに保持する。 */
export class CircuitBreaker {
  private readonly entries = new Map<string, CircuitEntry>();
  constructor(private readonly options: CircuitBreakerOptions = {
    failureThreshold: 3, cooldownMs: 30_000, halfOpenSuccessThreshold: 1,
  }) {}

  canRequest(key: string, now = Date.now()): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.state === 'closed') return true;
    if (entry.state === 'open' && now - (entry.openedAt ?? now) >= this.options.cooldownMs) {
      entry.state = 'half-open';
      entry.halfOpenSuccesses = 0;
      return true;
    }
    return entry.state === 'half-open';
  }

  recordSuccess(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.state === 'half-open') {
      entry.halfOpenSuccesses += 1;
      if (entry.halfOpenSuccesses < this.options.halfOpenSuccessThreshold) return;
    }
    this.entries.set(key, { state: 'closed', failures: 0, halfOpenSuccesses: 0 });
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.entries.get(key) ?? { state: 'closed' as const, failures: 0, halfOpenSuccesses: 0 };
    entry.failures += 1;
    if (entry.state === 'half-open' || entry.failures >= this.options.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = now;
    }
    this.entries.set(key, entry);
  }

  status(key: string): Readonly<CircuitEntry> {
    return { ...(this.entries.get(key) ?? { state: 'closed', failures: 0, halfOpenSuccesses: 0 }) };
  }
}

/** レイテンシー（Latency）と初回トークン時間（TTFT）を有限件数で記録する。 */
export class MetricsRegistry {
  private readonly metrics: RequestMetric[] = [];
  constructor(private readonly capacity = 1000, private readonly onRecord?: (metric: RequestMetric) => void) {}

  record(metric: RequestMetric): void {
    this.metrics.push({ ...metric });
    if (this.metrics.length > this.capacity) this.metrics.splice(0, this.metrics.length - this.capacity);
    this.onRecord?.({ ...metric });
  }

  /** 再起動時の復元（Restore）は再追記せず、有限件数の観測履歴だけを取り込みます。 */
  restore(items: RequestMetric[]): void {
    this.metrics.splice(0, this.metrics.length, ...items.slice(-this.capacity).map(item => ({ ...item })));
  }

  /** 受入評価（Acceptance Evaluation）はホスト側の認証済み操作でのみ更新します。 */
  evaluate(requestId: string, input: { accepted?: boolean; verified?: boolean }): RequestMetric | undefined {
    const item = [...this.metrics].reverse().find(row => row.requestId === requestId && row.success);
    if (!item) return undefined;
    if (input.accepted !== undefined) item.qualityAccepted = input.accepted;
    if (input.verified !== undefined) item.verified = input.verified;
    return { ...item };
  }

  list(filter: { provider?: string; model?: string } = {}): RequestMetric[] {
    return this.metrics.filter((item) =>
      (!filter.provider || item.provider === filter.provider) && (!filter.model || item.model === filter.model),
    ).map((item) => ({ ...item }));
  }

  summary(filter: { provider?: string; model?: string } = {}): {
    count: number; successRate: number; averageLatencyMs?: number; averageTtftMs?: number;
  } {
    const items = this.list(filter);
    const ttft = items.filter((item) => item.ttftMs !== undefined);
    return {
      count: items.length,
      successRate: items.length ? items.filter((item) => item.success).length / items.length : 0,
      averageLatencyMs: items.length ? items.reduce((sum, item) => sum + item.latencyMs, 0) / items.length : undefined,
      averageTtftMs: ttft.length ? ttft.reduce((sum, item) => sum + item.ttftMs!, 0) / ttft.length : undefined,
    };
  }
}

/** リクエスト開始・TTFT・終了の計時を呼び出し側へ簡潔に公開する。 */
export function startRequestMeasurement(provider: string, model: string, registry: MetricsRegistry, task?: TaskKind, context: Partial<RequestMetric> = {}) {
  const startedAt = new Date();
  const started = performance.now();
  let firstTokenAt: number | undefined;
  let completed: RequestMetric | undefined;
  return {
    markFirstToken(): void { if (firstTokenAt === undefined) firstTokenAt = performance.now(); },
    finish(success: boolean, error?: unknown, usage?: { prompt_tokens?: number; completion_tokens?: number }): RequestMetric {
      // 終了・切断・エラー通知が重なっても、1試行を二重記録しません。
      if (completed) return completed;
      const finished = performance.now();
      const metric: RequestMetric = {
        ...context,
        provider, model, startedAt: startedAt.toISOString(), latencyMs: finished - started,
        ttftMs: firstTokenAt === undefined ? undefined : firstTokenAt - started,
        success, error: error === undefined ? undefined : String(error), task,
        promptTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens,
      };
      registry.record(metric);
      completed = metric;
      return metric;
    },
  };
}
