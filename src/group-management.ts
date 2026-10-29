import type { FastifyInstance, FastifyReply } from 'fastify';
import { AgentGroupStore, GroupManagementError } from './agent-group.js';

/** Workbenchの管理者ガード配下に登録する、グループ全体の管理APIです。 */
export function registerGroupManagementRoutes(routes: FastifyInstance, store: AgentGroupStore): void {
  const execute = async (reply: FastifyReply, operation: () => Promise<unknown>) => {
    reply.header('cache-control', 'no-store');
    try { return await operation(); }
    catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return reply.code(error instanceof GroupManagementError ? error.statusCode : missing ? 404 : 409).send({ error: { message: error instanceof GroupManagementError ? error.message : missing ? 'グループが見つかりません。' : '別の操作が進行中、または記録を更新できません。更新して状態を確認してください。' } });
    }
  };
  routes.get('/api/workbench/group-management', async (_req, reply) => execute(reply, async () => ({ groups: await store.managementList() })));
  routes.post('/api/workbench/group-management/:id/rename', async (req, reply) => execute(reply, async () => {
    const body = req.body as { title?: string; expectedTitle?: string };
    if (!body || typeof body.title !== 'string' || typeof body.expectedTitle !== 'string') throw new GroupManagementError('新しい名前と取得時の名前が必要です。', 400);
    await store.rename((req.params as { id: string }).id, body.title, body.expectedTitle); return { ok: true };
  }));
  routes.post('/api/workbench/group-management/:id/:action', async (req, reply) => execute(reply, async () => {
    const { id, action } = req.params as { id: string; action: string };
    if (action === 'delete') return store.archive(id);
    if (action === 'restore') { await store.restore(id); return { ok: true }; }
    if (action === 'close-all') { await store.closeAll(id); return { ok: true }; }
    if (action === 'publication') {
      const body = req.body as { published?: boolean; summary?: string; page?: string };
      if (!body || typeof body.published !== 'boolean' || typeof body.page !== 'string' || (body.summary !== undefined && typeof body.summary !== 'string')) throw new GroupManagementError('公開するページと公開状態を指定してください。', 400);
      await store.publish(id, body.published, body.summary, undefined, body.page); return { ok: true };
    }
    throw new GroupManagementError('未対応の管理操作です。', 400);
  }));
}
