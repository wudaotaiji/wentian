import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema,
  ListResourceTemplatesRequestSchema, CompleteRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CommonTaskService } from './common-task-foundation.js';
import type { AuthContext, FastifyApp, FastifyRequest, MCPTaskAdapter } from './mcp-task-adapter.js';

/** 公式SDKにプロトコル交渉・通知・ストリーム・キャンセルを任せ、業務処理だけ既存サービスへ委譲します。 */
export function createMcpServer(adapter: MCPTaskAdapter, service: CommonTaskService, owner: AuthContext): Server {
  const server = new Server({ name: 'wentian-gateway', version: '0.6.0' },
    { capabilities: { tools: {}, resources: { listChanged: true, subscribe: true }, prompts: {}, logging: {}, completions: {} } });
  const subscribed = new Map<string, string>();
  // 購読対象だけを監視し、非同期ワーカーから更新された状態も標準通知で配信します。
  const watch = setInterval(() => {
    for (const [uri, previous] of subscribed) {
      void service.getTask(owner.ownerId, decodeURIComponent(uri.slice('wentian://tasks/'.length))).then(task => {
        const current = JSON.stringify(task);
        if (current !== previous) { subscribed.set(uri, current); return server.sendResourceUpdated({ uri }); }
      }).catch(() => { subscribed.delete(uri); });
    }
  }, 1000);
  watch.unref(); server.onclose = () => { clearInterval(watch); subscribed.clear(); };
  server.setRequestHandler(SubscribeRequestSchema, async request => {
    if (!/^wentian:\/\/tasks\/[^/]+$/.test(request.params.uri)) throw new Error('対応していないリソースURIです。');
    const task = await service.getTask(owner.ownerId, decodeURIComponent(request.params.uri.slice('wentian://tasks/'.length)));
    subscribed.set(request.params.uri, JSON.stringify(task)); return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async request => { subscribed.delete(request.params.uri); return {}; });
  server.setRequestHandler(CompleteRequestSchema, async request => {
    const values = request.params.ref.type === 'ref/resource' && request.params.argument.name === 'task_id'
      ? (await service.listTasks(owner.ownerId)).map(task => task.taskId).filter(id => id.startsWith(request.params.argument.value)) : [];
    return { completion: { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 } };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => adapter.handleToolsList() as any);
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await adapter.handleToolsCall(request.params, owner);
      // 依頼本文・認証情報・結果本文をログ通知へ載せず、ツール名と成否だけを通知します。
      await server.sendLoggingMessage({ level: 'info', logger: 'wentian-tools', data: { tool: request.params.name, status: 'completed' } }).catch(() => {});
      if (['wentian_submit_task', 'wentian_cancel_task'].includes(request.params.name)) {
        await server.sendResourceListChanged().catch(() => {});
      }
      return result as any;
    } catch (error) {
      // 業務上の失敗はプロトコルエラーではなく、クライアントが扱えるTool結果として返します。
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'ツール実行に失敗しました。' }], isError: true };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: (await service.listTasks(owner.ownerId)).map(task => ({
    uri: `wentian://tasks/${encodeURIComponent(task.taskId)}`, name: task.taskId,
    description: task.status, mimeType: 'application/json',
  })) }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{
    uriTemplate: 'wentian://tasks/{task_id}', name: 'タスク状態', mimeType: 'application/json',
  }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    const match = /^wentian:\/\/tasks\/([^/]+)$/.exec(request.params.uri);
    if (!match) throw new Error('対応していないリソースURIです。');
    const task = await service.getTask(owner.ownerId, decodeURIComponent(match[1]));
    return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(task) }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: 'wentian-task-plan',
    description: '成果物と検証条件を明確にしたタスク計画', arguments: [{ name: 'request', description: '実施したい仕事', required: true }] }] }));
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    if (request.params.name !== 'wentian-task-plan' || !request.params.arguments?.request?.trim()) throw new Error('依頼内容を指定してください。');
    return { description: 'Wentianタスク計画', messages: [{ role: 'user', content: { type: 'text',
      text: `次の依頼を実施範囲・成果物・検証条件・停止条件に整理してください。\n${request.params.arguments.request}` } }] };
  });
  return server;
}

