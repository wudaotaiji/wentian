import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WentianPluginDefinition, WentianPluginSpec } from './plugin-kernel.js';

export interface WentianPluginManifest {
  version: '1.0';
  activeProfile: string;
  modules?: Array<{ id: string; module: string }>;
  profiles: Record<string, { extends?: string; plugins: WentianPluginSpec[] }>;
  overlays?: WentianPluginSpec[];
}

/** 明示設定、作業ディレクトリー、導入先の順にManifestを解決します。 */
export function resolvePluginManifest(): string {
  const root = process.env.WENTIAN_INSTALL_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // .env内の相対パスは起動場所ではなく導入先を基準にします。
  if (process.env.WENTIAN_PLUGIN_MANIFEST) return path.resolve(root, process.env.WENTIAN_PLUGIN_MANIFEST);
  const project = path.join(process.cwd(), 'wentian.plugins.json');
  return existsSync(project) ? project : path.join(root, 'wentian.plugins.json');
}

/** Manifestを厳密に検証し、Profile継承とOverlayをID単位で合成します。 */
export async function loadPluginManifest(file = resolvePluginManifest()): Promise<{ manifest: WentianPluginManifest; specs: WentianPluginSpec[]; file: string }> {
  const resolved = path.resolve(file);
  const value = JSON.parse(await readFile(resolved, 'utf8')) as WentianPluginManifest;
  if (value.version !== '1.0' || !value.profiles || typeof value.activeProfile !== 'string') throw new Error('Plugin Manifestのversion、activeProfile、profilesが不正です。');
  const visiting = new Set<string>();
  const expand = (name: string): WentianPluginSpec[] => {
    if (visiting.has(name)) throw new Error(`Profile継承が循環しています: ${name}`);
    const profile = value.profiles[name]; if (!profile || !Array.isArray(profile.plugins)) throw new Error(`Profileが見つかりません: ${name}`);
    visiting.add(name); const base = profile.extends ? expand(profile.extends) : []; visiting.delete(name);
    return mergePluginSpecs(base, profile.plugins);
  };
  return { manifest: value, specs: mergePluginSpecs(expand(value.activeProfile), value.overlays || []), file: resolved };
}

export function mergePluginSpecs(base: WentianPluginSpec[], overlay: WentianPluginSpec[]): WentianPluginSpec[] {
  const result = new Map(base.map(spec => [spec.id, { ...spec }]));
  for (const spec of overlay) {
    const previous = result.get(spec.id);
    const merged = { ...previous, ...spec };
    // 未指定configは継承しますが、元にも存在しない場合はJSON上に余分なundefined Propertyを作りません。
    if (spec.config === undefined && previous?.config !== undefined) merged.config = previous.config;
    else if (spec.config === undefined) delete merged.config;
    result.set(spec.id, merged);
  }
  return [...result.values()];
}

/** 外部PluginはManifest所在ディレクトリー配下だけを既定許可し、任意Package実行を防ぎます。 */
export async function importManifestPlugins(manifest: WentianPluginManifest, manifestFile: string): Promise<WentianPluginDefinition[]> {
  const root = path.dirname(path.resolve(manifestFile));
  const definitions: WentianPluginDefinition[] = [];
  for (const item of manifest.modules || []) {
    if (!item.module.startsWith('.') && process.env.WENTIAN_ALLOW_PACKAGE_PLUGINS !== 'true') throw new Error(`Package Pluginは明示許可が必要です: ${item.module}`);
    const target = item.module.startsWith('.') ? path.resolve(root, item.module) : item.module;
    if (item.module.startsWith('.') && target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Plugin ModuleがManifest配下から脱出しています: ${item.module}`);
    if (item.module.startsWith('.') && !existsSync(target)) throw new Error(`Plugin Moduleが見つかりません: ${target}`);
    const loaded = await import(item.module.startsWith('.') ? pathToFileURL(target).href : target) as { default?: WentianPluginDefinition; plugin?: WentianPluginDefinition };
    const definition = loaded.default || loaded.plugin;
    if (!definition || definition.id !== item.id) throw new Error(`Plugin ModuleのexportまたはIDが不正です: ${item.id}`);
    definitions.push(definition);
  }
  return definitions;
}
