import { KnowledgeVectorCache } from './knowledge-vector-cache.js';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, open, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { normalizedVector, type KnowledgeEmbedder } from './knowledge-embeddings.js';
import { renameWithRetry } from './atomic-file.js';
import { machineConfigDirectory } from './agent-exclusion-policy.js';

/**
 * P2 社内資料登録・検索・引用（Project Knowledge / ナレッジストア）コア
 *
 * 方針（docs/project_knowledge_agent.md と一体）:
 *  - プロジェクトID（projectId）ごとに1ファイルへ集約し、資料の混線を物理的に防ぐ（プロジェクト隔離）。
 *  - URL収集は権限付き専用経路で行い、このストア自身はURLへ接続しない。
 *  - 字句検索と、利用者が設定した埋め込みモデルによるベクトル・ハイブリッド検索を提供する。
 *    検索結果には抜粋・行番号・revision・contentHashを必ず添える。
 *  - 保存は一時ファイル→アトミックリネーム（atomic rename / 原子的リネーム）。
 *    更新は楽観的ロック（optimistic locking / 楽観的ロック、expectedRevision）と進程内Mutex（相互排他）で競合対処。
 *  - 古い改訂（revision）のチャンクは本文を破棄して無効化記録（superseded / 失効記録）だけ残す。
 *    更新後の検索で古い内容が混ざる経路を無くすためと、失効した他人の資料本文をレスポンスへ出さないため。
 */

/* ============================================================ 制限値（Limits） */

/** 資料本文の最大文字数。超过は 413 相当（content_too_large）で弾く。 */
export const MAX_CONTENT_CHARS = 100_000;
/** 検索クエリの最大文字数。総当たり・過大負荷クエリ（ReDoS的な語数爆発）の抑止。 */
export const MAX_QUERY_CHARS = 300;
/** タイトルの最大文字数。 */
export const MAX_TITLE_CHARS = 200;
/** 元資料URLの最大長（一般的なブラウザ上限に合わせる）。 */
export const MAX_URL_CHARS = 2_048;
/** 検索で返す最大件数（1回の検索チャンク数。件数操作での他資料洩れ探りも兼ねる固定上限）。 */
export const MAX_SEARCH_LIMIT = 20;
/** チャンク（検索の根拠単位）の目安。これを超える行をまとめず、行数でも切る。 */
const CHUNK_MAX_CHARS = 600;
const CHUNK_MAX_LINES = 20;

/* ============================================================ 型（Types） */

/** 検索の根拠となる本文断片。行番号（1始まり）を持つため引用画面が「何行目か」を出せる。 */
export interface KnowledgeChunk {
  chunkId: string;     // `${documentId}#r${revision}#${連番}` — 改訂が変わればIDも変わる
  revision: number;
  lineStart: number;   // 1始まり（利用者から見てエディタと同じ数え方）
  lineEnd: number;
  text: string;
  active: boolean;     // 現改訂のみ true。更新で false にはせず旧チャンクは配列から除去する
}

/** 失効した旧改訂の記録。本文は保持しない（失効資料の漏洩防止）。ハッシュだけ照合用に置く。 */
export interface SupersededRevision {
  revision: number;
  contentHash: string;
  supersededAt: string; // ISO文字列
}

/** 社内資料1件。改訂（revision）は更新ごとに +1。 */
export interface KnowledgeDependency {documentId:string;contentHash:string;revision:number;title:string;url:string}
export interface KnowledgeDocument {
  provenance?:KnowledgeDependency[];
  collection?: { sourceUrl: string; part: number; total: number };
  documentId: string;  // サーバー発行の16進ランダム（利用者が選べず、既知IDへの混入を難しいにする）
  title: string;
  url: string;         // http/httpsの出典。本文取得は認可済みの専用収集口だけで実行する
  content: string;     // 利用者が登録した本文テキスト
  contentHash: string; // sha256(content)。更新検知・引用の一致性検証用
  revision: number;
  createdAt: string;
  updatedAt: string;
  chunks: KnowledgeChunk[];             // 常に現改訂分だけ。旧改訂本文は保持しない
  superseded: SupersededRevision[];     // 「更新で古チャンクが無効化された」証跡
}

/** プロジェクト台帳ファイルの最上位構造。壊れたJSONは黙って空にしない（読取側で例外）。 */
interface VectorIndex { provider: string; entries: Record<string, { hash: string; vector: number[] }> }
interface ProjectLedger {
  vectorIndex?: VectorIndex;
  version: 1;
  projectId: string;
  documents: KnowledgeDocument[];
}

/** 検索ヒット。根拠必須: documentId/title/url/excerpt/行番号/revision/contentHash を常に含む。 */
export interface KnowledgeSearchHit {
  documentId: string;
  title: string;
  url: string;
  excerpt: string;
  lineStart: number;
  lineEnd: number;
  chunkId: string;
  revision: number;
  contentHash: string;
  score: number;
}

/** 一覧用の軽量メタ（本文・チャンクを返さず、過大な一覧レスポンスと情報量を絞る）。 */
export interface KnowledgeDocumentMeta {
  collection?: KnowledgeDocument['collection'];
  documentId: string;
  title: string;
  url: string;
  revision: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  contentChars: number;
}

/* ============================================================ 検証（Validation） */

