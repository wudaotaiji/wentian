import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp-http-server.js';
import { MCPTaskAdapter, InMemoryTaskService } from './mcp-task-adapter.js';

test('セッション終了でリソース購読の監視タイマーを停止する', async () => {
  const service = new InMemoryTaskService();
  const task = await service.submitTask('owner', { prompt: '購読停止検証' });
  let reads = 0;
  const original = service.getTask.bind(service);
  service.getTask = async (...args) => { reads++; return original(...args); };
  const server = createMcpServer(new MCPTaskAdapter(service), service, { ownerId: 'owner' });
  const client = new Client({ name: '終了検証', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    await client.subscribeResource({ uri: `wentian://tasks/${task.taskId}` });
    assert.equal(reads, 1);
    await client.close(); await server.close();
    const before = reads;
    await new Promise(done => setTimeout(done, 1200));
    assert.equal(reads, before);
  } finally { await client.close(); await server.close(); }
});

test('公式SDKクライアントでHTTPの初期化・12ツール・リソース・プロンプト・所有者分離・終了を検証する', async () => {
  const app = Fastify();
  const service = new InMemoryTaskService();
  new MCPTaskAdapter(service).registerHttpRoutes(app, req => ({ ownerId: String(req.headers.authorization || 'anonymous') }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer owner-a' } } });
  const client = new Client({ name: '相互運用検証', version: '1.0' });
  try {
    await client.connect(transport);
    const listChanged = new Promise<void>(resolve => { client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { resolve(); }); });
    assert.ok(transport.sessionId);
    assert.equal((await client.listTools()).tools.length, 12);
    const result = await client.callTool({ name: 'wentian_submit_task', arguments: { prompt: '検証対象' } });
    const id = JSON.parse((result.content as Array<{ text: string }>)[0].text).task_id;
    await Promise.race([listChanged, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('一覧更新通知が届きません。')), 3000); timer.unref(); })]);
    assert.equal((await client.listResources()).resources.length, 1);
    assert.ok((await client.readResource({ uri: `wentian://tasks/${id}` })).contents[0]);
    const updated = new Promise<void>(resolve => { client.setNotificationHandler(ResourceUpdatedNotificationSchema, () => { resolve(); }); });
    await client.subscribeResource({ uri: `wentian://tasks/${id}` });
    service.setTaskStatus(id, 'running');
    await Promise.race([updated, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('購読通知が届きません。')), 3000); timer.unref(); })]);
    await client.unsubscribeResource({ uri: `wentian://tasks/${id}` });
    assert.deepEqual((await client.complete({ ref: { type: 'ref/resource', uri: 'wentian://tasks/{task_id}' }, argument: { name: 'task_id', value: 'task_' } })).completion.values, [id]);
    assert.equal((await client.listPrompts()).prompts.length, 1);
    await client.setLoggingLevel('info');
    assert.equal((await client.getPrompt({ name: 'wentian-task-plan', arguments: { request: '資料を作成' } })).messages.length, 1);
    const foreign = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer owner-b', 'mcp-session-id': transport.sessionId!, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/list' }) });
    assert.equal(foreign.status, 403);
    const origin = await fetch(url, { method: 'POST', headers: { Origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(origin.status, 403);
    const host = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'attacker.example' }, payload: {} });
    assert.equal(host.statusCode, 403);
    const second = new Client({ name: '別所有者の検証', version: '1.0' });
    try {
      await second.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer owner-b' } } }));
      assert.equal((await second.listResources()).resources.length, 0);
      await assert.rejects(() => second.readResource({ uri: `wentian://tasks/${id}` }));
      const failure = await second.callTool({ name: 'wentian_get_task', arguments: { task_id: id } });
      assert.equal(failure.isError, true);
    } finally { await second.close(); }
    // SDKクライアントが既にGETのSSEを開いているため、二重ストリームは標準の409になります。
    const abort = new AbortController();
    const stream = await fetch(url, { headers: { Authorization: 'Bearer owner-a', 'mcp-session-id': transport.sessionId!, Accept: 'text/event-stream' }, signal: abort.signal });
    assert.equal(stream.status, 409); abort.abort();
    await transport.terminateSession();
    const expired = await fetch(url, { headers: { 'mcp-session-id': transport.sessionId || 'expired', Accept: 'text/event-stream' } });
    assert.equal(expired.status, 404);
  } finally { await client.close(); await app.close(); }
});

test('標準stdioラッパーは認証をHTTPへ転送して公式SDKと相互運用する', async () => {
  const app = Fastify();
  new MCPTaskAdapter(new InMemoryTaskService()).registerHttpRoutes(app, req => {
    assert.equal(req.headers.authorization, 'Bearer bridge-key'); return { ownerId: 'bridge-owner' };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['scripts/mcp-wrapper.cjs'],
    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      WENTIAN_MCP_BASE_URL: `http://127.0.0.1:${port}`, WENTIAN_MCP_API_KEY: 'bridge-key' } });
  const client = new Client({ name: 'stdio相互運用検証', version: '1.0' });
  try { await client.connect(transport); assert.equal((await client.listTools()).tools.length, 12);
    assert.equal((await client.listPrompts()).prompts[0].name, 'wentian-task-plan');
  } finally { await client.close(); await app.close(); }
});
