import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseStudyReply, saveStudyArtifacts, studyArtifactInstruction, studyReceipt } from './artifacts.js';

/** 互換API全体を変更せず、管理者のチャット画面だけに成果物の保存契約を追加します。 */
export function registerStudyConversation(app: FastifyInstance, options: { authorize: (req: FastifyRequest, reply: FastifyReply) => boolean; root: (req: FastifyRequest) => Promise<string | undefined>; complete: (body: Record<string, unknown>, req: FastifyRequest) => Promise<any> }) {
  app.post('/api/study/conversation', async (req, reply) => {
    if (!options.authorize(req, reply)) return reply;
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
    const body = req.body as Record<string, any>;
    if (!Array.isArray(body?.messages) || !body.messages.length || body.messages.length > 100 || body.messages.some((m: any) => !['user','assistant'].includes(m?.role))) return reply.code(400).send({ error: { message: '会話履歴が不正です。' } });
    const root = await options.root(req);
    const response = await options.complete({ ...body, stream: false, messages: [...(root ? [{ role: 'system', content: studyArtifactInstruction }] : []), ...body.messages] }, req);
    const raw = response.choices?.[0]?.message?.content || '';
    const value = root ? parseStudyReply(raw) : { reply: raw, files: [] };
    const saved = root ? await saveStudyArtifacts(root, value.files) : [];
    const content = value.reply + studyReceipt(saved);
    // 保存と再読込の成功後だけ完了本文を返します。既存画面のSSE受信形式を維持します。
    reply.type('text/event-stream').send('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n');
  });
}