/** プロジェクトID規則。英小数字字始まりの [a-z0-9_-] 2〜64文字。
 *  - `..` `/` `\` `:` などを許さず、`path.join(root, projectId)` の脱出（Traversal / 路径脱出）を構造的に封じる。
 *  - 大文字を除外したのは、Windows（大小無視）とLinux（大小厳密）で隔離単位がズレる事故を防ぐため。 */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** 業務例外。code で HTTP 状態像へマップする（ルート層が担当）。 */
export class KnowledgeError extends Error {
  constructor(message: string, public readonly code: string) { super(message); this.name = 'KnowledgeError'; }
}

/** プロジェクトIDを検証し、正規化（小文字化はしない — 規則自体が小文字のみ）して返す。 */
export function validateProjectId(projectId: unknown): string {
  const id = typeof projectId === 'string' ? projectId : '';
  if (!PROJECT_ID_PATTERN.test(id)) throw new KnowledgeError('プロジェクトIDは2〜64文字の英小文字・数字・ハイフン・アンダースコア（英数字始まり）で指定してください。', 'invalid_project_id');
  return id;
}

/** 元資料URL検証。http/https のみ。XSS（クロスサイトスクリプティング）の運び屋になる
 *  `javascript:` `data:` や、認証情報埋め込み（`https://user:pass@example.test/` — 秘密の漏えい経路）を拒否する。 */
export function validateSourceUrl(url: unknown): string {
  const value = typeof url === 'string' ? url.trim() : '';
  if (!value) throw new KnowledgeError('元資料URLは必須です。', 'invalid_url');
  if (value.length > MAX_URL_CHARS) throw new KnowledgeError(`元資料URLは${MAX_URL_CHARS}文字以内にしてください。`, 'invalid_url');
  // 制御文字・空白混じり（`java\tscript:` のようなパズリ）は parse 前に弾く
  if (/[\u0000- \u007f]/.test(value)) throw new KnowledgeError('元資料URLに制御文字や空白を含めません。', 'invalid_url');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new KnowledgeError('元資料URLは http/https の絶対URLで指定してください。', 'invalid_url'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new KnowledgeError('元資料URLは http または https のリンクだけにしてください。', 'invalid_url');
  if (parsed.username || parsed.password) throw new KnowledgeError('元資料URLへユーザー名・パスワードを埋め込めません。', 'invalid_url');
  return parsed.toString();
}

/** タイトル検証（空・過大・制御文字拒否）。 */
export function validateTitle(title: unknown): string {
  const value = typeof title === 'string' ? title.trim() : '';
  if (!value || value.length > MAX_TITLE_CHARS) throw new KnowledgeError(`タイトルは1〜${MAX_TITLE_CHARS}文字で指定してください。`, 'invalid_title');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new KnowledgeError('タイトルに制御文字を含めません。', 'invalid_title');
  return value;
}

/** 本文検証。文字数上限と、JSON保存を壊す孤立サロゲート等の制御文字を拒否する。 */
export function validateContent(content: unknown): string {
  const value = typeof content === 'string' ? content : '';
  if (!value.trim()) throw new KnowledgeError('資料本文は空にできません。', 'invalid_content');
  if (value.length > MAX_CONTENT_CHARS) throw new KnowledgeError(`資料本文は${MAX_CONTENT_CHARS}文字以内にしてください。`, 'content_too_large');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new KnowledgeError('資料本文に制御文字を含めません。', 'invalid_content');
  return value;
}

/** 検索クエリ検証。長さと、空・空白だけの無意味クエリを弾く。 */
export function validateQuery(query: unknown): string {
  const value = typeof query === 'string' ? query.trim() : '';
  if (!value) throw new KnowledgeError('検索文字列は必須です。', 'invalid_query');
  if (value.length > MAX_QUERY_CHARS) throw new KnowledgeError(`検索文字列は${MAX_QUERY_CHARS}文字以内にしてください。`, 'query_too_long');
  return value;
}

/* ============================================================ 字句検索（Lexical Search） */

/** 日本語・中国語圏の文字範囲（平仮名・片仮名・CJK統合漢字・互換漢字）。 */
const CJK_RANGES = /[぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * 字句トークン化（Tokenizer / トークナイザー）。
 *  - ASCII系: 英数字トークン（2文字以上）をそのまま。`Wentian` -> `wentian`
 *  - CJK系: 連続範囲から2文字すべり窓（bigram / バイグラム）。`権限設計` -> `権限`, `限設`, `設計`
 *    日本語は分かち書き（word segmentation / 分かち書き）無しでも検索できる実用解としてバイグラムを採用。
 *    1文字だけの範囲は単字（unigram）として残す（「値」など1字検索を生かす）。
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const match of lower.matchAll(/[a-z0-9_]{2,}/g)) tokens.push(match[0]);
  let run = '';
  const flush = () => {
    if (!run) return;
    if (run.length === 1) tokens.push(run);
    else for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run.slice(i, i + 2));
    run = '';
  };
  for (const char of lower) {
    if (CJK_RANGES.test(char)) run += char;
    else flush();
  }
  flush();
  return tokens;
}

