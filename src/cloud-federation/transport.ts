import { FederationError, PEER_PATH, type Envelope, type Peer } from './contracts.js';

export type PeerTransport = (peer: Peer, envelope: Envelope) => Promise<Envelope>;
/** 宛先は所有者が固定します。平文通信は数値ループバックの隔離試験だけに限定します。 */
export function endpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) throw new FederationError('相手のルートHTTPS URLを指定してください。HTTPは数値ループバックだけに使用できます。');
  return url.origin;
}
export const httpTransport: PeerTransport = async (peer, envelope) => {
  const response = await fetch(endpoint(peer.endpoint) + PEER_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope), redirect: 'error', signal: AbortSignal.timeout(20000) });
  const reader = response.body?.getReader();
  if (!reader) throw new FederationError('相手の応答がありません。', 502);
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 256 * 1024) throw new FederationError('相手の応答が上限を超えました。', 502); chunks.push(part.value); }
  } finally { await reader.cancel(); }
  if (!response.ok) throw new FederationError('相手への接続または認証に失敗しました。', 502);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Envelope;
};
