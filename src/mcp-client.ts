import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Ajv } from 'ajv';
import { ResourceUpdatedNotificationSchema, ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema, PromptListChangedNotificationSchema, ListRootsRequestSchema, CreateMessageRequestSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';
import { dirname, resolve, relative, isAbsolute } from 'node:path';

/** 管理者が明示した許可だけを採用し、接続先の注釈から権限を推測しません。 */
export interface McpClientConfig {
  id: string; name?: string; enabled?: boolean;
  transport: 'http' | 'stdio'; url?: string; command?: string; args?: string[];
  cwd?: string; allowOutsideWorkspace?: boolean;
  env?: Record<string, string>; headers?: Record<string, string>;
  allowedTools: string[]; readOnlyTools?: string[]; timeoutMs?: number; roots?: Array<{ uri: string; name?: string }>;
}
export interface McpClientContext { subject: string; admin?: boolean; approvalToken?: string; signal?: AbortSignal }
export interface McpClientOptions {
  configPath: string; auditPath?: string; workspaceRoot?: string;
  authProvider?: (id: string) => OAuthClientProvider | undefined;
  samplingHandler?: (id: string, params: any, context: { signal: AbortSignal }) => Promise<any>;
  elicitationHandler?: (id: string, params: any, context: { signal: AbortSignal }) => Promise<any>;
}
type Connection = { client: Client; transport: StreamableHTTPClientTransport | StdioClientTransport; tools: Map<string, any>; controller: AbortController; pending: number; notifications: Array<{ method: string; time: string; params: unknown }> };
const operations = new Set(['tools/list', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get', 'completion/complete', 'resources/subscribe', 'resources/unsubscribe', 'logging/setLevel', 'ping']);

/** SDKの初期化失敗時の非同期closeも同じ終了処理へ合流させ、プロセス終了を待ちます。 */
class ManagedStdioTransport extends StdioClientTransport {
  private closing?: Promise<void>;
  override close(): Promise<void> { return this.closing ??= super.close(); }
}
/** 初期化失敗を含め、HTTPセッションを削除してからストリームを終了します。 */
class ManagedHttpTransport extends StreamableHTTPClientTransport {
  private closing?: Promise<void>;
  override close(): Promise<void> {
    return this.closing ??= (async () => { await this.terminateSession().catch(() => {}); await super.close(); })();
  }
}
/** タイムアウトは応答ヘッダー受信までです。常時接続のSSE本文を時間で切断しません。 */
function boundedFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }); }
    finally { clearTimeout(timeout); }
  };
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** 設定に秘密そのものを格納せず、環境変数の名前だけを保持します。 */
function environment(refs: Record<string, string> = {}): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, ref] of Object.entries(refs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('環境変数参照が不正です。');
    if (process.env[ref] === undefined) throw new Error('必要な環境変数が未設定です。');
    result[key] = process.env[ref]!;
  }
  return result;
}

