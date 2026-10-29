import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ControlCenterAuthStore, parseCookie, sessionCookie, type PublicControlCenterUser } from './control-center-auth.js';

/** 利用者管理と本人設定を分離し、Cookie認証の変更操作には同一サイト制約を適用します。 */
export function registerUserManagement(app: FastifyInstance, store: ControlCenterAuthStore, admin: (req: FastifyRequest, reply: FastifyReply) => PublicControlCenterUser | undefined): void {
  app.register(async routes => {
    routes.addHook('preHandler', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (req.method !== 'GET' && ((req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site')) return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
    });
    routes.setErrorHandler((error, _req, reply) => reply.code(400).send({ error: { message: error instanceof Error ? error.message : '利用者の操作に失敗しました。' } }));
    routes.get('/api/control-center/users', async (req, reply) => {
      if (!admin(req, reply)) return reply;
      return store.listUsers().map(user => ({ ...user, sessions: store.sessionCount(user.id) }));
    });
    routes.get('/api/control-center/users/audit', async (req, reply) => admin(req, reply) ? { entries: store.auditLog() } : reply);
    routes.post('/api/control-center/users', async (req, reply) => {
      const actor = admin(req, reply); if (!actor) return reply;
      return reply.code(201).send(await store.createUser(req.body as Parameters<ControlCenterAuthStore['createUser']>[0], actor.id));
    });
    routes.patch('/api/control-center/users/:id', async (req, reply) => {
      const actor = admin(req, reply); if (!actor) return reply;
      return store.updateUser((req.params as { id: string }).id, req.body as Parameters<ControlCenterAuthStore['updateUser']>[1], actor.id);
    });
    routes.delete('/api/control-center/users/:id', async (req, reply) => {
      const actor = admin(req, reply); if (!actor) return reply;
      await store.deleteUser((req.params as { id: string }).id, actor.id); return reply.code(204).send();
    });
    routes.post('/api/control-center/users/:id/revoke-sessions', async (req, reply) => {
      const actor = admin(req, reply); if (!actor) return reply;
      await store.revokeSessions((req.params as { id: string }).id, actor.id); return { ok: true };
    });
    const me = (req: FastifyRequest, reply: FastifyReply) => {
      const user = store.authenticate(parseCookie(req.headers.cookie, 'wentian_session'));
      if (!user) reply.code(401).send({ error: { message: 'ログインが必要です。' } });
      return user;
    };
    routes.get('/api/control-center/profile', async (req, reply) => { const user = me(req, reply); return user ? { user, sessions: store.sessionCount(user.id) } : reply; });
    routes.patch('/api/control-center/profile', async (req, reply) => {
      const user = me(req, reply); if (!user) return reply;
      const body = req.body as Record<string, unknown>;
      if (!body || Object.keys(body).some(key => !['username', 'displayName', 'currentPassword', 'password'].includes(key))) throw new Error('本人設定にはユーザー名・表示名・パスワードだけを指定できます。');
      const changed = await store.updateProfile(user.id, body);
      reply.header('set-cookie', sessionCookie('', 0, req.protocol === 'https')); return { user: changed, loginRequired: true };
    });
    routes.post('/api/control-center/profile/revoke-sessions', async (req, reply) => {
      const user = me(req, reply); if (!user) return reply;
      await store.revokeSessions(user.id, user.id); reply.header('set-cookie', sessionCookie('', 0, req.protocol === 'https')); return { ok: true };
    });
  });
}
