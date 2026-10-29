import test from 'node:test';
import assert from 'node:assert/strict';
import { createWentianImageRuntime } from './wentian-image-runtime.js';
import type { ProviderConfig } from './config.js';

const provider: ProviderConfig = { id: 'image-plugin', name: '試験プラグイン', kind: 'media', scope: 'local', baseUrl: 'http://images.test/v1', priority: 1, enabled: true, autoRoute: false, tags: [], apiKey: 'secret-test', modelProfiles: { 'prepared-model': { capabilities: { image_generation: 1 } } } };
test('Wentian既存設定からAIが実在する生成経路を選び、認証を再利用する', async () => {
  let selected = false;
  const runtime = createWentianImageRuntime({ providers: () => [provider], comfyEnabled: () => false,
    respond: async (_m, messages, context) => { assert.equal(context?.imageRouting, true); assert.equal(messages.some(m => m.content.includes('secret-test')), false); return JSON.stringify({ candidateId: 'image-plugin:prepared-model', reason: '準備済みの画像生成モデル' }); },
    apiGenerate: async (settings, prompt) => { assert.equal(settings.endpoint, 'http://images.test/v1/images/generations'); assert.equal(settings.apiKey, 'secret-test'); assert.equal(prompt, '青い海'); selected = true; return Buffer.from('生成結果'); },
  });
  assert.equal((await runtime.inspect()).candidates.length, 1); assert.equal((await runtime.generate('青い海', new AbortController().signal)).toString(), '生成結果'); assert.equal(selected, true);
});
test('画像能力を名前で推測せず、無効な設定とComfyUIの実行禁止を尊重する', async () => {
  let fetched = false; const runtime = createWentianImageRuntime({ providers: () => [{ ...provider, enabled: false }, { ...provider, id: 'text-only', modelProfiles: {} }, { ...provider, id: 'comfyui' }], comfyEnabled: () => false, respond: async () => '', fetch: async () => { fetched = true; throw new Error('呼出し禁止'); } });
  assert.equal((await runtime.inspect()).candidates.length, 0); await assert.rejects(runtime.generate('制作', new AbortController().signal), /プラグインがありません/); assert.equal(fetched, false);
});
test('AIが候補外のモデルを返した場合は実行しない', async () => {
  let executed = false; const runtime = createWentianImageRuntime({ providers: () => [provider], comfyEnabled: () => false, respond: async () => '{"candidateId":"架空のモデル","reason":"推測"}', apiGenerate: async () => { executed = true; return Buffer.alloc(0); } });
  await assert.rejects(runtime.generate('制作', new AbortController().signal), /確認できません/); assert.equal(executed, false);
});
test('外部AgentのCodexもWentian既定の画像制作経路に含める', async () => {
  let ran = false; const runtime = createWentianImageRuntime({ providers: () => [], comfyEnabled: () => false, respond: async () => '{"candidateId":"external/codex","reason":"利用可能な画像制作Agent"}', codex: { inspect: async () => ({ id: 'codex', model: 'user-model' }), generate: async () => { ran = true; return Buffer.from('生成画像'); } } });
  assert.equal((await runtime.inspect()).candidates[0].adapter, 'codex'); assert.equal((await runtime.generate('公園', new AbortController().signal)).toString(), '生成画像'); assert.equal(ran, true);
});
test('ComfyUIの実ノードとチェックポイントを確認して制作・結果取得する', async () => {
  const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
  let submitted = false;
  const runtime = createWentianImageRuntime({ providers: () => [{ ...provider, id: 'comfyui', baseUrl: 'http://comfy.test', modelProfiles: {} }], comfyEnabled: () => true, respond: async () => '{"candidateId":"comfyui:prepared.safetensors","reason":"実在するモデル"}', fetch: async (input, init) => {
    const url = String(input);
    if (url.endsWith('/object_info')) return Response.json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['prepared.safetensors']] } } }, CLIPTextEncode: {}, EmptyLatentImage: {}, KSampler: {}, VAEDecode: {}, SaveImage: {} });
    if (url.endsWith('/prompt')) { const body = JSON.parse(String(init?.body)); assert.equal(body.prompt['1'].inputs.ckpt_name, 'prepared.safetensors'); assert.equal(body.prompt['2'].inputs.text, '山の風景'); submitted = true; return Response.json({ prompt_id: 'test-job' }); }
    if (url.includes('/history/')) return Response.json({ 'test-job': { status: { completed: true }, outputs: { '7': { images: [{ filename: 'generated.png', subfolder: '', type: 'output' }] } } } });
    if (url.includes('/view?')) return new Response(png);
    throw new Error('未定義の試験URL');
  } });
  assert.deepEqual(await runtime.generate('山の風景', new AbortController().signal), png); assert.equal(submitted, true);
});
