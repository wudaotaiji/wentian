import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameWithRetry } from './atomic-file.js';
import { connectionStorePath } from './agent-connection-policy.js';

export interface AgentMaintenanceSettings {
  enabled: boolean;
  intervalMs: number;
  retryIntervalMs: number;
  autoInstall: boolean;
  verifyWork: boolean;
}

/** 実行時設定は秘密を含まない専用ファイルへ保存し、Git管理の設定と分離します。 */
export function maintenanceSettingsPath(): string {
  return process.env.WENTIAN_AGENT_MAINTENANCE_SETTINGS || path.join(path.dirname(connectionStorePath()), 'agent-maintenance-settings.json');
}

/** 真偽値と時間の安全制約だけを検証し、利用者の自然言語を分類しません。 */
export function validateMaintenanceSettings(value: unknown): Partial<AgentMaintenanceSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('保守設定はオブジェクトで指定してください。');
  const result: Record<string, boolean | number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['enabled', 'autoInstall', 'verifyWork'].includes(key)) {
      if (typeof item !== 'boolean') throw new Error(`${key} は真偽値で指定してください。`);
    } else if (['intervalMs', 'retryIntervalMs'].includes(key)) {
      if (!Number.isInteger(item) || Number(item) < 10_000 || Number(item) > 86_400_000) throw new Error(`${key} は10000〜86400000ミリ秒で指定してください。`);
    } else throw new Error('未対応の保守設定です。');
    result[key] = item as boolean | number;
  }
  return result;
}

export function readMaintenanceSettings(): AgentMaintenanceSettings {
  const defaults: AgentMaintenanceSettings = { enabled: process.env.WENTIAN_AGENT_MAINTENANCE_ENABLED !== 'false',
    intervalMs: Number(process.env.WENTIAN_AGENT_READY_REFRESH_MS) || 300_000, retryIntervalMs: 30_000,
    autoInstall: process.env.WENTIAN_AGENT_AUTO_INSTALL !== 'false', verifyWork: true };
  let saved: Partial<AgentMaintenanceSettings> = {};
  try { saved = validateMaintenanceSettings(JSON.parse(readFileSync(maintenanceSettingsPath(), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('保存済みの保守設定を読み取れません。設定ファイルを確認してください。'); }
  const settings = { ...defaults, ...saved };
  if (process.env.WENTIAN_AGENT_AUTO_INSTALL === 'false') settings.autoInstall = false;
  validateMaintenanceSettings(settings);
  return settings;
}

export async function saveMaintenanceSettings(settings: AgentMaintenanceSettings): Promise<void> {
  validateMaintenanceSettings(settings);
  const target = maintenanceSettingsPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  await renameWithRetry(temporary, target);
}
