import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyUpstreamFailure,
  fetchWithClientAbort,
  getAllowedProxyPath,
  readTransparentUpstreamError,
  resolveUpstreamModelId,
  sseProxyHeaders,
  toNodeReadable,
} from './proxy.js';

test('許可済みの互換 API パスだけを受理する', () => {
  assert.deepEqual(getAllowedProxyPath('/v1/responses?trace=1'), { path: '/v1/responses', protocol: 'openai' });
  assert.deepEqual(getAllowedProxyPath('/v1/messages'), { path: '/v1/messages', protocol: 'anthropic' });
  assert.equal(getAllowedProxyPath('/v1/../admin'), undefined);
  assert.equal(getAllowedProxyPath('/v1/models'), undefined);
});

test('上流 HTTP エラーを要件どおり分類する', () => {
  for (const status of [400, 401, 403, 404, 422]) assert.equal(classifyUpstreamFailure(status).fallback, false);
  for (const status of [408, 429, 500, 502, 503, 599]) assert.equal(classifyUpstreamFailure(status).fallback, true);
  assert.deepEqual(classifyUpstreamFailure(new TypeError('network')), { fallback: true, category: 'network' });
});

test('OpenAI エラーの状態、Content-Type、本文を透過する', async () => {
  const json = '{"error":{"message":"invalid model","code":"model_not_found"}}';
  const result = await readTransparentUpstreamError(new Response(json, {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }));
  assert.deepEqual(result, { status: 404, contentType: 'application/json', body: json, fallback: false });
});

test('クライアント切断を上流 Fetch へ伝播する', async () => {
  const client = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const pending = fetchWithClientAbort('http://example.invalid', {}, {
    clientSignal: client.signal,
    fetchImplementation: async (_input, init) => {
      receivedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), { once: true });
      });
    },
  });
  client.abort(new Error('client disconnected'));
  await assert.rejects(pending, /client disconnected/);
  assert.equal(receivedSignal?.aborted, true);
});

test('タイムアウトで上流 Fetch を中止する', async () => {
  const pending = fetchWithClientAbort('http://example.invalid', {}, {
    timeoutMs: 5,
    fetchImplementation: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }),
  });
  await assert.rejects(pending, (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError');
});

test('SSE ヘッダーと Node.js ストリームを生成する', async () => {
  const response = new Response('data: ok\n\n', { headers: { 'content-type': 'text/event-stream' } });
  assert.deepEqual(sseProxyHeaders(response.headers), {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let value = '';
  for await (const chunk of toNodeReadable(response)) value += chunk.toString();
  assert.equal(value, 'data: ok\n\n');
});

test('変換した上流ストリームはクライアント切断エラーを未処理にしない', () => {
  const response = new Response(new ReadableStream({ start() {} }));
  const readable = toNodeReadable(response);
  assert.ok(readable.listenerCount('error') >= 1);
  readable.destroy();
});

test('明示モデルと自動解決モデルを上流 ID に変換する', () => {
  assert.equal(resolveUpstreamModelId('remote/model/a', 'remote'), 'model/a');
  assert.equal(resolveUpstreamModelId('wentian-auto/remote', 'remote', 'remote/model-b'), 'model-b');
  assert.throws(() => resolveUpstreamModelId('other/model', 'remote'), /属していません/);
  assert.throws(() => resolveUpstreamModelId('wentian-auto/all', 'remote'), /解決済み/);
});
