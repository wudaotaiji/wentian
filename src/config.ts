import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type ProviderScope = 'local' | 'remote';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: 'llm' | 'media';
  scope: ProviderScope;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  priority: number;
  enabled: boolean;
  autoRoute: boolean;
  tags: string[];
  capabilities?: Record<string, number>;
  /** モデル能力レジストリ（Model Capability Registry）。モデルIDごとに共通能力を上書きします。 */
  modelProfiles?: Record<string, { capabilities?: Record<string, number>; kvBytesPerToken?: number }>;
  /** Vision入力を許可するモデルID。"*"は当該プロバイダーの全モデルを示します。 */
  visionModels?: string[];
  autoModels?: string[];
  maxRequestsPerMinute?: number;
  /** 費用単価（Token Price）。未登録を無料と推測しません。 */
  tokenPrice?: { inputPerMillion: number; outputPerMillion: number };
}

type ProviderFile = { providers?: unknown[] } | unknown[];

function validateUrl(value: unknown, id: string): string {
  if (typeof value !== 'string') throw new Error(`Provider ${id}: baseUrl は文字列で指定してください。`);
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Provider ${id}: http/https URLだけを使用できます。`);
  if (parsed.username || parsed.password) throw new Error(`Provider ${id}: URL内の認証情報は使用できません。`);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blockedHosts = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.azure.internal']);
  if (blockedHosts.has(hostname)) throw new Error(`Provider ${id}: メタデータサービスは接続先に指定できません。`);
  return value.replace(/\/+$/, '');
}

export function parseProviderFile(input: ProviderFile, env: NodeJS.ProcessEnv = process.env): ProviderConfig[] {
  const rows = Array.isArray(input) ? input : input.providers;
  if (!Array.isArray(rows)) throw new Error('providers設定には providers 配列が必要です。');
  const ids = new Set<string>();
  return rows.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Provider #${index + 1}: オブジェクトが必要です。`);
    const value = raw as Record<string, unknown>;
    const id = String(value.id ?? '');
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(id)) throw new Error(`Provider #${index + 1}: id が不正です。`);
    if (ids.has(id)) throw new Error(`Provider ${id}: id が重複しています。`);
    ids.add(id);
    const kind = value.kind === 'media' ? 'media' : 'llm';
    const scope = value.scope === 'local' ? 'local' : 'remote';
    const apiKeyEnv = typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : undefined;
    const priority = Number(value.priority ?? 100);
    if (!Number.isFinite(priority)) throw new Error(`Provider ${id}: priority が不正です。`);
    const capabilities = value.capabilities && typeof value.capabilities === 'object'
      ? Object.fromEntries(Object.entries(value.capabilities as Record<string, unknown>).filter(([, score]) => typeof score === 'number')) as Record<string, number>
      : undefined;
    const modelProfiles: NonNullable<ProviderConfig['modelProfiles']> = {};
    let tokenPrice: ProviderConfig['tokenPrice'];
    if (value.tokenPrice !== undefined) {
      const price = value.tokenPrice as Record<string, unknown>;
      if (!price || typeof price !== 'object' || ![price.inputPerMillion, price.outputPerMillion].every(cost => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) throw new Error(`Provider ${id}: 費用単価（Token Price）が不正です。`);
      tokenPrice = { inputPerMillion: price.inputPerMillion as number, outputPerMillion: price.outputPerMillion as number };
    }
    if (value.modelProfiles !== undefined) {
      if (!value.modelProfiles || typeof value.modelProfiles !== 'object' || Array.isArray(value.modelProfiles)) throw new Error(`Provider ${id}: modelProfilesはオブジェクトで指定してください。`);
      for (const [model, rawProfile] of Object.entries(value.modelProfiles)) {
        if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) throw new Error(`Provider ${id}: ${model}の能力定義が不正です。`);
        const profile = rawProfile as Record<string, unknown>;
        const caps: Record<string, number> = {};
        if (profile.capabilities !== undefined) {
          if (!profile.capabilities || typeof profile.capabilities !== 'object' || Array.isArray(profile.capabilities)) throw new Error(`Provider ${id}: ${model}のcapabilitiesが不正です。`);
          for (const [key, score] of Object.entries(profile.capabilities)) {
            if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || (key !== 'contextTokens' && score > 1)) throw new Error(`Provider ${id}: ${model}/${key}の数値が範囲外です。`);
            caps[key] = score;
          }
        }
        if (profile.kvBytesPerToken !== undefined && (typeof profile.kvBytesPerToken !== 'number' || !Number.isFinite(profile.kvBytesPerToken) || profile.kvBytesPerToken <= 0)) throw new Error(`Provider ${id}: ${model}のKVキャッシュ（KV Cache）単価が不正です。`);
        modelProfiles[model] = { capabilities: caps, kvBytesPerToken: profile.kvBytesPerToken as number | undefined };
      }
    }
    return {
      id, name: String(value.name ?? id), kind, scope,
      baseUrl: validateUrl(value.baseUrl, id), apiKeyEnv,
      apiKey: apiKeyEnv ? env[apiKeyEnv] : typeof value.apiKey === 'string' ? value.apiKey : undefined,
      priority, enabled: value.enabled !== false, autoRoute: kind === 'llm' && value.autoRoute === true,
      tags: Array.isArray(value.tags) ? value.tags.map(String) : [scope], capabilities,
      ...(value.modelProfiles !== undefined ? { modelProfiles } : {}),
      ...(tokenPrice ? { tokenPrice } : {}),
      visionModels: Array.isArray(value.visionModels) ? value.visionModels.map(String) : undefined,
      autoModels: Array.isArray(value.autoModels) ? value.autoModels.map(String) : undefined,
      maxRequestsPerMinute: Number.isFinite(Number(value.maxRequestsPerMinute)) && Number(value.maxRequestsPerMinute) > 0 ? Number(value.maxRequestsPerMinute) : undefined,
    };
  });
}

