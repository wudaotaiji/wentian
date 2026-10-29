// team-access-routes.ts — チーム別利用管理の HTTP ルート（Fastify Routes）
// 接続方式（Integration Contract）:
//  - registerTeamAccessRoutes(app, { root, authorizeAdmin, identity }) をメイン Gateway の buildApp 内で1回呼ぶだけです。
//  - identity(req): ホスト側ログイン認証（例: Control Center セッション）が確定させた本人 identity だけを返します。
//    ルートは要求本文（Body）・Query・ヘッダーから identity を絶対に受け取りません（任意 identity 選択の防止）。
//  - authorizeAdmin(req, reply): 管理系ルートの承認フック。既存 server.ts の requireAdmin をそのまま渡せます。
//  - 利用枠・予算の計量は仮想キー（Virtual Key, ヘッダー x-team-virtual-key）認証で行い、
//    プロジェクト ID はキーから解決するため、クライアントは他プロジェクトの予約を操作できません。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TeamAccessError, TeamAccessService, type Actor } from './team-access.js';

/** 応答全体から認証用ハッシュを除く。新規キーの原文は発行応答だけで扱う。 */
function publicRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicRecord);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'hash').map(([key, item]) => [key, publicRecord(item)]));
  return value;
}

export interface TeamAccessRouteOptions {
  root: string;                                                          // 専用状態 root（テストは mkdtemp で隔離）
  authorizeAdmin: (req: FastifyRequest, reply: FastifyReply) => boolean; // 管理者承認フック（既存 requireAdmin を想定）
  identity: (req: FastifyRequest) => { id: string } | undefined | Promise<{ id: string } | undefined>; // ホスト認証済みの本人だけ
}

/** エラー種別を OpenAI 風の apiError 形へ揃えます。原文キー・秘密は一切含めません。 */
const apiError = (message: string, type: string, code: string) => ({ error: { message, type, code } });
const sendError = (reply: FastifyReply, error: unknown) => {
  if (error instanceof TeamAccessError) return reply.code(error.status).send(apiError(error.message, error.status === 401 ? 'authentication_error' : error.status === 403 ? 'permission_error' : error.status === 429 ? 'rate_limit_error' : 'validation_error', error.code));
  // Fastify 本体の検証エラー（不正JSON・415など）は本来のステータスを保ちます。
  const status = (error as { statusCode?: number })?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 600) return reply.code(status).send(apiError('リクエスト形式が不正です。', 'validation_error', 'invalid_request'));
  return reply.code(500).send(apiError('チーム利用管理の処理に失敗しました。', 'team_access_error', 'internal_error'));
};

