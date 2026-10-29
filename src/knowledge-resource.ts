import { lookup } from 'node:dns/promises';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { assertOrdinaryPath } from './safe-file.js';
import { isPublicWebAddress } from './chat-agent.js';

/** 外部の応答本文を含まない、画面へ表示できる収集エラーです。 */
export class KnowledgeSourceError extends Error {constructor(message:string,readonly code='source_failed'){super(message)}}

/** 秘密は管理者の設定ファイルにだけ置き、プロジェクトと接続元へ権限を固定します。 */
export interface KnowledgeSourceProfile {
  id: string;
  projects: string[];
  origins: string[];
  allowPrivate?: boolean;
  headers?: Record<string, string>;
  storageStatePath?: string;
  selector?: string;
  readPostUrls?: string[];
  documentPassword?: string;
}
export async function knowledgeProfiles(file = process.env.WENTIAN_KNOWLEDGE_SOURCES_FILE): Promise<KnowledgeSourceProfile[]> {
  if (!file) return [];
  await assertOrdinaryPath(file);
  if ((await stat(file)).size > 1024 * 1024) throw new KnowledgeSourceError('収集接続設定が大きすぎます。');
  const rows = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(rows)) throw new KnowledgeSourceError('収集接続設定は配列で指定してください。');
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(row.id) || ids.has(row.id) || !Array.isArray(row.projects) || !row.projects.length || row.projects.some((v: unknown) => typeof v !== 'string') || !Array.isArray(row.origins) || !row.origins.length) throw new KnowledgeSourceError('収集接続設定の識別名・プロジェクト・接続元が不正です。');
    ids.add(row.id);
    for (const origin of row.origins) { const url = new URL(origin); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new KnowledgeSourceError('収集接続設定には正確なHTTP/HTTPSの接続元を指定してください。'); }
    if (row.headers && (typeof row.headers !== 'object' || Array.isArray(row.headers) || Object.entries(row.headers).some(([key, value]) => !/^[a-z0-9-]+$/i.test(key) || typeof value !== 'string' || /[\r\n]/.test(value) || ['host', 'connection', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())))) throw new KnowledgeSourceError('収集接続設定のHTTPヘッダーが不正です。');
    if(row.readPostUrls!==undefined&&(!Array.isArray(row.readPostUrls)||row.readPostUrls.some((raw:unknown)=>{try{const url=new URL(String(raw));return typeof raw!=='string'||!row.origins.includes(url.origin)||Boolean(url.username||url.password||url.hash)}catch{return true}})))throw new KnowledgeSourceError('読取り用POSTのURL設定が不正です。');
    if(row.documentPassword!==undefined&&typeof row.documentPassword!=='string')throw new KnowledgeSourceError('資料のパスワード設定が不正です。');
    if ((row.storageStatePath !== undefined && typeof row.storageStatePath !== 'string') || (row.selector !== undefined && typeof row.selector !== 'string') || (row.allowPrivate !== undefined && typeof row.allowPrivate !== 'boolean')) throw new KnowledgeSourceError('収集接続設定の型が不正です。');
  }
  return rows;
}

/** 名前解決したすべてのIPを調べ、許可されていない内部接続を防ぎます。 */
export async function knowledgeTarget(raw: string, profile?: KnowledgeSourceProfile, resolve = lookup) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new KnowledgeSourceError('HTTP/HTTPSのURLを指定してください。');
  if (profile && !profile.origins.includes(url.origin)) throw new KnowledgeSourceError('この接続設定では対象の接続元を利用できません。');
  if (!profile && url.port && !['80', '443'].includes(url.port)) throw new KnowledgeSourceError('公開収集の接続先は標準ポートに限定します。');
  const addresses = await resolve(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || (!profile?.allowPrivate && addresses.some(row => !isPublicWebAddress(row.address)))) throw new KnowledgeSourceError('内部接続には対象接続元と内部接続許可の設定が必要です。');
  return { url, address: addresses[0] };
}

export interface KnowledgeResource { url: string; bytes: Buffer; contentType: string; status: number; headers: Record<string, string>; sessionCookies?: Array<{name:string;value:string;domain:string;path:string;secure:boolean;httpOnly:boolean;expires:number}> }
export type KnowledgeResourceReader = (url: string, signal: AbortSignal, profile?: KnowledgeSourceProfile, headers?: Record<string, string>, redirects?: number, operation?: {method:'GET'|'HEAD'|'POST';body?:Buffer}) => Promise<KnowledgeResource>;