export function loadProviderFile(filePath = process.env.WENTIAN_PROVIDERS_FILE || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), 'providers.json')): ProviderConfig[] {
  if (!existsSync(filePath)) return [];
  return parseProviderFile(JSON.parse(readFileSync(filePath, 'utf8')) as ProviderFile);
}

/** 起動時の環境変数を検証し、入力ミスを既定値への暗黙縮退ではなく明示エラーにします。 */
export function validateRuntimeEnv(env: NodeJS.ProcessEnv = process.env): void {
  const positiveIntegers = ['PORT', 'WENTIAN_REQUEST_TIMEOUT_MS', 'WENTIAN_VISION_REQUEST_TIMEOUT_MS', 'WENTIAN_HEALTH_TIMEOUT_MS', 'WENTIAN_AGENT_READY_REFRESH_MS', 'WENTIAN_TRAINING_MAX_RECORDS', 'WENTIAN_TRAINING_MAX_BYTES', 'WENTIAN_EVENT_MAX_RECORDS', 'WENTIAN_EVENT_MAX_BYTES', 'WENTIAN_EVENT_MAX_AGE_MS'];
  for (const name of positiveIntegers) {
    if (env[name] !== undefined && (!/^\d+$/.test(env[name]!) || Number(env[name]) <= 0)) {
      throw new Error(`${name} は正の整数で指定してください。`);
    }
  }
  if (env.PORT !== undefined && Number(env.PORT) > 65535) throw new Error('PORT は65535以下で指定してください。');
  for (const name of ['WENTIAN_ENABLE_STATE_CHANGES', 'WENTIAN_RESIDENCY_ENABLED', 'WENTIAN_ENABLE_COMFYUI_JOBS', 'WENTIAN_ENABLE_AGENT_INSTALL', 'WENTIAN_ENABLE_EXTERNAL_ORCHESTRATION']) {
    if (env[name] !== undefined && !['true', 'false'].includes(env[name]!)) throw new Error(`${name} は true または false で指定してください。`);
  }
  for (const name of ['LLAMACPP_BASE_URL', 'OLLAMA_BASE_URL', 'LMSTUDIO_BASE_URL', 'COMFYUI_BASE_URL', 'WENTIAN_REMOTE_BASE_URL']) {
    if (env[name] !== undefined) validateUrl(env[name], name);
  }
  if (env.WENTIAN_HOST !== undefined && !env.WENTIAN_HOST.trim()) throw new Error('WENTIAN_HOST は空にできません。');
  if (env.WENTIAN_CORS_ORIGINS !== undefined) {
    for (const origin of env.WENTIAN_CORS_ORIGINS.split(',').map(value => value.trim())) {
      if (!origin) throw new Error('WENTIAN_CORS_ORIGINS に空のOrigin（オリジン / Origin）は指定できません。');
      validateUrl(origin, 'WENTIAN_CORS_ORIGINS');
    }
  }
}