/** 本文を行維持のままチャンクへ分割する。行番号は引用表示の根拠になるため1始まりで保持する。 */
export function buildChunks(documentId: string, revision: number, content: string): KnowledgeChunk[] {
  const lines = content.split(/\r\n|\n|\r/);
  const chunks: KnowledgeChunk[] = [];
  let buffer: { text: string; lineStart: number; lineEnd: number } | undefined;
  const push = () => {
    if (!buffer) return;
    chunks.push({
      chunkId: `${documentId}#r${revision}#${chunks.length}`,
      revision, lineStart: buffer.lineStart, lineEnd: buffer.lineEnd, text: buffer.text, active: true,
    });
    buffer = undefined;
  };
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    // 改行のないWeb本文でも、同じ行番号を保った有限サイズの断片に分けます。
    if(line.length>CHUNK_MAX_CHARS){
      push();
      for(let offset=0;offset<line.length;){
        let end=Math.min(offset+CHUNK_MAX_CHARS,line.length);
        // 絵文字などのサロゲートペアを途中で分断しません。
        if(end<line.length&&line.charCodeAt(end-1)>=0xD800&&line.charCodeAt(end-1)<=0xDBFF)end--;
        chunks.push({chunkId:`${documentId}#r${revision}#${chunks.length}`,revision,lineStart:lineNumber,lineEnd:lineNumber,text:line.slice(offset,end),active:true});
        offset=end;
      }
      return;
    }
    if (!buffer) { buffer = { text: line, lineStart: lineNumber, lineEnd: lineNumber }; return; }
    const merged = `${buffer.text}\n${line}`;
    // 行数・文字数のどちらかでも超えたら確定して次のチャンクへ（行を跨いで途中切断しない）
    if (merged.length > CHUNK_MAX_CHARS || buffer.lineEnd - buffer.lineStart + 2 > CHUNK_MAX_LINES) { push(); buffer = { text: line, lineStart: lineNumber, lineEnd: lineNumber }; return; }
    buffer = { text: merged, lineStart: buffer.lineStart, lineEnd: lineNumber };
  });
  push();
  return chunks;
}

/** 本文ハッシュ（sha256）。引用の「この改訂のこの内容」という照合単位。 */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 抜粋（excerpt）生成: マッチ行を中心に前後1行、最大400文字で切る。 */
function makeExcerpt(chunkText: string, matchLine: number, chunk: KnowledgeChunk): string {
  const lines = chunkText.split('\n');
  const offset = Math.max(0, Math.min(lines.length - 1, matchLine - chunk.lineStart));
  const from = Math.max(0, offset - 1);
  const to = Math.min(lines.length, offset + 2);
  const excerpt = lines.slice(from, to + 1).join('\n');
  return excerpt.length > 400 ? `${excerpt.slice(0, 400)}…` : excerpt;
}

/** チャンク単位でスコアを計算。一致した別トークン数→延べ出現数の順で重み、最も多く一致した行を抜粋の中心にする。 */
function scoreChunk(chunk: KnowledgeChunk, queryTokens: string[]): { score: number; excerpt: string } | undefined {
  let distinct = 0;
  let total = 0;
  let bestLine = chunk.lineStart;
  let bestLineHits = 0;
  const lowerChunk = chunk.text.toLowerCase();
  const lines = lowerChunk.split('\n');
  for (const token of new Set(queryTokens)) {
    let hits = 0;
    let cursor = lowerChunk.indexOf(token);
    if (cursor < 0) continue;
    distinct += 1;
    while (cursor >= 0) { hits += 1; cursor = lowerChunk.indexOf(token, cursor + token.length); }
    total += hits;
    // 行あたりのヒット数も数え、抜粋の中心行を決める（最初に多く当たった行を抜粋中央へ）
    let lineHits = 0;
    let candidateLine = -1;
    lines.forEach((line, index) => {
      if (!line.includes(token)) return;
      if (lineHits === 0) candidateLine = chunk.lineStart + index;
      lineHits += 1;
    });
    if (candidateLine >= 0 && lineHits > bestLineHits) { bestLineHits = lineHits; bestLine = candidateLine; }
  }
  if (distinct === 0) return undefined;
  return { score: distinct * 100 + total, excerpt: makeExcerpt(chunk.text, bestLine, chunk) };
}

/* ============================================================ ストア（Store） */

/** 専用ルート（dedicated root）既定値: ①環境変数、②本機設定目录（machineConfigDirectory）配下。
 *  リポジトリ内 `.wentian/` を既定にしないのは、Git管理下へ他人の資料本文を混入させないため。 */
export function projectKnowledgeRoot(): string {
  if (process.env.WENTIAN_PROJECT_KNOWLEDGE_ROOT) return path.resolve(process.env.WENTIAN_PROJECT_KNOWLEDGE_ROOT);
  return path.join(machineConfigDirectory(), 'project-knowledge');
}

/**
 * プロジェクト別ナレッジストア。
 *  - 保存: `<root>/projects/<projectId>.json`（プロジェクトごとに1ファイル = 隔離が目で見て分かる）
 *  - 原子的保存: 同ディレクトリの一時ファイル → renameWithRetry（Windowsのファイルロックも再試行）
 *  - 競合対処: 進程内はプロジェクト別Mutexで read-modify-write を直列化、
 *    進程間・画面複数タブ間は expectedRevision（楽観的ロック）で 409相当 を返す。
 */
export class ProjectKnowledgeStore {
  readonly root: string;
  /** プロジェクトID → 直列化中の後尾Promise（進程内Mutex） */
  private readonly locks = new Map<string, Promise<unknown>>();

  private readonly embedder?: KnowledgeEmbedder;
  constructor(options: { root?: string; embedder?: KnowledgeEmbedder } = {}) {
    this.embedder = options.embedder;
    this.root = path.resolve(options.root || projectKnowledgeRoot());
  }

