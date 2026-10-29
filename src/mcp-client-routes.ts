import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { McpClientManager, McpClientConfig } from './mcp-client.js';

export interface McpClientRouteOptions {
  manager: McpClientManager;
  authorizeAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean | Promise<boolean>;
  identity: (req: FastifyRequest) => { id: string } | undefined | Promise<{ id: string } | undefined>;
}

/** 管理 API は登録も読み取りも管理者限定です。主体は認証側から取得し、本文の userId は信用しません。 */
export function registerMcpClientRoutes(app: FastifyInstance, options: McpClientRouteOptions): void {
  app.register(async routes => {
    routes.addHook('preHandler', async (req, reply) => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) {
        return reply.code(403).send({ error: { code: 'origin_forbidden', message: '同一オリジンから操作してください。' } });
      }
      if (!await options.authorizeAdmin(req, reply) && !reply.sent) return reply.code(403).send({ error: { code: 'admin_required', message: '管理者権限が必要です。' } });
    });
    const perform = async (req: FastifyRequest, reply: FastifyReply, work: (subject: string, signal: AbortSignal) => unknown | Promise<unknown>) => {
      const identity = await options.identity(req);
      if (!identity?.id) return reply.code(401).send({ error: { code: 'identity_required', message: '認証済みの本人情報が必要です。' } });
      // HTTP接続が閉じた後も外部処理だけが残らないよう、操作単位の中断を伝えます。
      const controller = new AbortController();
      const aborted = () => controller.abort();
      const closed = () => { if (!reply.raw.writableEnded) controller.abort(); };
      req.raw.once('aborted', aborted); reply.raw.once('close', closed);
      if (req.raw.aborted || reply.raw.destroyed) controller.abort();
      try { return await work(identity.id, controller.signal); }
      catch { return reply.code(400).send({ error: { code: 'mcp_operation_failed', message: 'MCP操作に失敗しました。登録設定・許可・接続・承認期限・入力形式を確認してください。' } }); }
      finally { req.raw.off('aborted', aborted); reply.raw.off('close', closed); }
    };
    const id = (req: FastifyRequest) => (req.params as { id: string }).id;
    const body = (req: FastifyRequest): Record<string, any> => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, any>;
    routes.get('/api/mcp/servers', (req, reply) => perform(req, reply, () => ({ servers: options.manager.list() })));
    routes.get('/api/mcp/agent-tools', (req, reply) => perform(req, reply, async (subject, signal) => {
      const tools: unknown[] = [], errors: Array<{ serverId: string; message: string }> = [];
      for (const config of options.manager.list().filter(c => c.enabled !== false && c.readOnlyTools?.length)) {
        signal.throwIfAborted();
        try {
          const result = await options.manager.request(config.id, 'tools/list', {}, { subject, admin: true, signal }) as { tools: any[] };
          for (const tool of result.tools.filter(t => config.readOnlyTools!.includes(t.name) && config.allowedTools.includes(t.name))) tools.push({ serverId: config.id, name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
        } catch { signal.throwIfAborted(); errors.push({ serverId: config.id, message: 'MCP接続先のツール取得に失敗しました。' }); }
      }
      return { tools, errors };
    }));
    routes.post('/api/mcp/agent-call', (req, reply) => perform(req, reply, (subject, signal) => {
      const input = body(req), config = options.manager.list().find(c => c.id === input.serverId);
      // エージェント経由では承認トークンがあっても変更ツールを認めません。
      if (!config?.readOnlyTools?.includes(input.name) || !config.allowedTools.includes(input.name)) return reply.code(403).send({ error: { code: 'read_only_tool_required', message: '自動実行は明示許可済みの読み取りツールだけです。' } });
      return options.manager.callTool(input.serverId, input.name, input.arguments ?? {}, { subject, admin: true, signal });
    }));
    routes.post('/api/mcp/servers', (req, reply) => perform(req, reply, async () => { await options.manager.register(body(req) as McpClientConfig); return reply.code(201).send({ ok: true }); }));
    routes.put('/api/mcp/servers/:id', (req, reply) => perform(req, reply, async () => { await options.manager.register({ ...body(req), id: id(req) } as McpClientConfig); return { ok: true }; }));
    routes.delete('/api/mcp/servers/:id', (req, reply) => perform(req, reply, async () => { await options.manager.remove(id(req)); return { ok: true }; }));
    for (const action of ['enable', 'disable', 'connect', 'disconnect', 'reconnect'] as const) {
      routes.post(`/api/mcp/servers/:id/${action}`, (req, reply) => perform(req, reply, async (_subject, signal) => {
        if (action === 'enable' || action === 'disable') {
          const config = options.manager.list().find(c => c.id === id(req));
          if (!config) return reply.code(404).send({ error: { code: 'server_not_found', message: '接続が登録されていません。' } });
          const { connected: _connected, pending: _pending, ...stored } = config;
          await options.manager.register({ ...stored, enabled: action === 'enable' });
        } else if (action === 'connect' || action === 'reconnect') await options.manager[action](id(req), signal);
        else await options.manager.disconnect(id(req));
        return { ok: true };
      }));
    }
    routes.get('/api/mcp/servers/:id/notifications', (req, reply) => perform(req, reply, () => ({ notifications: options.manager.notifications(id(req)) })));
    routes.post('/api/mcp/servers/:id/request', (req, reply) => perform(req, reply, (subject, signal) => options.manager.request(id(req), body(req).operation, body(req).params ?? {}, { subject, admin: true, signal })));
    routes.post('/api/mcp/servers/:id/approve', (req, reply) => perform(req, reply, subject => ({ approvalToken: options.manager.approve(id(req), body(req).name, body(req).arguments ?? {}, { subject, admin: true }), expiresInSeconds: 60 })));
    routes.post('/api/mcp/servers/:id/call', (req, reply) => perform(req, reply, (subject, signal) => options.manager.callTool(id(req), body(req).name, body(req).arguments ?? {}, { subject, admin: true, signal, approvalToken: body(req).approvalToken })));
    for (const operation of ['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list', 'ping']) {
      routes.get(`/api/mcp/servers/:id/${operation.replaceAll('/', '-')}`, (req, reply) => perform(req, reply, (subject, signal) => options.manager.request(id(req), operation, req.query ?? {}, { subject, admin: true, signal })));
    }
  });
}
