import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { builtinVisualAssets, generateVisualImage, parseVisualDecision, registerVisualAssets } from './visual-assets.js';
import { visualAssetsHtml } from './visual-assets-ui.js';
import { startupForgeRoomHtml } from './startup-forge-room.js';
import { registerWorkbench } from './workbench.js';
import vm from 'node:vm';

async function wait(app: ReturnType<typeof Fastify>, id: string) { for (let n = 0; n < 100; n++) { const s = (await app.inject('/api/visual-assets/sessions/' + id)).json(); if (!['thinking', 'generating'].includes(s.status)) return s; await new Promise(r => setTimeout(r, 10)); } throw new Error('制作試験が時間切れです。'); }
test('AIの構造化判断を検証し、自然言語の固定語では制作を決めない', () => {
  assert.deepEqual(parseVisualDecision('{"reply":"まず相談しましょう","asset":null}').asset, null);
  assert.throws(() => parseVisualDecision('{"reply":"制作","asset":{"kind":"other","name":"a","prompt":"b"}}'));
  assert.throws(() => parseVisualDecision('{"reply":"制作"}'));
  assert.equal(builtinVisualAssets.length, 21);
});
test('AI会話から制作し、群に依存しないライブラリへ保存・再読込できる', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-visual-')); let app = Fastify(); let calls = 0;
  try {
    registerVisualAssets(app, root, async (_member, messages, context) => { assert.equal(context?.assetPlanning, true); assert.equal(messages.at(-1)?.content, 'それでお願いします'); return JSON.stringify({ reply: '海辺の背景を制作します', asset: { kind: 'background', name: '夕暮れ', prompt: '夕暮れの海辺、人物なし' } }); }, async (_s, prompt) => { calls++; assert.match(prompt, /夕暮れ/); return Buffer.from('隔離された試験画像'); });
    const config = { mode: 'custom', endpoint: 'https://images.example.test/v1/images/generations', model: 'user-model', apiKey: 'private-test-key' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/visual-assets/settings', payload: config })).statusCode, 200);
    const publicConfig = (await app.inject('/api/visual-assets/settings')).json(); assert.equal(publicConfig.hasKey, true); assert.equal(JSON.stringify(publicConfig).includes(config.apiKey), false);
    const s = (await app.inject({ method: 'POST', url: '/api/visual-assets/sessions', payload: {} })).json();
    assert.equal((await app.inject({ method: 'POST', url: '/api/visual-assets/sessions/' + s.id + '/messages', payload: { message: 'それでお願いします' } })).statusCode, 202);
    const done = await wait(app, s.id); assert.equal(done.status, 'idle'); assert.equal(calls, 1);
    const assets = (await app.inject('/api/visual-assets')).json().assets; assert.equal(assets.length, builtinVisualAssets.length + 1); assert.equal(assets.at(-1).name, '夕暮れ');
    assert.equal((await app.inject(assets.at(-1).url)).body, '隔離された試験画像');
    await app.close(); app = Fastify(); registerVisualAssets(app, root);
    assert.equal((await app.inject('/api/visual-assets')).json().assets.length, builtinVisualAssets.length + 1);
    assert.equal((await app.inject('/api/visual-assets/sessions/' + s.id)).json().assetId, done.assetId);
    assert.equal(JSON.parse(await readFile(path.join(root, '.wentian/visual-assets/settings.json'), 'utf8')).model, 'user-model');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
test('相談時は生成せず、未設定の制作はエラーを表示し架空素材を追加しない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-visual-error-')), app = Fastify(); let decision: unknown = null, calls = 0;
  registerVisualAssets(app, root, async () => JSON.stringify({ reply: '相談の返答', asset: decision }), async () => { calls++; return Buffer.from('画像'); });
  try {
    const s = (await app.inject({ method: 'POST', url: '/api/visual-assets/sessions', payload: {} })).json(); const url = '/api/visual-assets/sessions/' + s.id + '/messages';
    await app.inject({ method: 'POST', url, payload: { message: '背景と人物について教えて' } }); assert.equal((await wait(app, s.id)).status, 'idle'); assert.equal(calls, 0);
    decision = { kind: 'character', name: '人物', prompt: '全身、透明背景' };
    await app.inject({ method: 'POST', url, payload: { message: '作って' } }); const result = await wait(app, s.id); assert.equal(result.status, 'error'); assert.match(result.error, /プラグイン/); assert.equal(calls, 0); assert.equal((await app.inject('/api/visual-assets')).json().assets.length, builtinVisualAssets.length);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
test('素材APIは管理者認証と同一オリジン検査を通す', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-visual-auth-')), app = Fastify();
  registerWorkbench(app, { workspace: root, authorize: (req, reply) => { if (req.headers.authorization === 'test-admin') return true; reply.code(401).send({ error: { message: '認証が必要です。' } }); return false; }, models: async () => [], providerSaved: () => {}, testModel: async () => '' });
  try { assert.equal((await app.inject('/visual-assets')).statusCode, 200); assert.equal((await app.inject('/api/visual-assets')).statusCode, 401); assert.equal((await app.inject({ method: 'POST', url: '/api/visual-assets/sessions', headers: { authorization: 'test-admin', origin: 'https://foreign.test' }, payload: {} })).statusCode, 403); assert.equal((await app.inject({ url: '/api/visual-assets', headers: { authorization: 'test-admin' } })).json().assets.length, builtinVisualAssets.length); } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
test('制作画面と孵化器は構文が有効で、新規素材を安全なDOMで再利用する', () => {
  assert.match(visualAssetsHtml, /class="nav-rail"/); assert.match(visualAssetsHtml, /\.nav-rail\{position:fixed/);
  assert.match(visualAssetsHtml, /textarea id="visualPrompt"/); assert.doesNotMatch(visualAssetsHtml, /id="message"/);
  for (const html of [visualAssetsHtml, startupForgeRoomHtml('<head></head><body></body>')]) for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.match(visualAssetsHtml, /背景と人物制作/); assert.match(visualAssetsHtml, /textContent/); assert.match(startupForgeRoomHtml('<head></head><body></body>'), /loadSharedAssets/); assert.match(startupForgeRoomHtml('<head></head><body></body>'), /customAssets.some\(a=>a.id===\$\('worldLook'\)/);
});
test('画像生成APIは無効な画像を拒否する', async () => {
  const old = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('偽画像').toString('base64') }] }));
  try { await assert.rejects(generateVisualImage({ endpoint: 'https://test.invalid', model: 'test', apiKey: '' }, '試験', new AbortController().signal), /PNG/); } finally { globalThis.fetch = old; }
});

test('既定はWentianで個別設定なしに制作し、明示した場合だけ任意設定を使用する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-visual-default-')), app = Fastify(); let automatic = 0, custom = 0;
  registerVisualAssets(app, root, async () => '{"reply":"制作します","asset":{"kind":"character","name":"旅人","prompt":"全身の旅人"}}', async () => { custom++; return Buffer.from('任意設定の画像'); }, { inspect: async () => ({ candidates: [], message: 'Wentianの状態' }), generate: async () => { automatic++; return Buffer.from('Wentianの画像'); } });
  try {
    assert.equal((await app.inject('/api/visual-assets/settings')).json().mode, 'wentian');
    const s = (await app.inject({ method: 'POST', url: '/api/visual-assets/sessions', payload: {} })).json(), url = '/api/visual-assets/sessions/' + s.id + '/messages';
    await app.inject({ method: 'POST', url, payload: { message: '制作をお願いします' } }); assert.equal((await wait(app, s.id)).status, 'idle'); assert.equal(automatic, 1); assert.equal(custom, 0);
    await app.inject({ method: 'POST', url: '/api/visual-assets/settings', payload: { mode: 'custom', endpoint: 'https://example.test/images', model: 'test' } });
    await app.inject({ method: 'POST', url, payload: { message: 'もう一枚' } }); await wait(app, s.id); assert.equal(automatic, 1); assert.equal(custom, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/api/visual-assets/settings', payload: { mode: 'wentian' } })).statusCode, 200);
    const settings = (await app.inject('/api/visual-assets/settings')).json(); assert.equal(settings.mode, 'wentian'); assert.equal(settings.model, 'test');
    assert.match(visualAssetsHtml, /Wentianに任せる（既定）/); assert.match(visualAssetsHtml, /id="customSettings" hidden/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
