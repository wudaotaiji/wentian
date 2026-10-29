import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderFile, validateRuntimeEnv } from './config.js';

test('モデル別能力レジストリ（Model Capability Registry）を検証する', () => {
  const provider = { id: 'local', baseUrl: 'http://localhost:11434', modelProfiles: { small: { capabilities: { coding: 0.8, contextTokens: 32768 }, kvBytesPerToken: 65536 } } };
  assert.equal(parseProviderFile([provider])[0].modelProfiles?.small.kvBytesPerToken, 65536);
  assert.throws(() => parseProviderFile([{ ...provider, modelProfiles: { bad: { capabilities: { coding: 2 } } } }]), /範囲外/);
  assert.throws(() => parseProviderFile([{ ...provider, modelProfiles: { bad: { kvBytesPerToken: -1 } } }]), /不正/);
});

test('複数の外部プロバイダーを同時に読み込める', () => {
  const providers = parseProviderFile({providers:[
    {id:'remote-a',baseUrl:'https://example.test/a/v1',scope:'remote',autoRoute:true},
    {id:'remote-b',baseUrl:'https://example.test/b/v1',scope:'remote',autoRoute:true,apiKeyEnv:'TEST_KEY'},
  ]}, {TEST_KEY:'secret'});
  assert.equal(providers.length, 2);
  assert.equal(providers[1].apiKey, 'secret');
  assert.equal(providers[1].autoRoute, true);
});

test('Vision対応モデルをプロバイダー内で限定できる', () => {
  const [provider] = parseProviderFile([{ id: 'vision-api', baseUrl: 'https://example.test/v1', capabilities: { vision: 0.8 }, visionModels: ['local-model'] }]);
  assert.deepEqual(provider.visionModels, ['local-model']);
  assert.equal(provider.capabilities?.vision, 0.8);
});

test('重複IDと危険なURLスキームを拒否する', () => {
  assert.throws(() => parseProviderFile([{id:'same',baseUrl:'https://example.test/v1'},{id:'same',baseUrl:'https://other.test/v1'}]));
  assert.throws(() => parseProviderFile([{id:'bad',baseUrl:'file:///etc/passwd'}]));
});

test('URL内認証情報とクラウドメタデータ宛先を拒否する', () => {
  const base = { id: 'unsafe', kind: 'llm', scope: 'remote', priority: 1, enabled: true, autoRoute: true };
  assert.throws(() => parseProviderFile([{ ...base, baseUrl: 'http://user:pass@example.com/v1' }]), /URL内の認証情報/);
  assert.throws(() => parseProviderFile([{ ...base, baseUrl: 'http://169.254.169.254/latest' }]), /メタデータサービス/);
  assert.throws(() => parseProviderFile([{ ...base, baseUrl: 'http://metadata.google.internal/computeMetadata/v1' }]), /メタデータサービス/);
});

test('実行時環境変数の不正な数値、真偽値、URLを拒否する', () => {
  assert.throws(() => validateRuntimeEnv({ PORT: '70000' }), /65535/);
  assert.throws(() => validateRuntimeEnv({ WENTIAN_REQUEST_TIMEOUT_MS: 'abc' }), /正の整数/);
  assert.throws(() => validateRuntimeEnv({ WENTIAN_ENABLE_STATE_CHANGES: 'yes' }), /true または false/);
  assert.throws(() => validateRuntimeEnv({ OLLAMA_BASE_URL: 'file:\/\/local' }), /http\/https/);
  assert.doesNotThrow(() => validateRuntimeEnv({ PORT: '8787', WENTIAN_ENABLE_STATE_CHANGES: 'false', WENTIAN_CORS_ORIGINS: 'http://127.0.0.1,http://localhost' }));
});