  /** プロジェクトファイルの絶対パス。projectId は必ず validateProjectId を通した値だけを受け取る。 */
  private projectFile(projectId: string): string {
    return path.join(this.root, 'projects', `${validateProjectId(projectId)}.json`);
  }

  /** プロジェクト単位の直列実行。ロック自体の失敗で後続が詰まらないよう、常にロック列へ積んで返す。 */
  private async withLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(projectId, previous.then(() => gate));
    await previous.catch(() => undefined);
    let handle;
    const lockPath = `${this.projectFile(projectId)}.lock`;
    try {
      await this.assertSafeAncestors();
      await mkdir(path.dirname(lockPath), { recursive: true });
      // 複数インスタンス・複数プロセスの登録を同じ排他で保護する。
      // 残存ロックは勝手に解除せず、停止状態を管理者が確認するまで更新を拒否する。
      for (let attempt = 0; attempt < 200; attempt++) {
        try { handle = await open(lockPath, 'wx', 0o600); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Windowsでは削除直後の排他ファイルが一時的にEPERM/EACCESになります。
          // 有限回だけ待機し、取得できない場合は台帳を変更せず使用中として返します。
          if (code !== 'EEXIST' && !(process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'))) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      if (!handle) throw new KnowledgeError('資料台帳が使用中、または中断後の排他確認待ちです。', 'ledger_busy');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return await work();
    } finally { if (handle) { await handle.close(); await unlink(lockPath); } release(); }
  }

  /** 管理領域のリンクとハードリンク（Hard Link）を読込・更新の両方で拒否する。 */
  private async assertSafeAncestors(target = this.root): Promise<void> {
    let cursor = path.resolve(target);
    while (true) {
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new KnowledgeError('リンク経由の資料台帳は扱えません。', 'unsafe_ledger_path');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  }

  /** 台帳読込。未作成は空、壊れたJSONは例外（黙って空にして上書きする事故を防ぐ）。 */
  private async readLedger(projectId: string): Promise<ProjectLedger> {
    await this.assertSafeAncestors(this.projectFile(projectId));
    try {
      const parsed = JSON.parse(await readFile(this.projectFile(projectId), 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.documents)) throw new KnowledgeError('プロジェクト台帳の形式が不正です。再作成または復元が必要です。', 'ledger_corrupted');
      return { version: 1, projectId, documents: parsed.documents, vectorIndex: parsed.vectorIndex };
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { version: 1, projectId, documents: [] };
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('プロジェクト台帳を読み取れません。破損している可能性があります。', 'ledger_corrupted');
    }
  }

  /** 原子的保存。tmp は PID+乱数で同名衝突を避け、0o600 で他ユーザー可読を防ぐ（POSIX側での抑止）。 */
  private async writeLedger(ledger: ProjectLedger): Promise<void> {
    const target = this.projectFile(ledger.projectId);
    await this.assertSafeAncestors(target);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameWithRetry(temporary, target);
    // 変更・削除した本文の派生ベクトルを保持せず、現行版の署名だけを残します。
    const cache=await KnowledgeVectorCache.open(this.root,ledger.projectId);
    try{cache.prune(this.embedder?.id||'',new Map(ledger.documents.filter(d=>this.currentEvidence(d,ledger.documents)).flatMap(d=>d.chunks.map(c=>[c.chunkId,contentHash(d.title+'\n'+d.contentHash)] as [string,string]))))}finally{cache.close()}

  }

  /** 資料登録（create）。revision=1、documentId はサーバー発行。 */
  async register(projectId: string, input: { title: unknown; url: unknown; content: unknown }): Promise<KnowledgeDocument> {
    const id = validateProjectId(projectId);
    const title = validateTitle(input?.title);
    const url = validateSourceUrl(input?.url);
    const content = validateContent(input?.content);
    return this.withLock(id, async () => {
      const ledger = await this.readLedger(id);
      const now = new Date().toISOString();
      const documentId = randomBytes(12).toString('hex');
      const document: KnowledgeDocument = {
        documentId, title, url, content,
        contentHash: contentHash(content), revision: 1,
        createdAt: now, updatedAt: now,
        chunks: buildChunks(documentId, 1, content), superseded: [],
      };
      delete ledger.vectorIndex;
      ledger.documents.push(document);
      await this.writeLedger(ledger);
      return document;
    });
  }

  /**
   * 資料更新（update）。
   *  - expectedRevision を渡したら現改訂と違い、旧改訂の画面からの上書き（Lost Update）を 409相当で拒否。
   *  - 旧改訂チャンクは本文ごと破棄し、superseded へ「改訂番号・ハッシュ・失効時刻」だけ残す。
   *    → 更新後の検索で古い内容がヒットせず、失効本文の漏洩もしない。
   */
  async update(projectId: string, documentId: string, input: { title?: unknown; url?: unknown; content?: unknown; expectedRevision?: unknown }): Promise<KnowledgeDocument> {
    const id = validateProjectId(projectId);
    const expected = input?.expectedRevision === undefined ? undefined : Number(input.expectedRevision);
    if (expected !== undefined && (!Number.isInteger(expected) || expected < 1)) throw new KnowledgeError('expectedRevision は1以上の整数で指定してください。', 'invalid_revision');
    return this.withLock(id, async () => {
      const ledger = await this.readLedger(id);
      const document = ledger.documents.find(value => value.documentId === String(documentId));
      if (!document) throw new KnowledgeError('資料が見つかりません。', 'not_found');
      if (expected !== undefined && expected !== document.revision) throw new KnowledgeError(`資料が更新されています（現改訂 ${document.revision}）。最新を読み直して再試行してください。`, 'revision_conflict');
      const title = input?.title === undefined ? document.title : validateTitle(input.title);
      const url = input?.url === undefined ? document.url : validateSourceUrl(input.url);
      const content = input?.content === undefined ? document.content : validateContent(input.content);
      const now = new Date().toISOString();
      if (content !== document.content || title !== document.title || url !== document.url) {
        if (content !== document.content) {
          // 本文が変わった時だけ改訂を進める。旧チャンクは本文ごと捨て、失効記録だけ残す
          document.superseded.push({ revision: document.revision, contentHash: document.contentHash, supersededAt: now });
          document.revision += 1;
          document.content = content;
          document.contentHash = contentHash(content);
          document.chunks = buildChunks(document.documentId, document.revision, content);
        }
        document.title = title;
        document.url = url;
        document.updatedAt = now;
        delete ledger.vectorIndex;
        await this.writeLedger(ledger);
      }
      return document;
    });
  }

  /** 資料削除（remove）。失効記録ごと無くなる（台帳から完全除去）。 */
  async remove(projectId: string, documentId: string): Promise<{ removed: true; documentId: string }> {
    const id = validateProjectId(projectId);
    return this.withLock(id, async () => {
      const ledger = await this.readLedger(id);
      const index = ledger.documents.findIndex(value => value.documentId === String(documentId));
      if (index < 0) throw new KnowledgeError('資料が見つかりません。', 'not_found');
      delete ledger.vectorIndex;
      ledger.documents.splice(index, 1);
      await this.writeLedger(ledger);
      return { removed: true, documentId: String(documentId) };
    });
  }

  /** 一覧（list）。本文・チャンクを落とす軽量メタだけを返す。 */
  async list(projectId: string): Promise<KnowledgeDocumentMeta[]> {
    const id = validateProjectId(projectId);
    const ledger = await this.readLedger(id);
    return ledger.documents
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ documentId, title, url, revision, contentHash: hash, createdAt, updatedAt, content, collection }) => ({
        documentId, title, url, revision, contentHash: hash, createdAt, updatedAt, contentChars: content.length, ...(collection?{collection}:{}),
      }));
  }

  /** 引用元取得（get）。現改訂の本文・URL・改訂情報とチャンク位置を返す（引用元の提示用）。 */
  async get(projectId: string, documentId: string): Promise<KnowledgeDocument> {
    const id = validateProjectId(projectId);
    const ledger = await this.readLedger(id);
    const document = ledger.documents.find(value => value.documentId === String(documentId));
    if (!document) throw new KnowledgeError('資料が見つかりません。', 'not_found');
    return document;
  }

  /**
   * 字句検索（lexical search）。
   *  - 現改訂の active チャンクだけを対象にする（更新後旧チャンクはストア側に存在しない）。
   *  - ヒットには必ず documentId/title/url/excerpt/行番号/revision/contentHash を添える（根拠付き検索）。
   *  - スコア: 一致別トークン数×100＋延べ出現数。同スコアは更新日時新しい順。
   */
  async search(projectId: string, query: string, limit = 8, mode: 'auto' | 'lexical' | 'vector' | 'hybrid' = 'auto'): Promise<KnowledgeSearchHit[]> {
    if(!['auto','lexical','vector','hybrid'].includes(mode))throw new KnowledgeError('検索方式が不正です。','invalid_search_mode');
    if(mode!=='lexical'&&(this.embedder||mode!=='auto'))return this.semanticSearch(projectId,query,limit,mode==='vector'?'vector':'hybrid');
    const id = validateProjectId(projectId);
    const text = validateQuery(query);
    const size = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, MAX_SEARCH_LIMIT) : 8;
    const tokens = tokenize(text);
    if (tokens.length === 0) throw new KnowledgeError('検索文字列から語を抽出できませんでした。文字または数字を含めてください。', 'invalid_query');
    const ledger = await this.readLedger(id);
    const hits: KnowledgeSearchHit[] = [];
    for (const document of ledger.documents) {
      if(!this.currentEvidence(document,ledger.documents))continue;
      let best: { score: number; excerpt: string; chunk: KnowledgeChunk } | undefined;
      for (const chunk of document.chunks) {
        if (!chunk.active || chunk.revision !== document.revision) continue; // 保険: 念のため現改訂activeのみ
        // 題名だけの一致は全検索語が含まれる場合に限り、断片的な部分一致の混入を抑えます。
        const titleScore=tokens.every(token=>document.title.toLowerCase().includes(token))?(scoreChunk({...chunk,text:document.title},tokens)?.score||0):0;
        const bodyScore=scoreChunk(chunk,tokens);
        const scored=bodyScore?{...bodyScore,score:bodyScore.score+titleScore}:titleScore?{score:titleScore,excerpt:chunk.text}:undefined;
        if (scored && (!best || scored.score > best.score)) best = { ...scored, chunk };
      }
      if (best) hits.push({
        documentId: document.documentId, title: document.title, url: document.url,
        excerpt: best.excerpt, lineStart: best.chunk.lineStart, lineEnd: best.chunk.lineEnd, chunkId: best.chunk.chunkId,
        revision: document.revision, contentHash: document.contentHash, score: best.score,
      });
    }
    hits.sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId));
    return hits.slice(0, size);
  }

  /** 保存した成果の根拠が更新・削除された場合、二次資料から旧事実を再利用しません。 */
  private currentEvidence(document:KnowledgeDocument,documents:KnowledgeDocument[],seen=new Set<string>()):boolean{
    if(seen.has(document.documentId))return false;
    const next=new Set(seen);next.add(document.documentId);
    return !document.provenance||document.provenance.every(ref=>{const source=documents.find(d=>d.documentId===ref.documentId);return source&&source.contentHash===ref.contentHash&&source.revision===ref.revision&&source.title===ref.title&&source.url===ref.url&&this.currentEvidence(source,documents,next)});
  }
  async evidenceCurrent(projectId:string,documentId:string){const ledger=await this.readLedger(validateProjectId(projectId)),document=ledger.documents.find(d=>d.documentId===documentId);return Boolean(document&&this.currentEvidence(document,ledger.documents))}

  /** 設定済みかどうかだけを返し、接続先・秘密キーはAPIへ返しません。 */
  get vectorEnabled(): boolean { return Boolean(this.embedder); }

  /** URL収集結果を原子的に保存。取得中の編集を改訂番号で保護し、重複URLを作りません。 */
  async saveCollected(projectId: string, input: { title: string; url: string; content: string }, expectedRevision?: number, expectedUpdatedAt?: string): Promise<KnowledgeDocument> {
    const id=validateProjectId(projectId),title=validateTitle(input.title),url=validateSourceUrl(input.url),content=validateContent(input.content);
    return this.withLock(id,async()=>{
      const ledger=await this.readLedger(id),existing=ledger.documents.find(d=>d.url===url);
      if(existing){
        if(expectedRevision!==existing.revision||(expectedUpdatedAt!==undefined&&expectedUpdatedAt!==existing.updatedAt))throw new KnowledgeError('収集中に資料が更新されました。再取得してください。','revision_conflict');
        if(existing.content!==content){existing.superseded.push({revision:existing.revision,contentHash:existing.contentHash,supersededAt:new Date().toISOString()});existing.revision++;existing.content=content;existing.contentHash=contentHash(content);existing.chunks=buildChunks(existing.documentId,existing.revision,content)}
        existing.title=title;existing.updatedAt=new Date().toISOString();delete ledger.vectorIndex;await this.writeLedger(ledger);return existing;
      }
      if(expectedRevision!==undefined)throw new KnowledgeError('取得中に資料が削除されました。','revision_conflict');
      const documentId=randomBytes(12).toString('hex'),now=new Date().toISOString();
      const document:KnowledgeDocument={documentId,title,url,content,contentHash:contentHash(content),revision:1,createdAt:now,updatedAt:now,chunks:buildChunks(documentId,1,content),superseded:[]};
      ledger.documents.push(document);delete ledger.vectorIndex;await this.writeLedger(ledger);return document;
    });
  }

  /** 大きな資料も省略せず分割し、一つの取得結果として原子的に保存します。 */
  async saveCollectedBundle(projectId:string,input:{title:string;url:string;content:string},expected:KnowledgeDocumentMeta[],provenance?:KnowledgeDependency[]):Promise<KnowledgeDocument[]> {
    const id=validateProjectId(projectId),sourceUrl=validateSourceUrl(input.url),title=validateTitle(input.title);
    if(!input.content.trim()||input.content.length>10000000)throw new KnowledgeError('抽出本文は空にせず、1000万文字以内で指定してください。','content_too_large');
    const parts:string[]=[];
    for(let offset=0;offset<input.content.length;){let end=Math.min(offset+MAX_CONTENT_CHARS,input.content.length);if(end<input.content.length&&input.content.charCodeAt(end-1)>=0xD800&&input.content.charCodeAt(end-1)<=0xDBFF)end--;parts.push(validateContent(input.content.slice(offset,end)));offset=end}
    return this.withLock(id,async()=>{
      const ledger=await this.readLedger(id),current=ledger.documents.filter(d=>d.collection?.sourceUrl===sourceUrl||d.url===sourceUrl);
      if(provenance?.some(ref=>{const d=ledger.documents.find(d=>d.documentId===ref.documentId);return !d||d.contentHash!==ref.contentHash||d.revision!==ref.revision||d.title!==ref.title||d.url!==ref.url||!this.currentEvidence(d,ledger.documents)}))throw new KnowledgeError('保存前に根拠資料が更新されました。再回答してください。','revision_conflict');
      for(const doc of current){const prior=expected.find(d=>d.documentId===doc.documentId);if(!prior||prior.revision!==doc.revision||prior.updatedAt!==doc.updatedAt||prior.contentHash!==doc.contentHash||prior.title!==doc.title||prior.url!==doc.url)throw new KnowledgeError('取得中に資料が更新されました。','revision_conflict')}
      const expectedSource=expected.filter(d=>d.url===sourceUrl||d.collection?.sourceUrl===sourceUrl);if(expectedSource.some(prior=>!current.some(d=>d.documentId===prior.documentId)))throw new KnowledgeError('取得中に資料が削除されました。','revision_conflict');
      const result:KnowledgeDocument[]=[],now=new Date().toISOString();
      for(let index=0;index<parts.length;index++){
        const source=new URL(sourceUrl);if(index)source.hash='wentian-part='+String(index+1);const url=source.href;
        let doc=ledger.documents.find(d=>d.url===url);
        if(doc&&!current.some(d=>d.documentId===doc!.documentId))throw new KnowledgeError('分割資料のURLが既存資料と競合しています。','revision_conflict');
        const content=parts[index],partTitle=(parts.length===1?title:title.slice(0,170)+'（'+(index+1)+'/'+parts.length+'）');
        if(doc){if(doc.content!==content){doc.superseded.push({revision:doc.revision,contentHash:doc.contentHash,supersededAt:now});doc.revision++;doc.updatedAt=now;doc.content=content;doc.contentHash=contentHash(content);doc.chunks=buildChunks(doc.documentId,doc.revision,content)}if(doc.title!==partTitle||doc.content!==content)doc.updatedAt=now;doc.title=partTitle}
        else{const documentId=randomBytes(12).toString('hex');doc={documentId,title:partTitle,url,content,contentHash:contentHash(content),revision:1,createdAt:now,updatedAt:now,chunks:buildChunks(documentId,1,content),superseded:[]};ledger.documents.push(doc)}
        doc.collection={sourceUrl,part:index+1,total:parts.length};if(provenance)doc.provenance=provenance;result.push(doc);
      }
      const keep=new Set(result.map(d=>d.documentId));ledger.documents=ledger.documents.filter(d=>d.collection?.sourceUrl!==sourceUrl||keep.has(d.documentId));delete ledger.vectorIndex;await this.writeLedger(ledger);return result;
    });
  }

  /** 認証設定・秘密キー・派生ベクトルを含めず、現行資料をバックアップします。 */
  async backup(projectId:string){
    const ledger=await this.readLedger(validateProjectId(projectId));
    const documents=ledger.documents.map(({chunks,...document})=>document);
    const payload={format:'wentian-project-knowledge/1',projectId,documents};
    return{...payload,digest:contentHash(JSON.stringify(payload))};
  }

  /** 復元は既存資料を上書きせず、全件を検証してから原子的に追加します。 */
  async restore(projectId:string,value:any){
    const id=validateProjectId(projectId);
    if(value?.format!=='wentian-project-knowledge/1'||!Array.isArray(value.documents)||value.documents.length>100000||typeof value.projectId!=='string'||value.digest!==contentHash(JSON.stringify({format:value.format,projectId:value.projectId,documents:value.documents})))throw new KnowledgeError('バックアップの形式またはハッシュが不正です。','invalid_backup');
    const ids=new Set<string>(),urls=new Set<string>();
    const restored=value.documents.map((raw:any):KnowledgeDocument=>{
      if(!raw||typeof raw.documentId!=='string'||!/^[a-f0-9]{24}$/.test(raw.documentId)||ids.has(raw.documentId)||!Number.isSafeInteger(raw.revision)||raw.revision<1||!Number.isFinite(Date.parse(raw.createdAt))||!Number.isFinite(Date.parse(raw.updatedAt)))throw new KnowledgeError('バックアップの資料情報が不正です。','invalid_backup');
      if(raw.provenance!==undefined&&(!Array.isArray(raw.provenance)||raw.provenance.length>32||raw.provenance.some((ref:any)=>!ref||typeof ref.documentId!=='string'||!/^[a-f0-9]{24}$/.test(ref.documentId)||typeof ref.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(ref.contentHash)||!Number.isSafeInteger(ref.revision)||ref.revision<1||typeof ref.title!=='string'||typeof ref.url!=='string')))throw new KnowledgeError('成果の出典情報が不正です。','invalid_backup');
      const title=validateTitle(raw.title),url=validateSourceUrl(raw.url),content=validateContent(raw.content);if(urls.has(url))throw new KnowledgeError('バックアップに重複した出典があります。','invalid_backup');ids.add(raw.documentId);urls.add(url);
      return{...(raw.provenance?{provenance:raw.provenance}:{}),documentId:raw.documentId,title,url,content,contentHash:contentHash(content),revision:raw.revision,createdAt:raw.createdAt,updatedAt:raw.updatedAt,chunks:buildChunks(raw.documentId,raw.revision,content),superseded:[]};
    });
    return this.withLock(id,async()=>{const ledger=await this.readLedger(id);if(ledger.documents.some(d=>ids.has(d.documentId)||urls.has(d.url)))throw new KnowledgeError('既存資料と衝突するため復元しません。空のプロジェクトを選択してください。','revision_conflict');ledger.documents.push(...restored);delete ledger.vectorIndex;await this.writeLedger(ledger);return{restored:restored.length}});
  }

  async indexProgress(projectId:string){const ledger=await this.readLedger(validateProjectId(projectId));const total=ledger.documents.filter(d=>this.currentEvidence(d,ledger.documents)).reduce((sum,d)=>sum+d.chunks.length,0);if(!this.embedder)return{enabled:false,total,indexed:0,complete:false};const cache=await KnowledgeVectorCache.open(this.root,projectId);try{const indexed=cache.validCount(this.embedder.id,new Map(ledger.documents.filter(d=>this.currentEvidence(d,ledger.documents)).flatMap(d=>d.chunks.map(c=>[c.chunkId,contentHash(d.title+'\n'+d.contentHash)] as [string,string]))));return{enabled:true,total,indexed,complete:total===indexed}}finally{cache.close()}}
  async prepareIndex(projectId:string){const ledger=await this.readLedger(validateProjectId(projectId));if(ledger.documents.length)await this.search(projectId,ledger.documents[0].title,1,'vector');return this.indexProgress(projectId)}

  /** 埋め込みで意味検索し、必要なら字句検索と順位を融合します。固定の自然言語辞書は使用しません。 */
  private async semanticSearch(projectId:string,query:string,limit:number,mode:'vector'|'hybrid'):Promise<KnowledgeSearchHit[]> {
    const id=validateProjectId(projectId),text=validateQuery(query),embedder=this.embedder;
    if(!embedder)throw new KnowledgeError('ベクトル検索には埋め込み接続先とモデルの設定が必要です。','embedding_not_configured');
    const snapshot=await this.readLedger(id),rows=snapshot.documents.filter(d=>this.currentEvidence(d,snapshot.documents)).flatMap(document=>document.chunks.filter(c=>c.active&&c.revision===document.revision).map(chunk=>({document,chunk})));
    const maximum=Number(process.env.WENTIAN_KNOWLEDGE_MAX_CHUNKS||100000);if(!Number.isSafeInteger(maximum)||maximum<1||maximum>1000000)throw new KnowledgeError('索引上限の設定を確認してください。','index_too_large');
    if(rows.length>maximum)throw new KnowledgeError('設定した索引上限に達しました。上限設定またはプロジェクトの分割を確認してください。','index_too_large');
    if(!rows.length)return [];
    const entries:VectorIndex['entries']={};
    const cache=await KnowledgeVectorCache.open(this.root,id);let partial=false;
    const signature=(document:KnowledgeDocument)=>contentHash(document.title+'\n'+document.contentHash);
    const signal=AbortSignal.timeout(60000);
    try{
      const queryVector=normalizedVector((await embedder.embed([text],signal))[0]);signal.throwIfAborted();
      const missing=rows.filter(({document,chunk})=>{
        const persisted=cache.get(embedder.id,chunk.chunkId,signature(document),queryVector.length);
        if(persisted){entries[chunk.chunkId]={hash:document.contentHash,vector:persisted};return false}
        return true;
      });
      for(let offset=0;offset<missing.length;offset+=32){
        signal.throwIfAborted();
        const batch=missing.slice(offset,offset+32),vectors=await embedder.embed(batch.map(({document,chunk})=>document.title+'\n'+chunk.text),signal);signal.throwIfAborted();
        if(vectors.length!==batch.length)throw new Error('埋め込み件数が不正です。');
        batch.forEach(({document,chunk},index)=>{entries[chunk.chunkId]={hash:document.contentHash,vector:normalizedVector(vectors[index],queryVector.length)}});
        const current=await this.readLedger(id);if(JSON.stringify(current.documents.map(d=>[d.documentId,d.contentHash,d.title,d.url,d.revision]))!==JSON.stringify(snapshot.documents.map(d=>[d.documentId,d.contentHash,d.title,d.url,d.revision])))throw new KnowledgeError('索引作成中に資料が更新されました。再検索してください。','revision_conflict');
        cache.put(embedder.id,batch.map(({document,chunk})=>({chunk:chunk.chunkId,signature:signature(document),vector:entries[chunk.chunkId].vector})));partial=true;
      }
      // 外部通信中は台帳をロックしません。保存直前に版を比較し、古い索引で回答しません。
      await this.withLock(id,async()=>{
        const current=await this.readLedger(id);
        const version=(docs:KnowledgeDocument[])=>JSON.stringify(docs.map(d=>[d.documentId,d.contentHash,d.title,d.url,d.revision]));
        if(version(current.documents)!==version(snapshot.documents))throw new KnowledgeError('索引作成中に資料が更新されました。再検索してください。','revision_conflict');
        current.vectorIndex={provider:embedder.id,entries:{}};await this.writeLedger(current);
        cache.prune(embedder.id,new Map(rows.map(row=>[row.chunk.chunkId,signature(row.document)])));
      });
      const ranked=rows.map(({document,chunk})=>({document,chunk,score:entries[chunk.chunkId].vector.reduce((sum,value,index)=>sum+value*queryVector[index],0)})).sort((a,b)=>b.score-a.score||a.chunk.chunkId.localeCompare(b.chunk.chunkId));
      const lexical=mode==='hybrid'?await this.search(id,text,MAX_SEARCH_LIMIT,'lexical'):[];
      const lexicalRank=new Map(lexical.map((hit,index)=>[hit.documentId,index+1]));
      const hits=ranked.map(({document,chunk,score},index):KnowledgeSearchHit=>({documentId:document.documentId,title:document.title,url:document.url,excerpt:chunk.text,lineStart:chunk.lineStart,lineEnd:chunk.lineEnd,chunkId:chunk.chunkId,revision:document.revision,contentHash:document.contentHash,score:mode==='hybrid'?1/(60+index+1)+(lexicalRank.has(document.documentId)?1/(60+lexicalRank.get(document.documentId)!):0):score}));
      hits.sort((a,b)=>b.score-a.score||a.chunkId.localeCompare(b.chunkId));
      return hits.slice(0,Number.isInteger(limit)&&limit>=1?Math.min(limit,MAX_SEARCH_LIMIT):8);
    }catch(error){if(error instanceof KnowledgeError)throw error;if(signal.aborted&&partial)throw new KnowledgeError('索引を途中まで保存しました。再実行すると残りから再開します。','index_building');throw new KnowledgeError('埋め込みの生成または索引の検証に失敗しました。接続設定とモデルを確認してください。','embedding_failed')}finally{cache.close()}
  }

}
