import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FederationError, PEER_PATH, record, text, type Envelope } from './contracts.js';
import type { CloudFederationFactory } from './plugin.js';
import type { AIReviewOptions } from './ai-review.js';

/** 外部署名受付とローカル管理者セッションを分離し、相手鍵へ管理権限を渡しません。 */
export function registerCloudFederation(app: FastifyInstance, options: { factory: CloudFederationFactory; authorize: (req: FastifyRequest, reply: FastifyReply) => string | undefined; complete?: AIReviewOptions['complete'] }) {
  let pending: ReturnType<CloudFederationFactory['open']> | undefined;
  const service = () => pending ||= options.factory.open({ complete: options.complete }).catch(error => { pending = undefined; throw error; });
  app.addHook('onClose', async () => { if (pending) await (await pending).close(); });
  app.register(async routes => {
    routes.addHook('onRequest', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (req.headers['x-team-virtual-key'] !== undefined) return reply.code(403).send({ error: { message: 'チームキーでは操作できません。' } });
      if (req.url === PEER_PATH) {
        if (req.headers.origin) return reply.code(403).send({ error: { message: 'ノード間通信にはブラウザーのOriginを使用できません。' } });
      } else {
        if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return reply.code(403).send({ error: { message: '同一オリジンから操作してください。' } });
        const owner = options.authorize(req, reply);
        if (!owner && !reply.sent) return reply.code(401).send({ error: { message: 'ローカル所有者の認証が必要です。' } });
      }
    });
    routes.setErrorHandler((error, _req, reply) => reply.code(error instanceof FederationError ? error.statusCode : 400).send({ error: { message: error instanceof FederationError ? error.message : '分散Cloudの要求を処理できませんでした。設定と保存先を確認してください。' } }));
    routes.post(PEER_PATH, { bodyLimit: 128 * 1024 }, async req => (await service()).receive(req.body as Envelope));
    routes.get('/api/cloud-federation', async () => (await service()).snapshot());
    routes.get('/api/cloud-federation/groups/:peerId', async req => {
      const cloud = await service(), { peerId } = req.params as { peerId: string };
      if (!cloud.snapshot().peers.some(peer => peer.nodeId === peerId)) throw new FederationError('相手が登録されていません。', 404);
      const { groupIdFor } = await import('./identity.js'); return cloud.journal.store.load(groupIdFor(cloud.identity.nodeId, peerId));
    });
    routes.post('/api/cloud-federation/a2a', { bodyLimit: 8192 }, async req => { const body = record(req.body); return (await service()).runA2A(text(body.objective, 2000), text(body.sessionId, 100)); });
    routes.post('/api/cloud-federation/policy', { bodyLimit: 4096 }, async req => (await service()).policy(req.body));
    routes.post('/api/cloud-federation/peers', { bodyLimit: 8192 }, async req => (await service()).trust(req.body));
    routes.post('/api/cloud-federation/describe', { bodyLimit: 4096 }, async req => (await service()).send(text(record(req.body).peerId), { action: 'describe' }));
    routes.post('/api/cloud-federation/orders', { bodyLimit: 96 * 1024 }, async req => { const row = record(req.body); return (await service()).request(text(row.peerId), row.task, text(row.requestId, 100)); });
    routes.post('/api/cloud-federation/orders/:id/:action', { bodyLimit: 4096 }, async req => {
      const { id, action } = req.params as { id: string; action: string };
      if (action === 'reconcile') return (await service()).reconcileOutgoing(text(id));
      if (action !== 'commit' && action !== 'status' && action !== 'cancel') throw new FederationError('未対応の注文操作です。');
      return (await service()).updateOutgoing(text(id), action);
    });
  });
  return { service };
}
