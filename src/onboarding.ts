import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseProviderFile, type ProviderConfig } from './config.js';
import { renameWithRetry } from './atomic-file.js';

/** 秘密を含む初回接続設定は、Git管理対象のproviders.jsonから分離します。 */
export function onboardingProviderFile(): string {
  return path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'onboarding-provider.json');
}

/** 初回接続先だけを追加・更新し、既存Providerの設定を維持します。 */
export async function saveOnboardingProvider(input: { baseUrl: string; apiKey?: string; scope: 'local' | 'remote' }, file = onboardingProviderFile()): Promise<ProviderConfig> {
  if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2000 || (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8192))) throw new Error('接続先またはキーが不正です。');
  const row = { id: 'onboarding', name: 'My model connection', kind: 'llm', priority: 5, enabled: true, autoRoute: true, tags: ['setup'], ...input };
  const parsed = parseProviderFile([row])[0];
  let rows: unknown[] = [];
  try {
    const existing = JSON.parse(await readFile(file, 'utf8'));
    rows = Array.isArray(existing) ? existing : existing.providers;
    parseProviderFile(rows);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const updated = [...rows.filter(item => (item as { id?: string }).id !== 'onboarding'), row];
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ providers: updated }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, file);
  return parsed;
}
