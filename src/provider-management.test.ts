import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProviderManagement, saveProviderManagement, validateManagedProvider } from './provider-management.js';

test('Provider管理設定を一時領域へ保存・再読込し、削除済みIDを維持する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-provider-management-'));
  const file = path.join(root, 'provider-management.json');
  try {
    const provider = validateManagedProvider({ id: 'test-provider', name: '試験接続先', kind: 'llm', scope: 'remote', baseUrl: 'https://example.test/v1', priority: 5, enabled: true, autoRoute: true, tags: ['test'] });
    await saveProviderManagement({ providers: [provider], deletedIds: ['old-provider'] }, file);
    const loaded = loadProviderManagement(file);
    assert.equal(loaded.providers[0]?.baseUrl, 'https://example.test/v1');
    assert.deepEqual(loaded.deletedIds, ['old-provider']);
    assert.equal(loaded.providers[0]?.apiKey, undefined, '未設定の秘密値を作りません');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Provider設定の不正な接続先と自動ルーティングMediaを拒否する', () => {
  assert.throws(() => validateManagedProvider({ id: 'bad-provider', name: '不正', kind: 'llm', scope: 'remote', baseUrl: 'file:///secret', priority: 1 }));
  assert.throws(() => validateManagedProvider({ id: 'media-provider', name: '画像', kind: 'media', scope: 'local', baseUrl: 'http://127.0.0.1:8188', priority: 1, autoRoute: true }));
});
