import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';
import path from 'node:path';

export interface ManualAgentDefinition { id: string; name: string; cli: string; repository?: string; note?: string; }

function registryPath(): string {
  return process.env.WENTIAN_MANUAL_AGENTS_FILE || path.resolve('.wentian', 'manual-agents.json');
}

/** 手動登録値をコマンド注入へ利用できない文字種に制限します。 */
export function validateManualAgent(input: unknown): ManualAgentDefinition {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const id = String(value.id || '').trim().toLowerCase();
  const name = String(value.name || '').trim();
  const cli = String(value.cli || '').trim();
  const repository = String(value.repository || '').trim() || undefined;
  const note = String(value.note || '').trim() || undefined;
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(id)) throw new Error('IDは2～40文字の英小文字・数字・ハイフン・アンダースコアで指定してください。');
  if (!name || name.length > 80) throw new Error('表示名は1～80文字で指定してください。');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(cli)) throw new Error('CLI名には実行ファイル名だけを指定してください。');
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('リポジトリは owner/repository 形式で指定してください。');
  if (note && note.length > 240) throw new Error('補足は240文字以内で指定してください。');
  return { id, name, cli, repository, note };
}

export async function loadManualAgents(): Promise<ManualAgentDefinition[]> {
  try {
    const values = JSON.parse(await readFile(registryPath(), 'utf8'));
    return Array.isArray(values) ? values.map(validateManualAgent) : [];
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** 一時ファイルからの置換により、途中書き込みで台帳を壊さないよう保存します。 */
export async function registerManualAgent(input: unknown): Promise<ManualAgentDefinition> {
  const agent = validateManualAgent(input);
  const values = await loadManualAgents();
  const next = [...values.filter(value => value.id !== agent.id), agent].sort((a, b) => a.id.localeCompare(b.id));
  const target = registryPath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, target);
  return agent;
}

/** 解除済みの登録情報だけを削除し、CLI・認証設定・履歴には触れません。 */
export async function deleteManualAgent(id:string):Promise<void>{
  const next=(await loadManualAgents()).filter(agent=>agent.id!==id);const target=registryPath();await mkdir(path.dirname(target),{recursive:true});const temporary=target+'.'+process.pid+'.tmp';await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{encoding:'utf8',mode:0o600});await renameWithRetry(temporary,target);
}
