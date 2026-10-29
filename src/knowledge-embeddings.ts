import { createHash } from 'node:crypto';

/** モデル・接続先は管理者設定のみから受け取ります。資料本文やAPI要求で変更しません。 */
export interface KnowledgeEmbedder {
  id: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** 不正数値・ゼロベクトル・次元違いを類似度計算へ渡しません。 */
export function normalizedVector(value: unknown, dimensions?: number): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 16384 || value.some(n => typeof n !== 'number' || !Number.isFinite(n)) || (dimensions !== undefined && value.length !== dimensions)) throw new Error('埋め込みベクトルの形式または次元が不正です。');
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('埋め込みベクトルの長さが不正です。');
  return value.map(n => n / norm);
}

/** OpenAI互換のembeddings通信。任意の組織やモデルを既定値にせず、明示設定時だけ接続します。 */
export function configuredKnowledgeEmbedder(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): KnowledgeEmbedder | undefined {
  const base = env.WENTIAN_KNOWLEDGE_EMBEDDING_BASE_URL;
  const model = env.WENTIAN_KNOWLEDGE_EMBEDDING_MODEL;
  if (!base && !model) return undefined;
  if (!base || !model) throw new Error('知識庫の埋め込み接続先とモデルを両方設定してください。');
  let url: URL;
  try { url = new URL(base.replace(/\/+$/, '') + '/embeddings'); } catch { throw new Error('埋め込み接続先のURL形式が不正です。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('埋め込み接続先は認証情報・検索文字列なしのHTTP/HTTPSで指定してください。');
  const id = createHash('sha256').update(JSON.stringify([url.href, model])).digest('hex');
  return { id, async embed(texts, parentSignal) {
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
    const response = await request(url, { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', ...(env.WENTIAN_KNOWLEDGE_EMBEDDING_API_KEY ? { authorization: 'Bearer ' + env.WENTIAN_KNOWLEDGE_EMBEDDING_API_KEY } : {}) }, body: JSON.stringify({ model, input: texts, encoding_format: 'float' }) });
    if (!response.ok) throw new Error('知識庫の埋め込みAPIが応答に失敗しました。');
    // 応答全体を無制限に蓄積せず、巨大な上流応答を拒否します。
    if (!response.body) throw new Error('埋め込みAPIの応答が空です。');
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16 * 1024 * 1024) throw new Error('埋め込み応答が上限を超えています。'); parts.push(part.value); } }
    finally { await reader.cancel(); }
    const payload = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error('埋め込みAPIの応答件数が不正です。');
    const rows = new Map<number, number[]>(); let dimensions: number | undefined;
    for (const row of payload.data) {
      if (!Number.isInteger(row.index) || row.index < 0 || row.index >= texts.length || rows.has(row.index)) throw new Error('埋め込みAPIの応答順序が不正です。');
      const vector = normalizedVector(row.embedding, dimensions); dimensions = vector.length; rows.set(row.index, vector);
    }
    return texts.map((_, index) => rows.get(index)!);
  } };
}