/** ルートを登録し、内部 Service のインスタンスも返します（Gateway 側の計量フックから直接使うため）。 */
export function registerTeamAccessRoutes(app: FastifyInstance, options: TeamAccessRouteOptions): { service: TeamAccessService } {
  const service = new TeamAccessService({ root: options.root });

  app.register(async instance => {
    // 初リクエスト前に状態ファイルを初期化します（多重呼び出しは同一 Promise を再利用）。
    instance.addHook('preHandler', async (_req, reply) => {
      try { await service.initialize(); } catch (error) { return reply.code(500).send(apiError('チーム利用管理の状態初期化に失敗しました。', 'team_access_error', 'storage_error')); }
    });
    instance.setErrorHandler((error, _req, reply) => sendError(reply, error));

    /* ===== A. 管理者ルート（Admin Routes）: authorizeAdmin がfalseを返したら reply 済みで中断 ===== */
    const admin = async (req: FastifyRequest, reply: FastifyReply): Promise<Actor | undefined> => {
      if (!options.authorizeAdmin(req, reply)) return undefined; // authorizeAdmin 側で 401/403 を送信済み
      const id = await options.identity(req);
      // 管理フックが通っても identity が無ければ管理操作は許しません（二重の確認）。
      if (!id) { reply.code(401).send(apiError('ログインした identity が必要です。', 'authentication_error', 'identity_required')); return undefined; }
      return { kind: 'user', userId: id.id };
    };
    instance.get('/api/team-access/overview', async (req, reply) => {
      if (!await admin(req, reply)) return reply;
      return await service.overview();
    });
    instance.post('/api/team-access/users', async (req, reply) => {
      const actor = await admin(req, reply); if (!actor) return reply;
      const body = (req.body ?? {}) as { id?: string; displayName?: string; platformAdmin?: boolean };
      // body に identity・actor 相当の値が混ざっていても読み取りません（白名字段だけ渡す）。
      try { return reply.code(201).send(await service.createUser({ id: body.id, displayName: String(body.displayName ?? ''), platformAdmin: body.platformAdmin === true }, actor)); }
      catch (error) { return sendError(reply, error); }
    });
    instance.post('/api/team-access/projects', async (req, reply) => {
      const actor = await admin(req, reply); if (!actor) return reply;
      const body = (req.body ?? {}) as { id?: string; name?: string; ownerId?: string };
      try { return reply.code(201).send(publicRecord(await service.createProject({ id: body.id, name: String(body.name ?? ''), ownerId: String(body.ownerId ?? '') }, actor))); }
      catch (error) { return sendError(reply, error); }
    });

    /* ===== B. メンバールート（Member Routes）: identity 必須。他プロジェクト情報は Service 側でもう一度拒否 ===== */
    const memberActor = async (req: FastifyRequest, reply: FastifyReply): Promise<Actor | undefined> => {
      const id = await options.identity(req);
      if (!id) { reply.code(401).send(apiError('ログインした identity が必要です。', 'authentication_error', 'identity_required')); return undefined; }
      return { kind: 'user', userId: id.id };
    };
    instance.get('/api/team-access/projects', async (req, reply) => {
      const actor = await memberActor(req, reply); if (!actor) return reply;
      try {
        const overview = await service.overview(); // 一覧はprefix等の安全情報だけ。管理者以外には自分の所属を絞って返す。
        if (actor.kind === 'user' && overview.users.find(u => u.id === actor.userId)?.platformAdmin) return { projects: overview.projects };
        return { projects: overview.projects.filter(p => actor.kind === 'user' && ['owner', 'member'].includes(p.members[actor.userId])) };
      } catch (error) { return sendError(reply, error); }
    });
    instance.get('/api/team-access/projects/:id/usage', async (req, reply) => {
      const actor = await memberActor(req, reply); if (!actor) return reply;
      try { return await service.projectUsage(String((req.params as { id?: string }).id ?? ''), actor); }
      catch (error) { return sendError(reply, error); }
    });
    instance.post('/api/team-access/projects/:id/members', async (req, reply) => {
      const actor = await memberActor(req, reply); if (!actor) return reply;
      const body = (req.body ?? {}) as { userId?: string; role?: 'owner' | 'member' };
      try { return publicRecord(await service.addProjectMember(String((req.params as { id?: string }).id ?? ''), String(body.userId ?? ''), body.role ?? 'member', actor)); }
      catch (error) { return sendError(reply, error); }
    });
    instance.patch('/api/team-access/projects/:id', async (req, reply) => {
      const actor = await memberActor(req, reply); if (!actor) return reply;
      const body = (req.body ?? {}) as { allowedModels?: string[]; budgetUsd?: number | null; requestLimit?: { maxRequests: number; windowMs: number } | null; pricing?: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }> | null };
      // 管理者専用設定（pricing/budget）も含め、プロジェクト owner か platformAdmin かは Service が判定します。
      try { return publicRecord(await service.updateProject(String((req.params as { id?: string }).id ?? ''), { allowedModels: body.allowedModels, budgetUsd: body.budgetUsd, requestLimit: body.requestLimit, pricing: body.pricing }, actor)); }
      catch (error) { return sendError(reply, error); }
    });
    instance.post('/api/team-access/projects/:id/keys', async (req, reply) => {
      const actor = await memberActor(req, reply); if (!actor) return reply;
      const body = (req.body ?? {}) as { label?: string };
      try {
        // 原文キーを返す唯一の応答です。以後の一覧・監査には出ません。ログにも出さないこと（Fastify標準ログは本文を出さない）。
        return reply.code(201).send(await service.issueKey(String((req.params as { id?: string }).id ?? ''), String(body.label ?? ''), actor));
      } catch (error) { return sendError(reply, error); }
    });
    instance.post('/api/team-access/projects/:id/keys/:keyId/revoke', async (req, reply) => {
      const actor = await memberActor(req, reply); if (!actor) return reply;
      try { return publicRecord(await service.revokeKey(String((req.params as { id?: string }).id ?? ''), String((req.params as { keyId?: string }).keyId ?? ''), actor)); }
      catch (error) { return sendError(reply, error); }
    });

    /* ===== C. 仮想キールート（Usage Routes）: x-team-virtual-key 認証。プロジェクトはキーから決定 ===== */
    const keyActor = async (req: FastifyRequest, reply: FastifyReply): Promise<Actor & { kind: 'key' } | undefined> => {
      const supplied = req.headers['x-team-virtual-key'];
      if (typeof supplied !== 'string' || !supplied.trim()) { reply.code(401).send(apiError('仮想キーヘッダー x-team-virtual-key が必要です。', 'authentication_error', 'virtual_key_required')); return undefined; }
      try { const auth = await service.authenticateKey(supplied); return { kind: 'key', keyId: auth.keyId, projectId: auth.projectId }; }
      catch (error) { sendError(reply, error); return undefined; }
    };
    instance.post('/api/team-access/usage/reserve', async (req, reply) => {
      const actor = await keyActor(req, reply); if (!actor) return reply;
      const body = (req.body ?? {}) as { model?: string; estInputTokens?: number; estOutputTokens?: number };
      // body に projectId/userId を渡されても無視します。所属先はキーが決定します。
      try { return await service.reserve(actor, { model: String(body.model ?? ''), estInputTokens: body.estInputTokens, estOutputTokens: body.estOutputTokens }); }
      catch (error) { return sendError(reply, error); }
    });
    instance.post('/api/team-access/usage/commit', async (req, reply) => {
      const actor = await keyActor(req, reply); if (!actor) return reply;
      const body = (req.body ?? {}) as { reservationId?: string; inputTokens?: number; outputTokens?: number };
      try { return await service.commitReservation(String(body.reservationId ?? ''), { inputTokens: body.inputTokens, outputTokens: body.outputTokens }, actor); }
      catch (error) { return sendError(reply, error); }
    });
    instance.post('/api/team-access/usage/cancel', async (req, reply) => {
      const actor = await keyActor(req, reply); if (!actor) return reply;
      const body = (req.body ?? {}) as { reservationId?: string };
      try { return await service.cancelReservation(String(body.reservationId ?? ''), actor); }
      catch (error) { return sendError(reply, error); }
    });
  });

  return { service };
}