/** PDF・画像・音声も同じDNS検査とIP固定で取得します。資格情報は許可した接続元だけに送ります。 */
export const readKnowledgeResource: KnowledgeResourceReader = async (raw, signal, profile, browserHeaders = {}, redirects = 0, operation = {method:'GET'}) => {
  const { url, address } = await knowledgeTarget(raw, profile); signal.throwIfAborted();
  if(operation.method==='POST'&&!profile?.readPostUrls?.includes(url.href))throw new KnowledgeSourceError('このPOST接続先は読取り用として許可されていません。');
  if(operation.body&&operation.body.length>1024*1024)throw new KnowledgeSourceError('読取り要求の本文が大きすぎます。');
  const limit = 25 * 1024 * 1024;
  const response = await new Promise<KnowledgeResource>((resolve, reject) => {
    const headers: Record<string, string> = { 'user-agent': 'Wentian-Knowledge/1.0', 'accept-encoding': 'identity' };
    // ブラウザーのCookie等も、明示した認証先から外へ転送しません。
    for (const [key, value] of Object.entries(browserHeaders)) if (['accept', 'accept-language', 'content-type', 'origin', 'referer'].includes(key.toLowerCase()) || (profile && ['cookie', 'authorization'].includes(key.toLowerCase()))) headers[key] = value;
    Object.assign(headers, profile?.headers || {});
    const agent=url.protocol==='https:'?new HttpsAgent():new HttpAgent();
    if(process.env.WENTIAN_KNOWLEDGE_PROXY){
      const proxy=new URL(process.env.WENTIAN_KNOWLEDGE_PROXY);
      if(!['http:','https:'].includes(proxy.protocol))throw new KnowledgeSourceError('収集プロキシの形式が不正です。');
      // プロキシにも検査済みIPを指定し、プロキシ側の名前解決へ切り替えません。
      agent.createConnection=((_options:unknown,callback:any)=>{
        const destination=(address.family===6?'['+address.address+']':address.address)+':'+(url.port||(url.protocol==='https:'?'443':'80'));
        const tunnel=(proxy.protocol==='https:'?httpsRequest:httpRequest)({hostname:proxy.hostname,port:proxy.port||(proxy.protocol==='https:'?443:80),method:'CONNECT',path:destination,signal,headers:{host:destination,...(proxy.username?{'proxy-authorization':'Basic '+Buffer.from(decodeURIComponent(proxy.username)+':'+decodeURIComponent(proxy.password)).toString('base64')}:{})}});
        tunnel.setTimeout(30000,()=>tunnel.destroy(new KnowledgeSourceError('収集プロキシがタイムアウトしました。')));
        tunnel.once('error',callback);tunnel.once('connect',(res,socket,head)=>{if(res.statusCode!==200){socket.destroy();callback(new KnowledgeSourceError('収集プロキシが接続を拒否しました。'));return}if(head.length)socket.unshift(head);if(url.protocol==='https:'){const secure=tlsConnect({socket,servername:url.hostname,rejectUnauthorized:true});secure.once('secureConnect',()=>callback(null,secure));secure.once('error',callback)}else callback(null,socket)});tunnel.end();return undefined;
      }) as any;
    }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method:operation.method, signal, agent, headers, lookup: ((_host: unknown, options: any, callback: any) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any }, res => {
      const parts: Buffer[] = []; let length = 0;
      res.on('data', part => { length += part.length; if (length > limit) request.destroy(new KnowledgeSourceError('収集ファイルは25 MiBまでです。')); else parts.push(part); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          let bytes = Buffer.concat(parts);
          const encoding = res.headers['content-encoding'];
          if (encoding === 'gzip') bytes = gunzipSync(bytes, { maxOutputLength: limit });
          else if (encoding === 'deflate') bytes = inflateSync(bytes, { maxOutputLength: limit });
          else if (encoding === 'br') bytes = brotliDecompressSync(bytes, { maxOutputLength: limit });
          else if (encoding && encoding !== 'identity') throw new KnowledgeSourceError('未対応の圧縮形式です。');
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) if (value !== undefined && !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) responseHeaders[key] = Array.isArray(value) ? value.join('\n') : value;
          resolve({ url: url.href, bytes, contentType: String(res.headers['content-type'] || 'application/octet-stream'), status: res.statusCode || 0, headers: responseHeaders });
        } catch { reject(new KnowledgeSourceError('収集応答の展開に失敗しました。')); }
      });
    });
    request.once('close',()=>agent.destroy());request.setTimeout(30000, () => request.destroy(new KnowledgeSourceError('収集通信がタイムアウトしました。'))); request.on('error', reject); request.end(operation.body);
  });
  if (response.status >= 300 && response.status < 400 && response.headers.location && redirects >= 0) {
    if (redirects >= 5) throw new KnowledgeSourceError('収集先の転送回数が上限を超えました。');
    return readKnowledgeResource(new URL(response.headers.location, raw).href, signal, profile, {}, redirects + 1);
  }
  if (redirects >= 0 && (response.status < 200 || response.status >= 300)) throw new KnowledgeSourceError(response.status === 401 || response.status === 403 ? '収集先の認証を更新してください。' : '収集先が正常に応答しませんでした。',response.status===401||response.status===403?'auth_required':'source_failed');
  return response;
};
