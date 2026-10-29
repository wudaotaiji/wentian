import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadPluginManifest, mergePluginSpecs } from './plugin-config.js';

test('Profile継承とOverlayをPlugin ID単位で合成する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-plugin-config-'));
  const file = path.join(root, 'plugins.json');
  await writeFile(file, JSON.stringify({ version: '1.0', activeProfile: 'standard', profiles: { minimal: { plugins: [{ id: 'a', config: { mode: 1 } }] }, standard: { extends: 'minimal', plugins: [{ id: 'b' }] } }, overlays: [{ id: 'a', config: { mode: 2 } }] }), 'utf8');
  try {
    const loaded = await loadPluginManifest(file);
    assert.deepEqual(loaded.specs, [{ id: 'a', config: { mode: 2 } }, { id: 'b' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('OverlayでPluginを無効化できる', () => {
  assert.deepEqual(mergePluginSpecs([{ id: 'a' }, { id: 'b' }], [{ id: 'a', enabled: false }]), [{ id: 'a', enabled: false }, { id: 'b' }]);
});

test('作業ディレクトリー外では導入先へ戻り、明示設定を優先する', async () => {
  const { resolvePluginManifest } = await import('./plugin-config.js');
  const original = process.cwd();
  const previous = process.env.WENTIAN_PLUGIN_MANIFEST;
  const previousRoot = process.env.WENTIAN_INSTALL_ROOT;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wentian-install-path-'));
  try {
    delete process.env.WENTIAN_PLUGIN_MANIFEST;
    process.env.WENTIAN_INSTALL_ROOT = original;
    process.chdir(directory);
    assert.equal(resolvePluginManifest(), path.join(original, 'wentian.plugins.json'));
    const loaded = await loadPluginManifest();
    assert.equal(loaded.manifest.version, '1.0');
    await writeFile(path.join(directory, 'wentian.plugins.json'), '{}');
    assert.equal(resolvePluginManifest(), path.join(directory, 'wentian.plugins.json'));
    process.env.WENTIAN_PLUGIN_MANIFEST = 'wentian.plugins.json';
    assert.equal(resolvePluginManifest(), path.join(original, 'wentian.plugins.json'));
    process.env.WENTIAN_PLUGIN_MANIFEST = path.join(directory, 'explicit.json');
    assert.equal(resolvePluginManifest(), path.join(directory, 'explicit.json'));
  } finally {
    process.chdir(original);
    if (previous === undefined) delete process.env.WENTIAN_PLUGIN_MANIFEST; else process.env.WENTIAN_PLUGIN_MANIFEST = previous;
    if (previousRoot === undefined) delete process.env.WENTIAN_INSTALL_ROOT; else process.env.WENTIAN_INSTALL_ROOT = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
