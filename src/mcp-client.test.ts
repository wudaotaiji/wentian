import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ListResourceTemplatesRequestSchema, CompleteRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClientManager } from './mcp-client.js';

test('設定の永続化・秘密参照・領域と明示許可を検証する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wentian-mcp-'));
  try {
    const options = { configPath: join(dir, 'config.json'), workspaceRoot: dir };
    const manager = new McpClientManager(options);
    await manager.register({ id: 'one', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'MY_MCP_SECRET' }, allowedTools: ['read'], readOnlyTools: ['read'] });
    const other = new McpClientManager(options); await other.load();
    assert.equal(other.list()[0].headers?.Authorization, 'MY_MCP_SECRET');
    await assert.rejects(manager.register({ id: 'bad', transport: 'http', url: 'https://user:secret@example.com/mcp', allowedTools: [] }));
    await assert.rejects(manager.register({ id: 'bad', transport: 'stdio', command: 'node', cwd: tmpdir(), allowedTools: [] }));
    await assert.rejects(manager.register({ id: 'bad', transport: 'http', url: 'https://example.com', allowedTools: ['*'] }));
    await assert.rejects(manager.register({ id: 'bad', transport: 'http', url: 'https://example.com', allowedTools: [], apiKey: 'not-persisted' } as any));
    await assert.rejects(manager.register({ id: 'bad', transport: 'http', url: 'https://example.com', allowedTools: [], enabled: 'yes' } as any));
    await writeFile(join(dir, 'blocked'), 'file');
    const failing = new McpClientManager({ configPath: join(dir, 'blocked', 'config.json') });
    await assert.rejects(failing.register({ id: 'rollback', transport: 'http', url: 'https://example.com', allowedTools: [] })); assert.deepEqual(failing.list(), []);
    await other.remove('one'); assert.deepEqual(other.list(), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stdio接続でシェルを使わずSDK初期化・再接続・終了を確認する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wentian-mcp-'));
  // テスト専用の子プロセスは標準出力をMCPプロトコルだけに使用します。
  const script = join(dir, 'fixture.mjs');
  const moduleRoot = join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk/dist/esm');
  await writeFile(script, `import {Server} from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'server/index.js')).href)};
import {StdioServerTransport} from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'server/stdio.js')).href)};
import {ListToolsRequestSchema} from ${JSON.stringify(pathToFileURL(join(moduleRoot, 'types.js')).href)};
const server=new Server({name:'stdio-fixture',version:'1'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:process.env.WENTIAN_MCP_PRIVATE_LEAK?[{name:'leaked',inputSchema:{type:'object'}}]:[]}));
await server.connect(new StdioServerTransport());`);
  const manager = new McpClientManager({ configPath: join(dir, 'config.json'), workspaceRoot: dir });
  const previous = process.env.WENTIAN_MCP_PRIVATE_LEAK; process.env.WENTIAN_MCP_PRIVATE_LEAK = 'private';
  try {
    await manager.register({ id: 'stdio', transport: 'stdio', command: process.execPath, args: [script], cwd: dir, allowedTools: [], timeoutMs: 5000 });
    await manager.connect('stdio'); assert.equal(manager.list()[0].connected, true);
    assert.deepEqual(await manager.request('stdio', 'tools/list', {}, { subject: 'operator', admin: true }), { tools: [] });
    await manager.reconnect('stdio'); assert.equal(manager.list()[0].connected, true);
    await manager.request('stdio', 'ping', {}, { subject: 'operator' });
    await manager.close(); assert.equal(manager.list()[0].connected, false);
    await manager.register({ id: 'stdio', transport: 'stdio', command: process.execPath, args: [script], cwd: dir, allowedTools: [], enabled: false });
    await assert.rejects(manager.connect('stdio'), /無効/);
  } finally { if (previous === undefined) delete process.env.WENTIAN_MCP_PRIVATE_LEAK; else process.env.WENTIAN_MCP_PRIVATE_LEAK = previous; await manager.close(); await rm(dir, { recursive: true, force: true }); }
});

