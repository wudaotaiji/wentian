import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseProviderFile, type ProviderConfig } from './config.js';
import { renameWithRetry } from './atomic-file.js';

export interface ProviderManagementState {
  providers: ProviderConfig[];
  deletedIds: string[];
}

export function providerManagementFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.WENTIAN_PROVIDER_MANAGEMENT_FILE || path.join(env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'provider-management.json');
}

export function loadProviderManagement(file = providerManagementFile()): ProviderManagementState {
  if (!existsSync(file)) return { providers: [], deletedIds: [] };
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { providers?: unknown; deletedIds?: unknown };
  const providers = parseProviderFile(Array.isArray(raw.providers) ? raw.providers : []);
  const deletedIds = Array.isArray(raw.deletedIds) ? raw.deletedIds.filter((id): id is string => typeof id === 'string' && /^[a-z][a-z0-9_-]{1,31}$/.test(id)) : [];
  return { providers, deletedIds: [...new Set(deletedIds)] };
}

/** Provider設定と削除記録を一つのJSONへ原子的に保存します。 */
export async function saveProviderManagement(state: ProviderManagementState, file = providerManagementFile()): Promise<void> {
  const normalized = {
    providers: parseProviderFile(state.providers).map(provider => {
      const { apiKey, apiKeyEnv, ...safe } = provider;
      return { ...safe, ...(apiKeyEnv ? { apiKeyEnv } : apiKey ? { apiKey } : {}) };
    }),
    deletedIds: [...new Set(state.deletedIds)],
  };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(normalized, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, file);
}

/** UI/API入力を検証し、秘密値は既存値を維持してから設定として確定します。 */
export function validateManagedProvider(input: unknown, existing?: ProviderConfig): ProviderConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Provider設定が必要です。');
  const value = input as Record<string, unknown>;
  if (!['llm', 'media'].includes(String(value.kind))) throw new Error('Provider種別はllmまたはmediaを指定してください。');
  if (!['local', 'remote'].includes(String(value.scope))) throw new Error('接続範囲はlocalまたはremoteを指定してください。');
  if (value.autoRoute === true && value.kind !== 'llm') throw new Error('自動ルーティングはLLM Providerだけに設定できます。');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('有効状態は真偽値で指定してください。');
  if (value.autoRoute !== undefined && typeof value.autoRoute !== 'boolean') throw new Error('自動ルーティング状態は真偽値で指定してください。');
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string'))) throw new Error('タグは文字列の配列で指定してください。');
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length > 2000) throw new Error('接続先URLが不正です。');
  if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 8192)) throw new Error('APIキーが不正です。');
  if (value.apiKeyEnv !== undefined && (typeof value.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.apiKeyEnv))) throw new Error('APIキー環境変数名が不正です。');
  const candidate = { ...value } as Record<string, unknown>;
  if (!String(candidate.apiKey || '').trim() && !candidate.apiKeyEnv && existing?.apiKey) {
    const builtinEnv: Record<string, string> = { llamacpp: 'LLAMACPP_API_KEY', ollama: 'OLLAMA_API_KEY', lmstudio: 'LMSTUDIO_API_KEY', remote: 'WENTIAN_REMOTE_API_KEY' };
    const envName = existing.apiKeyEnv || builtinEnv[existing.id];
    if (envName && process.env[envName] !== undefined) candidate.apiKeyEnv = envName;
    else candidate.apiKey = existing.apiKey;
  }
  const provider = parseProviderFile([candidate])[0]!;
  if (!provider.name.trim() || provider.name.length > 120) throw new Error('Provider名は1〜120文字で指定してください。');
  if (provider.tags.some(tag => tag.length > 64) || provider.tags.length > 32) throw new Error('タグは32件以内、各64文字以内で指定してください。');
  for (const [key, score] of Object.entries(provider.capabilities || {})) {
    if (!Number.isFinite(score) || score < 0 || (key !== 'contextTokens' && score > 1)) throw new Error(`能力 ${key} の値が範囲外です。`);
  }
  return provider;
}