/** セッションIDを認証済み所有者へ固定し、別主体からの再利用を拒否します。 */
export function registerMcpHttpRoutes(app: FastifyApp, adapter: MCPTaskAdapter, service: CommonTaskService,
  resolve: (req: FastifyRequest) => AuthContext, basePath: string): void {
  const base = basePath.trim().replace(/\/$/, '');
  if (base && !/^\/[a-z0-9][a-z0-9/_-]*$/i.test(base)) throw new Error('MCP Base Pathが不正です。');
  const sessions = new Map<string, { ownerId: string; transport: StreamableHTTPServerTransport; server: Server; lastUsed: number }>();
  // 放置された接続が永続的にメモリーを占有しないよう、30分無通信で終了します。
  const expiry = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.lastUsed > 30 * 60_000) {
      sessions.delete(id); void session.server.close();
    }
  }, 60_000);
  expiry.unref();
  const handler = async (req: any, reply: any) => {
    // Hostも検査し、同一Originの判定だけでは防げないDNSリバインディングを拒否します。
    const host = req.headers.host;
    const allowedHosts = (process.env.WENTIAN_MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]').split(',').map(value => value.trim()).filter(Boolean);
    let hostname: string;
    try { hostname = new URL(`http://${host}`).hostname; } catch { return reply.code(403).send({ error: 'MCP Hostが不正です。' }); }
    if (!allowedHosts.includes(hostname) && !allowedHosts.includes(String(host))) return reply.code(403).send({ error: 'MCP Hostは許可されていません。' });
    const origin = req.headers.origin;
    // ブラウザーからは同一Originか明示許可したOriginのみ受け付けます。非ブラウザーのOrigin省略は許可します。
    if (origin) {
      const allowed = (process.env.WENTIAN_MCP_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
      const own = `${req.protocol}://${req.headers.host}`;
      if (typeof origin !== 'string' || (origin !== own && !allowed.includes(origin))) return reply.code(403).send({ error: 'MCP Originは許可されていません。' });
    }
    const owner = resolve(req);
    const id = req.headers['mcp-session-id'];
    let newlyCreated = false;
    let session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (id && !session) return reply.code(404).send({ error: 'MCPセッションが存在しません。' });
    if (session && session.ownerId !== owner.ownerId) return reply.code(403).send({ error: 'MCPセッションの所有者が異なります。' });
    if (session) session.lastUsed = Date.now();
    if (!session) {
      if (req.method !== 'POST' || !isInitializeRequest(req.body)) return reply.code(400).send({ error: 'MCP initializeが必要です。' });
      if (sessions.size >= 1000) return reply.code(503).send({ error: 'MCPセッション上限に達しました。' });
      const server = createMcpServer(adapter, service, owner);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: sessionId => { sessions.set(sessionId, { ownerId: owner.ownerId, transport, server, lastUsed: Date.now() }); } });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      try { await server.connect(transport); } catch (error) { await server.close(); throw error; }
      session = { ownerId: owner.ownerId, transport, server, lastUsed: Date.now() };
      newlyCreated = true;
    }
    reply.hijack();
    try { await session.transport.handleRequest(req.raw, reply.raw, req.body); }
    catch (error) {
      if (newlyCreated) await session.server.close();
      if (!reply.raw.writableEnded) reply.raw.end();
      throw error;
    } finally {
      // SDKが不正なinitializeを拒否した場合も、未登録サーバーの購読タイマーを残しません。
      if (newlyCreated && !session.transport.sessionId) await session.server.close();
    }
  };
  app.post(`${base}/mcp`, handler); app.get(`${base}/mcp`, handler); app.delete(`${base}/mcp`, handler);
  app.addHook('onClose', async () => { clearInterval(expiry); await Promise.all([...sessions.values()].map(session => session.server.close())); sessions.clear(); });
}