export class McpClientManager {
  private configs = new Map<string, McpClientConfig>();
  private connections = new Map<string, Connection>();
  private connecting = new Map<string, Promise<void>>();
  private openingControllers = new Map<string, AbortController>();
  private approvals = new Map<string, { subject: string; id: string; tool: string; digest: string; expires: number }>();
  private persistence = Promise.resolve();
  private ajv = new Ajv({ strict: false, allErrors: true });
  constructor(private readonly options: McpClientOptions) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.options.configPath, 'utf8'));
      if (!Array.isArray(data.servers)) throw new Error('MCP接続設定が不正です。');
      const next = new Map<string, McpClientConfig>();
      for (const item of data.servers) { this.validate(item); if (next.has(item.id)) throw new Error('接続IDが重複しています。'); next.set(item.id, item); }
      this.configs = next;
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  private validate(c: McpClientConfig): void {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) || !['http', 'stdio'].includes(c.transport)) throw new Error('MCP接続設定が不正です。');
    const fields = new Set(['id', 'name', 'enabled', 'transport', 'url', 'command', 'args', 'cwd', 'allowOutsideWorkspace', 'env', 'headers', 'allowedTools', 'readOnlyTools', 'timeoutMs', 'roots']);
    if (Object.keys(c).some(key => !fields.has(key)) || (c.name !== undefined && typeof c.name !== 'string') || (c.enabled !== undefined && typeof c.enabled !== 'boolean') || (c.allowOutsideWorkspace !== undefined && typeof c.allowOutsideWorkspace !== 'boolean')) throw new Error('未知または不正なMCP設定項目があります。');
    if (c.roots !== undefined && !Array.isArray(c.roots)) throw new Error('ルート設定が不正です。');
    if (c.args !== undefined && !Array.isArray(c.args)) throw new Error('引数一覧が不正です。');
    if ((c.name?.length ?? 0) > 200 || (c.args?.length ?? 0) > 100 || c.args?.some(v => typeof v !== 'string' || v.length > 8192)) throw new Error('設定項目が上限を超えました。');
    for (const values of [c.allowedTools, c.readOnlyTools ?? []]) if (!Array.isArray(values) || values.length > 1000 || values.some(v => typeof v !== 'string' || !v || v === '*' || v.length > 300)) throw new Error('ツール名は明示的に指定してください。');
    if (c.readOnlyTools?.some(t => !c.allowedTools.includes(t))) throw new Error('読み取り専用ツールも許可一覧に必要です。');
    if (c.timeoutMs !== undefined && (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 300_000)) throw new Error('タイムアウトが不正です。');
    if (c.transport === 'http') {
      const url = new URL(c.url ?? '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('URLに認証情報やクエリーを指定できません。');
    } else {
      if (!c.command || /[\r\n]/.test(c.command) || (c.args && (!Array.isArray(c.args) || c.args.some(v => typeof v !== 'string')))) throw new Error('起動コマンドが不正です。');
      const root = resolve(this.options.workspaceRoot ?? process.cwd());
      const cwd = resolve(c.cwd ?? root); const rel = relative(root, cwd);
      if (!c.allowOutsideWorkspace && (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))) throw new Error('作業領域外の起動には明示許可が必要です。');
    }
    for (const refs of [c.env ?? {}, c.headers ?? {}]) {
      if (typeof refs !== 'object' || Array.isArray(refs) || Object.keys(refs).length > 100) throw new Error('環境変数参照が不正です。');
      for (const [key, ref] of Object.entries(refs)) if (!key || /[\r\n]/.test(key) || typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('環境変数参照が不正です。');
    }
    for (const root of c.roots ?? []) {
      if (!root.uri.startsWith('file://')) throw new Error('ルートはファイルURIで指定してください。');
      const rel = relative(resolve(this.options.workspaceRoot ?? process.cwd()), fileURLToPath(root.uri));
      if (!c.allowOutsideWorkspace && (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel))) throw new Error('作業領域外のルートには明示許可が必要です。');
    }
  }
  private async save(): Promise<void> {
    const content = JSON.stringify({ version: 1, servers: [...this.configs.values()] }, null, 2);
    const task = this.persistence.then(async () => {
      await mkdir(dirname(this.options.configPath), { recursive: true });
      const tmp = `${this.options.configPath}.${randomUUID()}.tmp`;
      try { await writeFile(tmp, content, { mode: 0o600 }); await renameWithRetry(tmp, this.options.configPath); }
      finally { await rm(tmp, { force: true }).catch(() => {}); }
    });
    this.persistence = task.catch(() => {}); await task;
  }
  async register(config: McpClientConfig): Promise<void> { this.validate(config); await this.disconnect(config.id); const previous = this.configs.get(config.id); this.configs.set(config.id, structuredClone(config)); try { await this.save(); } catch (error) { if (previous) this.configs.set(config.id, previous); else this.configs.delete(config.id); throw error; } }
  async remove(id: string): Promise<void> { await this.disconnect(id); const previous = this.configs.get(id); this.configs.delete(id); try { await this.save(); } catch (error) { if (previous) this.configs.set(id, previous); throw error; } }
  list() { return [...this.configs.values()].map(c => ({ ...structuredClone(c), connected: this.connections.has(c.id), pending: this.connections.get(c.id)?.pending ?? 0 })); }
  private config(id: string) { const c = this.configs.get(id); if (!c) throw new Error('MCP接続が登録されていません。'); return c; }
  async connect(id: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.connections.has(id)) return;
    if (this.connecting.has(id)) return this.connecting.get(id);
    const controller = new AbortController(); this.openingControllers.set(id, controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const task = this.open(id, controller); this.connecting.set(id, task);
    try { await task; } finally { signal?.removeEventListener('abort', abort); this.connecting.delete(id); this.openingControllers.delete(id); }
  }
  private async open(id: string, controller: AbortController): Promise<void> {
    const c = this.config(id); if (c.enabled === false) throw new Error('MCP接続は無効です。');
    const client = new Client({ name: 'wentian', version: '0.6.0' }, { capabilities: {
      ...(c.roots ? { roots: { listChanged: false } } : {}),
      ...(this.options.samplingHandler ? { sampling: {} } : {}),
      ...(this.options.elicitationHandler ? { elicitation: { form: {} } } : {}),
    } });
    if (c.roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: c.roots! }));
    // 逆方向のLLM実行や人間への質問は、ホストが明示提供したハンドラーだけで実行します。
    if (this.options.samplingHandler) client.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => this.options.samplingHandler!(id, request.params, { signal: AbortSignal.any([controller.signal, extra.signal]) }));
    if (this.options.elicitationHandler) client.setRequestHandler(ElicitRequestSchema, async (request, extra) => this.options.elicitationHandler!(id, request.params, { signal: AbortSignal.any([controller.signal, extra.signal]) }));
    const transport = c.transport === 'http'
      ? new ManagedHttpTransport(new URL(c.url!), { requestInit: { headers: environment(c.headers) }, authProvider: this.options.authProvider?.(id), fetch: boundedFetch(c.timeoutMs ?? 30_000) })
      : new ManagedStdioTransport({ command: c.command!, args: c.args, cwd: resolve(c.cwd ?? this.options.workspaceRoot ?? process.cwd()), env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].includes(key))) as Record<string,string>, ...environment(c.env) }, stderr: 'ignore' });
    const connection: Connection = { client, transport, tools: new Map(), controller, pending: 0, notifications: [] };
    for (const schema of [ResourceUpdatedNotificationSchema, ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema, PromptListChangedNotificationSchema]) {
      client.setNotificationHandler(schema, async notification => {
        connection.notifications.push({ method: notification.method, time: new Date().toISOString(), params: notification.params ?? {} });
        if (connection.notifications.length > 100) connection.notifications.shift();
        if (notification.method === 'notifications/tools/list_changed' && this.connections.get(id) === connection) await this.refreshTools(id).catch(() => {});
      });
    }
    client.onclose = () => { connection.controller.abort(); if (this.connections.get(id) === connection) this.connections.delete(id); };
    client.onerror = () => {}; // 通信エラーに認証情報が含まれる可能性があるため、そのまま出力しません。
    try {
      await client.connect(transport, { timeout: c.timeoutMs ?? 30_000, signal: controller.signal });
      if (controller.signal.aborted) throw new Error('接続が中断されました。');
      this.connections.set(id, connection);
      if (client.getServerCapabilities()?.tools) await this.refreshTools(id);
    } catch { await transport.close().catch(() => {}); await client.close().catch(() => {}); this.connections.delete(id); throw new Error('MCP接続に失敗しました。接続先と認証設定を確認してください。'); }
  }
  async disconnect(id: string): Promise<void> {
    this.openingControllers.get(id)?.abort();
    const pending = this.connecting.get(id); if (pending) await pending.catch(() => {});
    const conn = this.connections.get(id); this.connections.delete(id);
    if (conn) { conn.controller.abort(); await conn.transport.close(); await conn.client.close(); }
    for (const [token, approval] of this.approvals) if (approval.id === id) this.approvals.delete(token);
  }
  async reconnect(id: string, signal?: AbortSignal): Promise<void> { await this.disconnect(id); await this.connect(id, signal); }
  async close(): Promise<void> { await Promise.all([...new Set([...this.connections.keys(), ...this.connecting.keys()])].map(id => this.disconnect(id))); }
  async refreshTools(id: string) {
    const conn = this.connections.get(id); if (!conn) throw new Error('MCP接続がありません。');
    const tools: any[] = []; let cursor: string | undefined; const cursors = new Set<string>();
    do { const result = await conn.client.listTools(cursor ? { cursor } : {}, { timeout: this.config(id).timeoutMs ?? 30_000, signal: conn.controller.signal }); tools.push(...result.tools); cursor = result.nextCursor; if (tools.length > 10_000 || (cursor && cursors.has(cursor)) || cursors.size > 1000) throw new Error('ツール一覧が上限を超えました。'); if (cursor) cursors.add(cursor); } while (cursor);
    conn.tools = new Map(tools.map(t => [t.name, t])); return tools;
  }
  approve(id: string, tool: string, args: Record<string, unknown>, context: McpClientContext): string {
    if (!context.admin || !context.subject) throw new Error('承認には管理者権限が必要です。');
    if (!this.config(id).allowedTools.includes(tool)) throw new Error('ツールが許可されていません。');
    for (const [token, approval] of this.approvals) if (approval.expires < Date.now()) this.approvals.delete(token);
    if (this.approvals.size >= 1000) throw new Error('承認待ち件数が上限に達しました。');
    const token = randomUUID(); this.approvals.set(token, { subject: context.subject, id, tool, digest: digest(args), expires: Date.now() + 60_000 }); return token;
  }
  async callTool(id: string, name: string, args: Record<string, unknown>, context: McpClientContext) {
    let c = this.config(id);
    if (!context.subject || !c.allowedTools.includes(name)) throw new Error('ツールが許可されていません。');
    await this.connect(id, context.signal); c = this.config(id);
    if (c.enabled === false || !c.allowedTools.includes(name)) throw new Error('ツールの許可が取り消されています。');
    const conn = this.connections.get(id); if (!conn) throw new Error('MCP接続が中断されました。'); const tool = conn.tools.get(name);
    if (!tool) throw new Error('ツールが存在しません。');
    let valid = false;
    try { if (!tool.inputSchema?.$async) valid = this.ajv.compile(tool.inputSchema)(args) === true; } catch { /* 外部スキーマの詳細や参照先をエラーへ含めません。 */ }
    if (!valid) throw new Error('ツール引数が入力スキーマに一致しません。');
    if (!c.readOnlyTools?.includes(name)) {
      const approval = this.approvals.get(context.approvalToken ?? '');
      if (!approval || approval.subject !== context.subject || approval.id !== id || approval.tool !== name || approval.digest !== digest(args) || approval.expires < Date.now()) throw new Error('この操作には本人による明示承認が必要です。');
      this.approvals.delete(context.approvalToken!);
    }
    conn.pending++;
    try { const result = await conn.client.callTool({ name, arguments: args }, undefined, { timeout: c.timeoutMs ?? 30_000, signal: context.signal ? AbortSignal.any([conn.controller.signal, context.signal]) : conn.controller.signal }); await this.audit(id, 'tools/call', context.subject, name, !result.isError); return result; }
    catch { await this.audit(id, 'tools/call', context.subject, name, false); throw new Error('MCPツール実行に失敗しました。'); }
    finally { conn.pending--; }
  }
  async request(id: string, operation: string, params: any = {}, context: McpClientContext) {
    if (!context.subject || !operations.has(operation)) throw new Error('MCP操作が許可されていません。');
    await this.connect(id, context.signal); const conn = this.connections.get(id); if (!conn || this.config(id).enabled === false) throw new Error('MCP接続が中断されました。'); const opts = { timeout: this.config(id).timeoutMs ?? 30_000, signal: context.signal ? AbortSignal.any([conn.controller.signal, context.signal]) : conn.controller.signal };
    conn.pending++;
    try {
      let result: unknown;
      switch (operation) {
        case 'tools/list': result = { tools: (await this.refreshTools(id)).filter(t => context.admin || this.config(id).allowedTools.includes(t.name)) }; break;
        case 'resources/list': result = await conn.client.listResources(params, opts); break;
        case 'resources/read': result = await conn.client.readResource(params, opts); break;
        case 'resources/templates/list': result = await conn.client.listResourceTemplates(params, opts); break;
        case 'prompts/list': result = await conn.client.listPrompts(params, opts); break;
        case 'prompts/get': result = await conn.client.getPrompt(params, opts); break;
        case 'completion/complete': result = await conn.client.complete(params, opts); break;
        case 'resources/subscribe': result = await conn.client.subscribeResource(params, opts); break;
        case 'resources/unsubscribe': result = await conn.client.unsubscribeResource(params, opts); break;
        case 'logging/setLevel': result = await conn.client.setLoggingLevel(params.level, opts); break;
        case 'ping': result = await conn.client.ping(opts); break;
      }
      await this.audit(id, operation, context.subject, undefined, true); return result;
    } catch { await this.audit(id, operation, context.subject, undefined, false); throw new Error('MCP操作に失敗しました。'); }
    finally { conn.pending--; }
  }
  notifications(id: string) { return structuredClone(this.connections.get(id)?.notifications ?? []); }
  private async audit(id: string, operation: string, subject: string, tool: string | undefined, ok: boolean) {
    if (!this.options.auditPath) return;
    await mkdir(dirname(this.options.auditPath), { recursive: true });
    // 引数・応答・URL・認証ヘッダーは監査記録へ格納しません。
    await appendFile(this.options.auditPath, JSON.stringify({ time: new Date().toISOString(), id, operation, subject, tool, ok }) + '\n', { mode: 0o600 });
  }
}
