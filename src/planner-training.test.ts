import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Window } from 'happy-dom';
import { PlannerTrainingService, registerPlannerTraining } from './planner-training.js';
import { plannerTrainingPage } from './planner-training-ui.js';

const label = { intent: 'chat', operation: 'answer', tools: [], required_capabilities: ['text'], delegation: { enabled: false } };

test('学習画面から登録・開始・停止・有効化解除を操作でき、取得許可は既定で無効', async () => {
  const window = new Window({ url: 'http://127.0.0.1:8787/model-training' });
  const calls: Array<{ url: string; body: any }> = [];
  window.fetch = (async (url: string, options?: RequestInit) => {
    calls.push({ url, body: options?.body ? JSON.parse(String(options.body)) : undefined });
    return Response.json({ model: '試験モデル', examples: 25, running: false, active: null, runs: [], fallback: true, python: '試験環境' });
  }) as any;
  try {
    const html = plannerTrainingPage();
    window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
    // 共通の多言語表示APIも読み込み、実画面と同じ順序で初期化します。
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(script[1]);
    await new Promise(resolve => setImmediate(resolve));
    for (const id of ['importExamples', 'train', 'stop', 'deactivate']) {
      const button = window.document.getElementById(id)! as any;
      await button.onclick();
    }
    assert.equal(calls.find(call => call.url.endsWith('/runs'))?.body.allowDownload, false);
    assert.equal(calls.find(call => call.url.endsWith('/active'))?.body.id, null);
    assert.ok(calls.some(call => call.url.endsWith('/examples')));
    assert.ok(calls.some(call => call.url.endsWith('/stop')));
    assert.match(window.document.getElementById('summary')!.textContent!, /^登録済み分類例: 25$/m);
    assert.equal(window.document.getElementById('notice')!.textContent, '操作を受け付けました。学習結果は履歴で確認してください。');
    assert.match(window.document.querySelector('.nav-rail [aria-current=page]')!.textContent!, /大規模言語モデル学習/);
  } finally { await window.happyDOM.close(); }
});

test('学習は確認済みデータを固定保存し、評価合格と重みを確認してから有効化する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-planner-training-'));
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const service = new PlannerTrainingService(root, async args => {
    const directory = args[args.indexOf('--directory') + 1];
    assert.ok(!(args.includes('--allow-download')));
    assert.equal((await readFile(path.join(directory, 'dataset.jsonl'), 'utf8')).trim().split('\n').length, 25);
    await waiting;
    await mkdir(path.join(directory, 'adapter'));
    await writeFile(path.join(directory, 'adapter/adapter_model.safetensors'), '試験用重み');
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ passed: true, accuracy: 1, unsafeWrites: 0, evaluated: 5 }));
    return '{}';
  });
  try {
    await assert.rejects(service.start(), /25件/);
    await service.importExamples(Array.from({ length: 25 }, (_, i) => ({ input: `確認${i}`, label })));
    await service.importExamples([{ input: '確認0', label }]); assert.equal((await service.status()).examples, 25);
    await assert.rejects(service.importExamples([{ input: '危険', label: { intent: 'local_tool', operation: 'write', tools: [] } }]), /必要なツール/);
    const job = await service.start();
    await assert.rejects(service.start(), /実行中/);
    await assert.rejects(service.activate(job.id), /評価/);
    release();
    // stopは完了待機にも使用でき、終了済み処理の結果を保持します。
    await service.stop();
    assert.equal((await service.status()).runs[0].status, 'succeeded');
    await service.activate(job.id); assert.equal((await service.status()).active.id, job.id);
    await service.activate(null); assert.equal((await service.status()).active, null);
    await writeFile(path.join(root, 'runs', job.id, 'report.json'), JSON.stringify({ passed: true, accuracy: 0.96, unsafeWrites: 1, evaluated: 25 }));
    await assert.rejects(service.activate(job.id), /評価/);
    await assert.rejects(service.activate('../outside'), /ID/);
  } finally { release(); await service.stop(); await rm(root, { recursive: true, force: true }); }
});

test('学習メニューとAPIは認証・同一オリジン・評価拒否を扱う', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-planner-api-'));
  const app = Fastify();
  registerPlannerTraining(app, (req, reply) => { if (req.headers.authorization === 'test-admin') return 'admin'; reply.code(401).send({ error: { message: 'ログインが必要です。' } }); return undefined; }, new PlannerTrainingService(root));
  try {
    assert.equal((await app.inject('/api/planner-training')).statusCode, 401);
    const headers = { authorization: 'test-admin', origin: 'https://other.invalid' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/planner-training/examples', headers, payload: { examples: [{ input: '你好', label }] } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/planner-training/examples', headers: { authorization: 'test-admin' }, payload: { examples: [{ input: '你好', label }] } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/planner-training/runs', headers: { authorization: 'test-admin' }, payload: {} })).statusCode, 400);
    assert.equal((await app.inject('/model-training')).statusCode, 200);
    assert.match(plannerTrainingPage(), /大規模言語モデル学習/); assert.match(plannerTrainingPage(), /\/api\/planner-training/);
    for (const script of plannerTrainingPage().matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script[1]));
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('学習エンジン障害は失敗として保存し、再起動前の実行中ジョブは中断表示する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-planner-failure-'));
  const service = new PlannerTrainingService(root, async () => { throw new Error('学習環境が未準備です。'); });
  try {
    await service.importExamples(Array.from({ length: 25 }, (_, i) => ({ input: `確認${i}`, label })));
    await service.start(); await service.stop();
    const status = await service.status(); assert.equal(status.runs[0].status, 'failed'); assert.match(status.runs[0].error, /未準備/); assert.equal(status.active, null);
    const id = '00000000-0000-4000-8000-000000000000';
    await mkdir(path.join(root, 'runs', id));
    await writeFile(path.join(root, 'runs', id, 'job.json'), JSON.stringify({ id, status: 'running', createdAt: new Date().toISOString() }));
    assert.equal((await new PlannerTrainingService(root).status()).runs.find(job => job.id === id).status, 'interrupted');
  } finally { await service.stop(); await rm(root, { recursive: true, force: true }); }
});
