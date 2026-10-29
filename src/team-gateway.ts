import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TeamAccessService, TeamAccessError, type Actor } from './team-access.js';

export type ProjectKeyActor = Actor & { kind: 'key' };
/** 仮想キー（Virtual Key）の計量はGateway側で行い、クライアントに確定額を自己申告させません。 */
export function registerTeamGateway(app: FastifyInstance, service: TeamAccessService) {
  const actors = new WeakMap<FastifyRequest, ProjectKeyActor>();
  const reservations = new WeakMap<FastifyRequest, { actor: ProjectKeyActor; id: string; input: number; output: number }>();
  const actor = (req: FastifyRequest) => actors.get(req);
  app.addHook('onRequest', async (req, reply) => {
    const raw = req.headers['x-team-virtual-key'];
    if (raw === undefined) return;
    if (typeof raw !== 'string') return reply.code(401).send({ error: { code: 'invalid_virtual_key', message: '有効な仮想キーが必要です。' } });
    try {
      const auth = await service.authenticateKey(raw);
      // キーで管理機能や計量の自己確定APIへ入れないよう、入口を限定します。
      const pathname = req.url.split('?')[0];
      const allowed = pathname === '/v1/chat/completions' || pathname === '/v1/models' ||
        (req.method === 'GET' && pathname.startsWith('/v1/project-knowledge/'));
      if (!allowed) return reply.code(403).send({ error: { code: 'virtual_key_route_forbidden', message: 'この仮想キーではこの操作を実行できません。' } });
      actors.set(req, { kind: 'key', ...auth });
    } catch (error) {
      const status = error instanceof TeamAccessError ? error.status : 503;
      return reply.code(status).send({ error: { code: error instanceof TeamAccessError ? error.code : 'team_storage_unavailable', message: '仮想キーを確認できません。' } });
    }
  });
  app.addHook('preHandler', async (req, reply) => {
    const keyActor = actors.get(req);
    if (!keyActor || req.url.split('?')[0] !== '/v1/chat/completions') return;
    try {
      const body = req.body as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || body.model.startsWith('wentian-auto/')) throw new TeamAccessError(400, 'explicit_model_required', '仮想キーでは明示的なモデルIDを指定してください。');
      if (body.stream === true) throw new TeamAccessError(422, 'team_stream_not_supported', 'この計量経路では非ストリーミング応答を指定してください。');
      if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) throw new TeamAccessError(400, 'ambiguous_output_limit', '出力上限は一つの項目で指定してください。');
      const output = Number(body.max_completion_tokens ?? body.max_tokens ?? 2048);
      if (!Number.isSafeInteger(output) || output < 1 || output > 65536) throw new TeamAccessError(400, 'invalid_output_limit', '出力上限は1〜65536の整数で指定してください。');
      if (body.max_tokens === undefined && body.max_completion_tokens === undefined) body.max_tokens = output;
      // シリアライズした全入力のバイト数と余裕を予約します。プロンプトだけの過小見積りを避けます。
      const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
      if (bytes > 1024 * 1024) throw new TeamAccessError(413, 'team_input_too_large', '計量対象の入力は1MiB以内にしてください。');
      const input = bytes * 4 + 4096;
      const reservation = await service.reserve(keyActor, { model: body.model, estInputTokens: input, estOutputTokens: output });
      reservations.set(req, { actor: keyActor, id: reservation.reservationId, input, output });
    } catch (error) {
      return reply.code(error instanceof TeamAccessError ? error.status : 503).send({ error: {
        code: error instanceof TeamAccessError ? error.code : 'team_storage_unavailable',
        message: error instanceof TeamAccessError ? error.message : '利用枠を確認できません。',
      } });
    }
  });
  app.addHook('onSend', async (req, reply, payload) => {
    const keyActor = actors.get(req);
    if (keyActor && req.url.split('?')[0] === '/v1/models' && typeof payload === 'string' && reply.statusCode === 200) {
      const usage = await service.projectUsage(keyActor.projectId, keyActor);
      const value = JSON.parse(payload);
      value.data = (value.data || []).filter((m: { id: string }) => usage.project.allowedModels.includes(m.id));
      return JSON.stringify(value);
    }
    const reservation = reservations.get(req);
    if (!reservation) return payload;
    // フックの再入時に二重確定しないよう、処理の前にこの要求から予約を外します。
    reservations.delete(req);
    try {
      let usage: any;
      if (typeof payload === 'string') { try { usage = JSON.parse(payload)?.usage; } catch { /* エラー本文は計量根拠として使いません。 */ } }
      const suppliedInput = usage?.prompt_tokens ?? usage?.input_tokens;
      const suppliedOutput = usage?.completion_tokens ?? usage?.output_tokens;
      const measured = reply.statusCode < 400 && Number.isSafeInteger(suppliedInput) && suppliedInput >= 0 && Number.isSafeInteger(suppliedOutput) && suppliedOutput >= 0;
      // 上流実行後の通信失敗やUsage欠落は無料と見なさず、予約値で保守的に確定します。
      await service.commitReservation(reservation.id, { inputTokens: measured ? suppliedInput : reservation.input,
        outputTokens: measured ? suppliedOutput : reservation.output }, reservation.actor);
      reply.header('x-wentian-usage-source', measured ? 'upstream' : 'conservative-estimate');
    } catch {
      reply.code(503);
      return JSON.stringify({ error: { code: 'usage_settlement_pending', message: '利用量の確定に失敗しました。上流処理が実行された可能性があるため、自動で再送せず管理者へ確認してください。' } });
    }
    return payload;
  });
  return { actor };
}