test('公式SDK接続でツール・資料・プロンプト・主体別単発承認を検証する', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wentian-mcp-'));
  const sdk = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {}, resources: { subscribe: true }, prompts: {}, completions: {} } });
  let calls = 0;
  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['read', 'write', 'slow'].map(name => ({ name, inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: true } })) }));
  sdk.setRequestHandler(CallToolRequestSchema, async request => { if (request.params.name === 'slow') await new Promise(resolve => setTimeout(resolve, 120)); else calls++; return { content: [{ type: 'text', text: String(request.params.arguments?.value) }], ...(request.params.arguments?.value === 'tool-error' ? { isError: true } : {}) }; });
  sdk.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'fixture://doc', name: 'doc' }] }));
  sdk.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: 'fixture://doc', text: '資料' }] }));
  sdk.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'review' }] }));
  sdk.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'レビュー' } }] }));
  sdk.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: 'fixture://{name}', name: 'doc' }] }));
  sdk.setRequestHandler(CompleteRequestSchema, async () => ({ completion: { values: ['doc'], hasMore: false } }));
  sdk.setRequestHandler(SubscribeRequestSchema, async () => ({}));
  sdk.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'fixture-session' });
  await sdk.connect(transport);
  let getStreams = 0; let deletes = 0;
  const http = createServer((request, response) => { if (request.method === 'GET') getStreams++; if (request.method === 'DELETE') deletes++; void transport.handleRequest(request, response); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const manager = new McpClientManager({ configPath: join(dir, 'config.json'), auditPath: join(dir, 'audit.jsonl'), workspaceRoot: dir,
    samplingHandler: async (_id, _params) => ({ role: 'assistant', content: { type: 'text', text: 'sampling-result' }, model: 'fixture-model' }),
    elicitationHandler: async (_id, _params) => ({ action: 'accept', content: { confirm: true } }),
  });
  try {
    // 全体テスト時のプロセス起動・CPU競合を考慮し、成功する通信には10秒の余裕を持たせます。
    const requestTimeoutMs = 10_000;
    await manager.register({ id: 'fixture', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, allowedTools: ['read', 'write', 'slow'], readOnlyTools: ['read', 'slow'], timeoutMs: requestTimeoutMs, roots: [{ uri: pathToFileURL(dir).href, name: 'fixture-root' }] });
    await manager.connect('fixture'); assert.equal(manager.list()[0].connected, true);
    assert.equal((await sdk.listRoots()).roots[0].uri, pathToFileURL(dir).href);
    assert.equal((await sdk.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }], maxTokens: 10 })).content.type, 'text');
    assert.equal((await sdk.elicitInput({ message: 'Confirm', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } } })).action, 'accept');
    await manager.callTool('fixture', 'read', { value: 'secret-data' }, { subject: 'a' });
    await assert.rejects(manager.callTool('fixture', 'read', { value: 5 }, { subject: 'a' }), /スキーマ/);
    await assert.rejects(manager.callTool('fixture', 'write', { value: 'x' }, { subject: 'a' }), /承認/);
    const approvalToken = manager.approve('fixture', 'write', { value: 'x' }, { subject: 'a', admin: true });
    await assert.rejects(manager.callTool('fixture', 'write', { value: 'different' }, { subject: 'a', approvalToken }), /承認/);
    await assert.rejects(manager.callTool('fixture', 'write', { value: 'x' }, { subject: 'b', approvalToken }), /承認/);
    await manager.callTool('fixture', 'write', { value: 'x' }, { subject: 'a', approvalToken });
    await assert.rejects(manager.callTool('fixture', 'write', { value: 'x' }, { subject: 'a', approvalToken }), /承認/);
    const expiredToken = manager.approve('fixture', 'write', { value: 'x' }, { subject: 'a', admin: true });
    const actualNow = Date.now; Date.now = () => actualNow() + 61_000;
    try { await assert.rejects(manager.callTool('fixture', 'write', { value: 'x' }, { subject: 'a', approvalToken: expiredToken }), /承認/); } finally { Date.now = actualNow; }
    assert.equal(calls, 2);
    assert.equal((await manager.request('fixture', 'resources/read', { uri: 'fixture://doc' }, { subject: 'a' }) as any).contents[0].text, '資料');
    assert.equal((await manager.request('fixture', 'prompts/get', { name: 'review' }, { subject: 'a' }) as any).messages.length, 1);
    assert.equal((await manager.request('fixture', 'tools/list', {}, { subject: 'a' }) as any).tools.length, 3);
    assert.equal((await manager.request('fixture', 'resources/templates/list', {}, { subject: 'a' }) as any).resourceTemplates.length, 1);
    assert.deepEqual((await manager.request('fixture', 'completion/complete', { ref: { type: 'ref/prompt', name: 'review' }, argument: { name: 'name', value: 'd' } }, { subject: 'a' }) as any).completion.values, ['doc']);
    await manager.request('fixture', 'resources/subscribe', { uri: 'fixture://doc' }, { subject: 'a' });
    // 通常リクエストの期限を過ぎても通知SSEは維持され、不要な再接続を起こしません。
    await new Promise(resolve => setTimeout(resolve, requestTimeoutMs + 100));
    await sdk.notification({ method: 'notifications/resources/updated', params: { uri: 'fixture://doc' } });
    const notificationDeadline = Date.now() + 5000;
    while (manager.notifications('fixture').length === 0 && Date.now() < notificationDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(manager.notifications('fixture')[0].method, 'notifications/resources/updated');
    assert.equal(getStreams, 1);
    await manager.request('fixture', 'resources/unsubscribe', { uri: 'fixture://doc' }, { subject: 'a' });
    const controller = new AbortController();
    const cancelled = manager.callTool('fixture', 'slow', { value: 'x' }, { subject: 'a', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(cancelled, /失敗/); assert.equal(manager.list()[0].pending, 0);
    const toolError = await manager.callTool('fixture', 'read', { value: 'tool-error' }, { subject: 'a' }); assert.equal(toolError.isError, true);
    const audit = await readFile(join(dir, 'audit.jsonl'), 'utf8'); assert.ok(!audit.includes('secret-data')); assert.ok(!audit.includes('127.0.0.1'));
    assert.equal(JSON.parse(audit.trim().split('\n').at(-1)!).ok, false);
    await manager.disconnect('fixture'); assert.equal(manager.list()[0].connected, false);
    assert.equal(deletes, 1);
  } finally {
    await manager.close(); await sdk.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
});

test('初期化中のcloseで接続を中断し、遅延接続を残さない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wentian-mcp-'));
  const http = createServer((_request, _response) => {});
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const manager = new McpClientManager({ configPath: join(dir, 'config.json') });
  try {
    await manager.register({ id: 'hang', transport: 'http', url: `http://127.0.0.1:${(http.address() as any).port}/mcp`, allowedTools: [], timeoutMs: 1000 });
    const started = manager.connect('hang').catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 20)); await manager.close();
    assert.ok(await started instanceof Error); assert.equal(manager.list()[0].connected, false);
  } finally { await manager.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('stdio初期化失敗の完了時には子プロセスが終了している', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wentian-mcp-'));
  const script = join(dir, 'hang.mjs'); const pidPath = join(dir, 'pid.txt');
  // 応答しないテスト用プロセスで、SDKの非同期closeも最後まで待つことを検証します。
  await writeFile(script, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`);
  const manager = new McpClientManager({ configPath: join(dir, 'config.json'), workspaceRoot: dir });
  try {
    await manager.register({ id: 'hang', transport: 'stdio', command: process.execPath, args: [script], cwd: dir, allowedTools: [], timeoutMs: 500 });
    await assert.rejects(manager.connect('hang'), /接続に失敗/);
    const pid = Number(await readFile(pidPath, 'utf8'));
    assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH');
    assert.equal(manager.list()[0].connected, false);
  } finally { await manager.close(); await rm(dir, { recursive: true, force: true }); }
});
