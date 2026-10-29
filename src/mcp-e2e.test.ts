import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClientManager } from './mcp-client.js';
import { registerMcpClientRoutes } from './mcp-client-routes.js';
import { MCPTaskAdapter, InMemoryTaskService } from './mcp-task-adapter.js';
import { maintenancePythonCommand } from './maintenance-python.js';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** テスト子プロセスへ実ユーザーの資格情報を渡さず、プロフィール・保存先も一時領域へ固定します。 */
function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC'].includes(key))),
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    WENTIAN_INSTALL_ROOT: directory, WENTIAN_SESSION_PATH: join(directory, 'sessions'),
    WENTIAN_TRAINING_DATA_PATH: join(directory, 'training.jsonl'),
    WENTIAN_AGENT_SELECTION_CONFIG: join(directory, 'agent-selection.json'),
    WENTIAN_PLUGIN_MANIFEST: join(directory, 'plugins.json'),
    WENTIAN_AGENT_CACHE_DIR: join(directory, 'agent-cache'),
    WENTIAN_ENABLE_EXTERNAL_ORCHESTRATION: 'false' };
}

/** シェルを介さず起動し、期限切れでは子プロセスを終了して出力を回収します。 */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolveRun({ code, stdout, stderr }); });
  });
}

test('Agent CLIから管理APIと公式SDK外部サーバーを経由して許可済みMCPツールだけを実行する', { timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wentian-mcp-e2e-'));
  const sdk = new Server({ name: '読み取り専用検証', version: '1' }, { capabilities: { tools: {} } });
  let externalCalls = 0, completionCalls = 0;
  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['echo', 'unapproved-query'].map(name => ({
    name, description: name, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  })) }));
  sdk.setRequestHandler(CallToolRequestSchema, async request => {
    assert.equal(request.params.name, 'echo'); assert.equal(request.params.arguments?.query, '検証質問');
    externalCalls++; return { content: [{ type: 'text', text: 'MCPから取得した根拠: fixture-evidence-42' }] };
  });
  const sdkTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'fixture-session', enableJsonResponse: true });
  await sdk.connect(sdkTransport);
  const upstream = createServer((request, response) => { void sdkTransport.handleRequest(request, response); });
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done));
  const manager = new McpClientManager({ configPath: join(directory, 'mcp.json'), auditPath: join(directory, 'audit.jsonl'), workspaceRoot: directory });
  const gateway = Fastify();
  const adminKey = 'test-only-admin-key';
  registerMcpClientRoutes(gateway, { manager,
    authorizeAdmin: (request, reply) => {
      if (request.headers.authorization === `Bearer ${adminKey}`) return true;
      reply.code(403).send({ error: '管理者キーが必要です。' }); return false;
    }, identity: request => request.headers.authorization === `Bearer ${adminKey}` ? { id: 'fixture-admin' } : undefined });
  gateway.post('/v1/chat/completions', async request => {
    assert.equal(request.headers.authorization, `Bearer ${adminKey}`);
    const body = request.body as any;
    if (request.headers['x-wentian-decision-kind'] === 'task-plan') return { choices: [{ message: { role: 'assistant', content: JSON.stringify({
      version: '1.0', intent: 'chat', operation: 'read', language: 'ja', text: '外部の資料を確認して回答してください。', attachments: [], required_capabilities: ['text'], tools: [], delegation: { enabled: false, parallel: false, requested_agents: [], objective: '' },
    }) } }] };
    completionCalls++; assert.equal(body.model, 'fixture/model');
    const external = body.tools.filter((tool: any) => tool.function.name.startsWith('mcp_'));
    assert.equal(external.length, 1); assert.match(external[0].function.name, /^mcp_[a-f0-9]{32}$/);
    assert.ok(!JSON.stringify(body.tools).includes('unapproved-query'));
    if (completionCalls === 1) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
      id: 'call_fixture', type: 'function', function: { name: external[0].function.name, arguments: JSON.stringify({ query: '検証質問' }) },
    }] }, finish_reason: 'tool_calls' }] };
    assert.equal(completionCalls, 2);
    const toolResult = body.messages.find((message: any) => message.role === 'tool');
    assert.equal(toolResult.tool_call_id, 'call_fixture'); assert.match(toolResult.content, /fixture-evidence-42/);
    return { choices: [{ message: { role: 'assistant', content: '外部MCPの根拠 fixture-evidence-42 を確認しました。' }, finish_reason: 'stop' }] };
  });
  await gateway.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
  const headers = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };
  try {
    // プラグイン定義はコードを読み取るだけのコピーで、実環境の構成や保存先へ書き込みません。
    await writeFile(join(directory, 'plugins.json'), await readFile(join(repository, 'wentian.plugins.json')));
    assert.equal((await fetch(`${base}/api/mcp/servers`)).status, 403);
    const registered = await fetch(`${base}/api/mcp/servers`, { method: 'POST', headers, body: JSON.stringify({
      id: 'fixture', transport: 'http', url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`,
      allowedTools: ['echo'], readOnlyTools: ['echo'], timeoutMs: 5000,
    }) });
    assert.equal(registered.status, 201);
    assert.equal((await fetch(`${base}/api/mcp/servers/fixture/connect`, { method: 'POST', headers, body: '{}' })).status, 200);
    const catalog = await (await fetch(`${base}/api/mcp/agent-tools`, { headers })).json() as any;
    assert.deepEqual(catalog.tools.map((tool: any) => tool.name), ['echo']);
    assert.equal((await fetch(`${base}/api/mcp/agent-call`, { method: 'POST', headers, body: JSON.stringify({ serverId: 'fixture', name: 'unapproved-query', arguments: { query: 'x' } }) })).status, 403);
    const child = await run(process.execPath, ['--import', import.meta.resolve('tsx'), join(repository, 'src/cli.ts'), 'agent',
      '--server', base, '--execution-mode', 'direct', '--model', 'fixture/model', '--timeout-ms', '15000', '--json', '--', '外部の資料を確認して回答してください。'],
    directory, { ...isolatedEnvironment(directory), WENTIAN_API_KEY: adminKey });
    assert.equal(child.code, 0, `${child.stdout}\n${child.stderr}`);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    assert.equal(result.status, 'success'); assert.match(`${child.stdout}\n${child.stderr}`, /fixture-evidence-42/);
    assert.equal(externalCalls, 1); assert.equal(completionCalls, 2);
    const audit = await readFile(join(directory, 'audit.jsonl'), 'utf8');
    assert.ok(!audit.includes(adminKey)); assert.ok(!audit.includes('検証質問'));
  } finally {
    await manager.close(); await gateway.close(); await sdk.close(); upstream.closeAllConnections();
    await new Promise<void>(done => upstream.close(() => done())); await rm(directory, { recursive: true, force: true });
  }
});

test('PowerShellとPythonの診断スクリプトは実HTTP初期化・一覧・終了を完了する', { timeout: 45_000, skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wentian-mcp-diagnostic-'));
  const app = Fastify();
  const service = new InMemoryTaskService();
  new MCPTaskAdapter(service).registerHttpRoutes(app, request => {
    assert.equal(request.headers.authorization, 'Bearer diagnostic-key'); return { ownerId: 'diagnostic-only' };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const environment = { ...isolatedEnvironment(directory), WENTIAN_MCP_API_KEY: 'diagnostic-key', PYTHONUTF8: '1' };
  try {
    const powershell = await run(process.env.WENTIAN_TEST_PWSH || 'pwsh.exe', ['-NoProfile', '-File', join(repository, 'scripts/test-mcp.ps1'), '-BaseUrl', base], directory, environment);
    assert.equal(powershell.code, 0, powershell.stderr); assert.equal(JSON.parse(powershell.stdout).result.tools.length, 12);
    // 明示されたPythonがあれば優先し、なければWindowsの実行エイリアスを避けて導入済みPythonを使います。
    const pythonCommand = process.env.WENTIAN_TEST_PYTHON ? { executable: process.env.WENTIAN_TEST_PYTHON, args: [] as string[] } : maintenancePythonCommand();
    const python = await run(pythonCommand.executable, [...pythonCommand.args, join(repository, 'scripts/test-mcp.py'), base], directory, environment);
    assert.equal(python.code, 0, python.stderr); assert.equal(JSON.parse(python.stdout).result.tools.length, 12);
    assert.deepEqual(await service.listTasks('diagnostic-only'), []);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
