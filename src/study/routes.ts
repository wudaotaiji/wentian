import type { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import { JUPYTER_BASE, type StudyModule } from './service.js';
import { studyHtml } from './ui.js';

type Authorize = (req: FastifyRequest, reply: FastifyReply) => boolean;
const sameOrigin = (headers: IncomingMessage['headers']) => !headers.origin || ['http://' + headers.host, 'https://' + headers.host].includes(headers.origin);
function forwardHeaders(headers: IncomingMessage['headers'], port: number, token: string) {
  const result: Record<string, string> = { host: '127.0.0.1:' + port, authorization: 'token ' + token };
  for (const key of ['content-type','content-length','accept','accept-encoding','if-none-match','if-modified-since','range']) if (typeof headers[key] === 'string') result[key] = headers[key] as string;
  return result;
}

/** Wentianの認証をHTTPとWebSocketの両方へ適用し、Jupyterトークンは内部だけで使います。 */
export function registerStudy(app: FastifyInstance, service: StudyModule | undefined | ((req: FastifyRequest) => StudyModule | undefined), authorize: Authorize, options?: { importLegacy: (req: FastifyRequest) => Promise<{ copied: number; skipped: number }> }) {
  const resolve = (req: FastifyRequest) => typeof service === 'function' ? service(req) : service;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
  app.get('/study', (_req, reply) => reply.type('text/html; charset=utf-8').send(studyHtml));
  app.get('/study/', (_req, reply) => reply.redirect('/study'));
  app.register(async routes => {
    routes.addHook('onRequest', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!authorize(req, reply)) return reply;
      if (!sameOrigin(req.headers) || req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
    });
    routes.get('/api/study/status', req => resolve(req)?.status() || { state: 'disabled' });
    if (options) routes.post('/api/study/import-legacy', async (req,reply) => {
      try { return await options.importLegacy(req); }
      catch (error) { return reply.code(400).send({ error: { message: error instanceof Error ? error.message : '旧共有データの取り込みに失敗しました。' } }); }
    });
    for (const action of ['start','stop','restart'] as const) routes.post('/api/study/' + action, async (req, reply) => {
      const current = resolve(req);
      if (!current) return reply.code(503).send({ error: { message: 'Jupyterモジュールは無効です。' } });
      try { return await current![action](); }
      catch (error) { return reply.code(503).send({ error: { message: (error as Error).message } }); }
    });
    // コンテンツ・アップロードを再解釈せず、Jupyterの公開HTTP契約をそのまま中継します。
    routes.register(async proxy => {
      proxy.removeAllContentTypeParsers();
      proxy.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 }, (_req, body, done) => done(null, body));
      proxy.all(JUPYTER_BASE + '*', async (req, reply) => {
        const target = resolve(req as FastifyRequest)?.target();
        if (!target) {
          // 文書への直接リンクは書斎で起動し、元の文書へ戻します。API要求では起動しません。
          const destination = req.raw.url || '';
          if (req.method === 'GET' && /^\/study\/jupyter\/lab(?:\/|\?|$)/.test(destination)) {
            return reply.redirect('/study?open=' + encodeURIComponent(destination));
          }
          return reply.code(503).send({ error: { message: 'Jupyterは停止しています。書斎から起動してください。' } });
        }
        const headers = forwardHeaders(req.headers, target.port, target.token);
        const body = req.body as Buffer | undefined;
        delete headers['content-length']; if (body?.length) headers['content-length'] = String(body.length);
        try {
          const response = await fetch(`http://127.0.0.1:${target.port}${req.raw.url}`, { method:req.method,headers,...(body?.length?{body:new Uint8Array(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(60000) });
          // NodeのIncomingMessageをBunの応答へ直接pipeせず、上限付きのバイト列で橋渡しします。
          // fetchが展開する圧縮ヘッダーと元の長さを除去し、JS・画像も欠損なく配信します。
          const chunks:Uint8Array[]=[];let length=0;
          if(response.body)for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){length+=chunk.length;if(length>64*1024*1024){await response.body.cancel().catch(()=>undefined);throw new Error('応答の容量上限です。');}chunks.push(chunk)}
          reply.code(response.status);
          response.headers.forEach((value,key)=>{if(!['connection','transfer-encoding','set-cookie','content-security-policy','x-frame-options','content-encoding','content-length'].includes(key))reply.header(key,value.replaceAll(target.token,''))});
          const originalPolicy = String(response.headers.get('content-security-policy') || '').split(';').filter(part => !part.trim().startsWith('frame-ancestors')).join(';');
          reply.header('content-security-policy', originalPolicy + "; frame-ancestors 'self'").header('x-frame-options','SAMEORIGIN');
          // Reply自身を返し、Bunでも非同期ストリームの送信完了前に応答を閉じません。
          const payload = Buffer.concat(chunks), contentType=response.headers.get('content-type')||'';
          // JupyterLabのpage_configに含まれる内部トークンは公開せず、各中継要求へサーバー側で付与します。
          return reply.send(/^(?:text\/|application\/(?:json|javascript))/.test(contentType)?Buffer.from(payload.toString('utf8').replaceAll(target.token,''),'utf8'):payload);
        } catch { return reply.code(502).send({ error: { message: 'Jupyterへの接続が切れました。' } }); }
      });
    });
  });
  const upgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    if (!req.url?.startsWith(JUPYTER_BASE)) return;
    let allowed = false;
    // 既存の管理者ガードはヘッダーを参照するため、Upgradeでも同じ判定を利用できます。
    const denied = { code() { return this; }, send() { return this; } } as unknown as FastifyReply;
    try { allowed = sameOrigin(req.headers) && req.headers['sec-fetch-site'] !== 'cross-site' && authorize(req as unknown as FastifyRequest, denied); } catch { allowed = false; }
    const target = allowed ? resolve(req as unknown as FastifyRequest)?.target() : undefined;
    if (!allowed || !target) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    const protocols = typeof req.headers['sec-websocket-protocol'] === 'string' ? req.headers['sec-websocket-protocol'].split(',').map(p => p.trim()) : [];
    // BunではUpgradeを同じイベント内で確定する必要があります。接続準備中の送信は上限付きで待機します。
    sockets.handleUpgrade(req, socket, head, client => {
      const backend = new WebSocket(`ws://127.0.0.1:${target.port}${req.url}`, protocols, { headers: { authorization: 'token ' + target.token }, origin: 'http://127.0.0.1:' + target.port, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
      const pending:Array<{data:WebSocket.RawData;binary:boolean}>=[];let pendingBytes=0;
      client.on('message', (data, binary) => {
        if (backend.readyState === WebSocket.OPEN) backend.send(data, { binary });
        else if(backend.readyState===WebSocket.CONNECTING){pendingBytes+=Array.isArray(data)?data.reduce((n,b)=>n+b.length,0):data.byteLength;if(pendingBytes>64*1024*1024){client.close(1009,'容量上限です。');backend.close()}else pending.push({data,binary})}
      });
      backend.once('open',()=>{for(const message of pending)backend.send(message.data,{binary:message.binary});pending.length=0;pendingBytes=0});
      backend.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
      client.on('close', () => backend.close()); client.on('error', () => backend.close());
      backend.on('close', () => client.close()); backend.on('error', () => client.close());
    });
  };
  app.server.on('upgrade', upgrade);
  app.addHook('onClose', async () => { app.server.removeListener('upgrade', upgrade); for (const socket of sockets.clients) socket.terminate(); sockets.close(); if (typeof service !== 'function') await service?.stop(); });
}
