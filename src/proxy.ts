import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { beginProviderTransfer, type ProviderTransfer } from './provider-data-policy.js';

/** ストリーム（Stream）の制御イベントを除外して、最初の生成内容と使用量を観測します。本文は保存しません。 */
export class StreamUsageObserver {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private discarding = false;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  constructor(private readonly onToken: () => void) {}
  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      if (this.discarding) { this.discarding = false; continue; }
      if (!line.startsWith('data:')) continue;
      try {
        const value = JSON.parse(line.slice(5).trim());
        if (value.usage) this.usage = value.usage;
        if (value.choices?.some((choice: any) => choice.delta?.content || choice.delta?.reasoning_content || choice.delta?.tool_calls?.length)) this.onToken();
      } catch { /* 制御行や未対応イベントは透過中継し、計測対象から除きます。 */ }
    }
    // 異常に長い1行によるメモリ増大を防ぎます。転送データには手を加えません。
    if (this.pending.length > 1024 * 1024) { this.pending = ''; this.discarding = true; }
  }
}

/** 上流へ安全に転送できる API パスと、そのプロトコル種別です。 */
export const PROXY_PATHS = Object.freeze({
  '/v1/chat/completions': 'openai',
  '/v1/responses': 'openai',
  '/v1/embeddings': 'openai',
  '/v1/audio/transcriptions': 'openai',
  '/v1/messages': 'anthropic',
  '/v1/rerank': 'rerank',
} as const);

export type ProxyPath = keyof typeof PROXY_PATHS;
export type ProxyProtocol = (typeof PROXY_PATHS)[ProxyPath];

/** 任意 URL の転送を防ぎ、明示的に許可したパスだけを返します。 */
export function getAllowedProxyPath(path: string): { path: ProxyPath; protocol: ProxyProtocol } | undefined {
  let pathname: string;
  try {
    pathname = new URL(path, 'http://wentian.invalid').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return undefined;
  }
  if (pathname.includes('..') || !(pathname in PROXY_PATHS)) return undefined;
  const allowed = pathname as ProxyPath;
  return { path: allowed, protocol: PROXY_PATHS[allowed] };
}

export interface UpstreamFailureClassification {
  fallback: boolean;
  category: 'client' | 'rate_limit' | 'timeout' | 'server' | 'network' | 'unknown';
}

/** HTTP 状態または通信例外から、別プロバイダーへフォールバック可能か判定します。 */
export function classifyUpstreamFailure(value: number | unknown): UpstreamFailureClassification {
  if (typeof value !== 'number') return { fallback: true, category: 'network' };
  if ([400, 401, 403, 404, 422].includes(value)) return { fallback: false, category: 'client' };
  if (value === 408) return { fallback: true, category: 'timeout' };
  if (value === 429) return { fallback: true, category: 'rate_limit' };
  if (value >= 500 && value <= 599) return { fallback: true, category: 'server' };
  return { fallback: false, category: 'unknown' };
}

export interface TransparentUpstreamError {
  status: number;
  contentType: string;
  body: string | Uint8Array;
  fallback: boolean;
  modelUnavailable?: boolean;
}

/** OpenAI/Anthropic のエラー本文を作り直さず、そのままクライアントへ返せる形で読み出します。 */
export async function readTransparentUpstreamError(response: Response): Promise<TransparentUpstreamError> {
  const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
  const classification = classifyUpstreamFailure(response.status);
  const body = contentType.toLowerCase().includes('json')
    ? await response.text()
    : new Uint8Array(await response.arrayBuffer());
  // 入力不正の400等はそのまま返し、明示的なモデル提供終了だけを切替対象にします。
  let modelUnavailable = false;
  if (response.status === 410 && typeof body === 'string') {
    try { const payload = JSON.parse(body); const message = payload.error?.message;
      modelUnavailable = typeof message === 'string' && /\b(?:was retired|model.{0,80}retired|model.{0,80}no longer available)\b/i.test(message);
    } catch { /* 提供終了と確認できない応答は従来どおり透過します。 */ }
  }
  return { status: response.status, contentType, body, fallback: classification.fallback || modelUnavailable, ...(modelUnavailable ? { modelUnavailable: true } : {}) };
}

