import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FederationError } from './contracts.js';
import type { ManagedPlugin } from './node-supervisor.js';

/** 利用者が設定ファイルで許可したローカルModuleだけを候補へ追加します。AIへコード導入権限を渡しません。 */
export async function loadManagedPlugins(value: unknown, configDirectory: string): Promise<ManagedPlugin[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32 || value.some(item => typeof item !== 'string' || !item.startsWith('.'))) throw new FederationError('pluginsには設定フォルダー内の相対Moduleパスを指定してください。');
  const root = await realpath(configDirectory), plugins: ManagedPlugin[] = [];
  for (const item of value as string[]) {
    const target = await realpath(path.resolve(root, item));
    const relative = path.relative(root, target);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new FederationError('プラグインModuleが許可フォルダー外です。');
    const loaded = await import(pathToFileURL(target).href) as { default?: ManagedPlugin };
    const plugin = loaded.default;
    if (!plugin || !plugin.definition || typeof plugin.definition.setup !== 'function' || typeof plugin.health !== 'function' || typeof plugin.description !== 'string' || plugin.description.length > 2000 || !Number.isSafeInteger(plugin.memoryBudgetBytes) || plugin.memoryBudgetBytes < 0 || !Number.isSafeInteger(plugin.diskBudgetBytes) || plugin.diskBudgetBytes < 0) throw new FederationError('保守対象プラグインの契約が不正です。');
    plugins.push(plugin);
  }
  return plugins;
}
