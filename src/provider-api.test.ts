import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp, providers } from './server.js';

test('管理者はProviderを追加・変更・削除でき、秘密値は応答へ含まれない', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-provider-api-'));
  const saved = Object.fromEntries(['WENTIAN_USER_STORE','WENTIAN_PROVIDER_MANAGEMENT_FILE'].map(key => [key, process.env[key]]));
  process.env.WENTIAN_USER_STORE = path.join(root, 'users.json');
  process.env.WENTIAN_PROVIDER_MANAGEMENT_FILE = path.join(root, 'provider-management.json');
  const app = await buildApp({ agentConnectionMaintenance: false });
  try {
    const setup = await app.inject({ method: 'POST', url: '/api/control-center/setup', payload: { username: 'provider-admin', password: 'fixture-provider-admin-password' } });
    assert.equal(setup.statusCode, 201, setup.body);
    const cookie = String(setup.headers['set-cookie']).split(';')[0]!;
    const id = 'fixture-provider';
    const secret = 'fixture-provider-secret';
    const create = await app.inject({ method: 'POST', url: '/api/providers', headers: { cookie }, payload: { id, name: '試験Provider', kind: 'llm', scope: 'remote', baseUrl: 'https://provider.example.test/v1', priority: 20, enabled: true, autoRoute: true, tags: ['fixture'], apiKey: secret } });
    assert.equal(create.statusCode, 201, create.body);
    assert.equal(create.json().provider.apiKey, undefined);
    assert.equal(providers.some(provider => provider.id === id), true);

    const edit = await app.inject({ method: 'PUT', url: `/api/providers/${id}`, headers: { cookie }, payload: { name: '更新Provider', kind: 'llm', scope: 'remote', baseUrl: 'https://provider.example.test/v2', priority: 10, enabled: false, autoRoute: true, tags: ['fixture','edited'], apiKey: '' } });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(edit.json().provider.name, '更新Provider');
    assert.equal(providers.find(provider => provider.id === id)?.apiKey, secret, '空欄の編集は既存キーを保ちます');

    const denied = await app.inject({ method: 'DELETE', url: `/api/providers/${id}` });
    assert.equal(denied.statusCode, 401);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/providers/${id}`, headers: { cookie } });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(providers.some(provider => provider.id === id), false);
    const savedConfig = await readFile(process.env.WENTIAN_PROVIDER_MANAGEMENT_FILE!, 'utf8');
    assert.equal(savedConfig.includes(secret), false, '削除後の管理設定にキーを残しません');
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