export interface UpstreamFetchOptions {
  clientSignal?: AbortSignal;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
  transfer?: ProviderTransfer;
}

/** クライアント切断とタイムアウトを上流 Fetch（フェッチ）へ伝播します。 */
export async function fetchWithClientAbort(
  input: string | URL | Request,
  init: RequestInit = {},
  options: UpstreamFetchOptions = {},
): Promise<Response> {
  const target=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  const transfer=options.transfer?await beginProviderTransfer(options.transfer,target,init.body):undefined;
  const signals = [init.signal, options.clientSignal].filter((signal): signal is AbortSignal => Boolean(signal));
  if(transfer)signals.push(transfer.signal);
  if (options.timeoutMs && options.timeoutMs > 0) signals.push(AbortSignal.timeout(options.timeoutMs));
  // AbortSignal.any はレスポンスヘッダー受信後も有効なため、SSE 読み取り中の切断も上流へ届きます。
  const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  try{
    signal?.throwIfAborted();
    const response=await (options.fetchImplementation ?? fetch)(input, { ...init, signal });
    if(!transfer)return response;
    if(!response.body){await transfer.finish(response.ok,response.status);return response;}
    const reader=response.body.getReader();
    const complete=async(ok:boolean)=>{signal?.removeEventListener('abort',aborted);await transfer.finish(ok,response.status);};
    const aborted=()=>{void reader.cancel(signal?.reason).catch(()=>{});void complete(false).catch(()=>{});};
    signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
    // SSEも最後まで停止可能にします。本文を先読み・保存せず、そのまま中継します。
    const body=new ReadableStream<Uint8Array>({async pull(controller){try{signal?.throwIfAborted();const next=await reader.read();signal?.throwIfAborted();if(next.done){await complete(response.ok);controller.close();}else controller.enqueue(next.value);}catch(error){await complete(false).catch(()=>{});controller.error(error);}},async cancel(reason){try{await reader.cancel(reason);}finally{await complete(false);}}},{highWaterMark:0});
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  }catch(error){await transfer?.finish(false).catch(()=>{});throw error;}
}

/** SSE（Server-Sent Events）中継に必要なヘッダーだけを安全な固定値で生成します。 */
export function sseProxyHeaders(upstream: Headers): Record<string, string> {
  return {
    'content-type': upstream.get('content-type') || 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}

/** Web ReadableStream を Node.js のパイプ可能なストリームへ変換します。 */
export function toNodeReadable(response: Response): Readable {
  if (!response.body) throw new Error('上流のストリーム応答本文がありません。');
  const readable = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  // クライアント切断時は上流 Fetch も Abort（中断）され、Readable に AbortError が届きます。
  // pipe() は送信先の切断を自動では error listener に変換しないため、未処理例外による
  // Gateway 全体の終了を防ぐ listener を必ず登録します。個別の計測 listener は併用できます。
  readable.on('error', () => undefined);
  return readable;
}

/** `provider/model` を上流固有の model ID へ戻します。自動モデルは解決済み ID を必須とします。 */
export function resolveUpstreamModelId(requested: unknown, providerId: string, resolvedModelId?: string): string {
  const value = typeof requested === 'string' ? requested : '';
  const selected = value.startsWith('wentian-auto/') ? resolvedModelId : value;
  if (!selected) throw new Error('自動ルーティングには解決済みモデル ID が必要です。');
  const prefix = `${providerId}/`;
  if (!selected.startsWith(prefix)) throw new Error(`モデル ${selected} はプロバイダー ${providerId} に属していません。`);
  const upstream = selected.slice(prefix.length);
  if (!upstream || upstream.includes('\0')) throw new Error('上流モデル ID が不正です。');
  return upstream;
}
