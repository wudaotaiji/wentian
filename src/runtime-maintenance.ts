/**
 * Runtime Maintenance: Wentian Gateway の **状態ファイル限定** バックアップ（Backup）/ 検証（Verify）/ 復元（Restore）。
 *
 * 目的（Scope）
 * ------------
 * 長期Goal（Goal Store / L1）とトランザクションログ（Transaction Log）は電源断・強制終了を前提に設計されていますが、
 * 「状態ファイル自体を壊した」「更新途中で書き込み失敗した」場合の戻し方は goal-store / goal-transaction にありません。
 * 本モジュールは **更新失敗からの復旧（Recovery from Failed Update）** に限り、管理下の状態ファイルを
 * SHA256 で検証しつつ復元します。
 *
 * 未実装である旨を明示する範囲（Out of Scope / Not Implemented）
 * ----------------------------------------------------------
 * - アプリケーションのバージョン更新失敗からの復旧（Application Version Rollback）は **未実装**。
 *   復元するのは状態ファイルだけなので、コード・イメージ・依存パッケージの世代違いを戻せません。
 *   状態だけ過去の世代へ戻すと、新しいコードが古い状態を読み違う挙動をします。よって
 *   バージョン更新の復旧が必要なら、状態復旧ではなく **リリース手順のロールバック** を使ってください。
 * - DB（Database）・Kubernetes・メッセージブローカーの状態は対象外（本リポジトリの状態root外のため）。
 *
 * 安全設計（Safety Invariants）
 * ----------------------------
 * 1. 既知の状態ファイル（Known State Files）だけを対象にする。未知のファイルは backup にも restore にも出さない。
 *    「既知」= goal-store が生成する `<goal-id>.json` / `<goal-id>.json.pause` / `<goal-id>/tx/<todo-id>.json` の3種類のみ。
 *    対象rootは呼び出し側が明示した専用状態root（Dedicated State Root）に限る。
 * 2. 任意の絶対パス（Absolute Path）と `..` を拒否する。名前は常にroot相対で扱い、正規化後にroot外へ出た場合は拒否。
 * 3. シンボリックリンク（Symbolic Link）/ Windows のジャンクション・リPARSE Point を拒否する。
 *    root 配下の各階層を lstat で辿り、実体（realpath）がroot内に収まることも併せて確認する。
 * 4. 認証情報（Credential / Secret）らしき名前は登録・ backup・ restore の全段階で拒否する。
 * 5. 復元には `runtimeStopped: true` の明示指定を必須とする（稼働中に復元しない）。加えて自動検知でも弾く。
 * 6. 他人の作業状態を上書きしない。稼働中の実子プロセス（Active Writer）がいる場合、および
 *    稼働していないが稼働中のトランザクション（Incomplete Transaction）が残っている場合は拒否。
 * 7. 復元前に全バックアップ内容を検査（Pre-flight Inspection）する。1つでも破損があれば **1バイトも適用しない**
 *    （All-or-Nothing）。適用中に失敗した場合は復元前の自分のコピーへ自動で戻す（Rollback of Restore）。
 *
 * 依存（Dependencies）: Node.js 標準ライブラリのみ。ネットワーク（Network）、LLM 呼出し、git 操作は行わない。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './atomic-file.js';

/** 対象として登録できる既知の状態ファイルの種類（Known State File Kind）。 */
export type KnownStateKind = 'goal' | 'pause' | 'transaction';

/** 台帳（Manifest）1件分の実体証拠（Evidence）。 */
export interface StateFileEntry {
  /** 専用状態rootからの相対パス（常に posix 形式 `/` 区切りで正規化する）。 */
  name: string;
  kind: KnownStateKind;
  sha256: string;
  bytes: number;
  mtimeMs: number;
}

/** バックアップセット全体の台帳（Backup Manifest）。 */
export interface BackupManifest {
  version: '1.0';
  backupId: string;
  /** 復旧対象の管理スコープ。状態ファイル限定であることを台帳に刻む（バージョン復旧は未実装）。 */
  scope: 'managed-state-only';
  /** 復元時に要求する明示フラグ。台帳を見た作業者が「要 runtimeStopped」を推測しなくて済むようにする。 */
  restoreRequires: 'runtimeStopped=true';
  stateRoot: string;
  createdAt: string;
  files: StateFileEntry[];
  /** 対象だが読めなかった／検査で弾いたファイル（空が正常）。 */
  rejected: Array<{ name: string; reason: string }>;
}

/** 破損・不一致の報告（Inspection Finding）。 */
export interface InspectionFinding {
  name: string;
  ok: boolean;
  detail: string;
}

/** 復元前検査（Pre-flight Inspection）の結果。 */
export interface InspectionResult {
  passed: boolean;
  findings: InspectionFinding[];
}

/** 稼働中の実子プロセス／未完了トランザクションの検知結果（Active Writer Detection）。 */
export interface ActiveWriterReport {
  /** 生存しているpidを持つ未完了トランザクションがある（＝確実に稼働中）。 */
  running: boolean;
  /** 稼働中と判定した理由（作業者がそのまま理解できる文章）。 */
  reasons: string[];
  /** 各未完了トランザクションの生存判定内訳。 */
  transactions: Array<{ name: string; pid: number; phase: string; alive: boolean }>;
  /** 中断（強制終了）後に残った未完了トランザクション（pidは死んでいる＝stale）。 */
  staleTransactions: string[];
  /** 中断要求ファイル（`.pause`）の数。 */
  pauseFiles: number;
}

/** 復元（Restore）の結果。 */
export interface RestoreResult {
  restored: string[];
  skipped: string[];
  /** 適用中に失敗して復元前コピーへ巻き戻したファイル。 */
  rolledBack: string[];
  /** 復元前に退避した自分のコピーの保存先（人が確認できる場所に保持する）。 */
  preRestoreDir: string;
  /** 検知できていたstale トランザクションの数（参考情報）。 */
  staleTransactions: number;
  /** 意味: restore_result.summary */
  summary: string;
}

/** 検証（Verify）の結果。 */
export interface VerifyResult {
  backupId: string;
  /** バックアップコピー自体が台帳と一致しているか（＝バックアップが無傷）。 */
  backupIntact: boolean;
  /** 実状態がバックアップ取得時から変わっているファイル（＝他者が更新した可能性）。 */
  drifted: string[];
  /** 実状態に存在しない（削除された）ファイル。 */
  missing: string[];
  findings: InspectionFinding[];
  summary: string;
}

/** goal-transaction の `phase` のうち「まだ実行中」を意味する値（goal-transaction.ts と対応）。 */
const INCOMPLETE_TX_PHASES: readonly string[] = ['start', 'checkpoint', 'running'];

/** 認証情報（Credential / Secret）とみなす名前の部分一致一覧（小文字比較）。 */
const CREDENTIAL_MARKERS: readonly string[] = [
  '.env', 'credential', 'secret', 'apikey', 'api-key', 'api_key', 'password', 'passwd',
  'token', 'session', 'cookie', 'id_rsa', 'id_ed25519', '.pem', '.p12', '.pfx', '.key',
  'kubeconfig', 'aws', 'azure', 'gha', 'bearer', 'authorization', 'auth',
];

/** Goal ID は goal-store.ts の GOAL_ID_PATTERN と同じ厳格さでしか受け付けない。 */
const GOAL_ID_PATTERN = /^goal-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]{2,40}$/;
/** TODO ID は goal-store.ts の createTodoId() が作る `t<n>` と、UUID由来 `t-xxxxxx` の形だけ認める。 */
const TODO_ID_PATTERN = /^t(-[0-9a-z]{4,}|[0-9]{1,8})$/;
/** バックアップID（生成側は UTC 時刻 + pid + ランダム）。 */
const BACKUP_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[0-9]+-[0-9a-f]{6}$/;

/** 例外に種類を持たせるためのエラーコード。 */
export type MaintenanceErrorCode =
  | 'state_root_unsafe'
  | 'unknown_state_file'
  | 'credential_excluded'
  | 'unsafe_name'
  | 'link_refused'
  | 'path_escape'
  | 'corrupt_backup'
  | 'runtime_active'
  | 'restore_flag_required'
  | 'drift_refused'
  | 'read_failed';

/** Maintenance 専用のエラー。`code` で分岐できる（メッセージ文字列判定をさせない）。 */
export class MaintenanceError extends Error {
  readonly code: MaintenanceErrorCode;
  readonly detail?: string;
  constructor(code: MaintenanceErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'MaintenanceError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 例外 → 読みやすい1行（テストとレポートで共通使う）。 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 内部: posix 形式へ正規化したroot相対名を作る（Windows の `\` もここで統一）。 */
function toRelativeName(stateRoot: string, absolute: string): string {
  const relative = path.relative(stateRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MaintenanceError('path_escape', `状態root外のパスは扱えません: ${absolute}`);
  }
  return relative.split(path.sep).join('/');
}

/** 内部: 名前の静的検査。絶対パス・`..`・認証情報・制御文字・長さを一括で弾く。 */
function assertSafeName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) {
    throw new MaintenanceError('unsafe_name', `状態ファイル名が不正です（空または長すぎる）: ${JSON.stringify(name).slice(0, 120)}`);
  }
  // Windows のドライブ指定（C:\ など）と UNC（\\server\share）を明示的に拒否する
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('\\\\') || name.startsWith('//')) {
    throw new MaintenanceError('unsafe_name', `絶対パスは指定できません: ${name}`);
  }
  if (path.isAbsolute(name)) throw new MaintenanceError('unsafe_name', `絶対パスは指定できません: ${name}`);
  if (name.includes('\\') || name.includes('\0')) throw new MaintenanceError('unsafe_name', `不正な文字を含む名前です: ${JSON.stringify(name).slice(0, 120)}`);
  const segments = name.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new MaintenanceError('path_escape', `'..' と空要素を含む名前は拒否します: ${name}`);
  }
  const lowered = name.toLowerCase();
  for (const marker of CREDENTIAL_MARKERS) {
    if (lowered.includes(marker)) {
      throw new MaintenanceError('credential_excluded', `認証情報（Credential/Secret）とみなす名前は対象外です: ${name} ( マーカー: ${marker})`);
    }
  }
  return segments.join('/');
}

/** 内部: goal-store / goal-transaction が生成する既知の形か。違う形は unknown として扱う。 */
function classifyKnownName(name: string): KnownStateKind | undefined {
  const segments = name.split('/');
  if (segments.length === 1 && segments[0].endsWith('.json')) {
    const id = segments[0].slice(0, -5);
    return GOAL_ID_PATTERN.test(id) ? 'goal' : undefined;
  }
  if (segments.length === 1 && segments[0].endsWith('.json.pause')) {
    const id = segments[0].slice(0, -'.json.pause'.length);
    return GOAL_ID_PATTERN.test(id) ? 'pause' : undefined;
  }
  if (segments.length === 3 && segments[1] === 'tx' && segments[2].endsWith('.json')) {
    const goalId = segments[0];
    const todoId = segments[2].slice(0, -5);
    return GOAL_ID_PATTERN.test(goalId) && TODO_ID_PATTERN.test(todoId) ? 'transaction' : undefined;
  }
  return undefined;
}

/**
 * 認証情報（Credential / Secret）を対象外と判定する公開ヘルパー。
 * 登録・ backup・ restore のどの段階でも同じ判断を使う（判定の二重化で穴を作るのを防ぐ）。
 */
export function isCredentialPath(name: string): boolean {
  const lowered = String(name).toLowerCase();
  return CREDENTIAL_MARKERS.some(marker => lowered.includes(marker));
}

/**
 * root から target までの各階層を lstat で辿り、リンク（Symbolic Link / Junction / Reparse Point）を拒否する。
 * さらに realpath した実体が root 内に収まることを確認する（Windows のジャンクション対策の実二重取り）。
 */
async function assertNoLinks(stateRoot: string, absolute: string): Promise<void> {
  // rootの親も確認する。rootそのものがリンクの場合に境界をすり抜けさせない。
  let ancestor = path.resolve(stateRoot);
  while (true) {
    const info = await lstat(ancestor);
    if (info.isSymbolicLink()) throw new MaintenanceError('link_refused', '状態rootの祖先にリンクがあります。');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const relative = path.relative(stateRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new MaintenanceError('path_escape', `状態root外のパスは扱えません: ${absolute}`);
  }
  let cursor = stateRoot;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 復元元（バックアップコピー）のようにまだ存在しない末端は、親まで通っていれば可
      if (code === 'ENOENT') break;
      throw error;
    }
    // isJunction() は Node 20 以降。古いランタイムでは undefined なのでシンボリックリンク判定だけで通す。
    const junctionDetector = info as unknown as { isJunction?: () => boolean };
    const junction = typeof junctionDetector.isJunction === 'function' && junctionDetector.isJunction() === true;
    if (info.isSymbolicLink() || junction || (info.isFile() && info.nlink > 1)) {
      throw new MaintenanceError('link_refused', `リンク（Symbolic Link / Junction）経由の状態ファイルは拒否します: ${cursor}`);
    }
  }
  // 末端が存在する場合は実体もroot内かを確認する（ジャンクションは lstat では読めないことがあるため実体でも見る）
  try {
    const resolvedRoot = await realpath(stateRoot);
    const resolvedTarget = await realpath(absolute);
    const inside = path.relative(resolvedRoot, resolvedTarget);
    if (inside.startsWith('..') || path.isAbsolute(inside)) {
      throw new MaintenanceError('link_refused', `実体が状態root外を指しています（リンク経由の回避 suspected）: ${absolute} -> ${resolvedTarget}`);
    }
  } catch (error) {
    if (error instanceof MaintenanceError) throw error;
    // 存在しないファイル（これから復元する側）はここを通らない
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Runtime Maintenance の本体。1インスタンス = 1つの専用状態root（Dedicated State Root）だけを管理する。
 * root を跨いだ復元（他人の状態rootへの書き込み）はAPI上そもそもできない（rootはコンストラクタで固定）。
 */
export interface RuntimeMaintenanceOptions {
  /** 管理する専用状態root（絶対パス）。goal-store の WENTIAN_GOAL_PATH に対応させる。 */
  stateRoot: string;
  /** 追加で既知扱いにする相対パス（通常は使わない。認証情報名は登録不可）。 */
  extraKnownNames?: string[];
}

export class RuntimeMaintenance {
  readonly stateRoot: string;
  private readonly extraKnown: string[];

  constructor(options: RuntimeMaintenanceOptions) {
    const root = path.resolve(options.stateRoot);
    if (!path.isAbsolute(root)) throw new MaintenanceError('state_root_unsafe', `状態rootは絶対パスで指定してください: ${options.stateRoot}`);
    // root 自体が認証情報ディレクトリ／ファイル名を指していないか
    if (isCredentialPath(root)) throw new MaintenanceError('credential_excluded', `認証情報を格納するパスは状態rootにできません: ${root}`);
    this.stateRoot = root;
    this.extraKnown = (options.extraKnownNames || []).map(assertSafeName);
    for (const name of this.extraKnown) if (isCredentialPath(name)) throw new MaintenanceError('credential_excluded', `認証情報らしき名前を既知対象へ登録できません: ${name}`);
  }

  /** 内部: root相対名 → 絶対パス（毎回 assertSafeName + リンク検査を通す）。 */
  private async resolveManaged(name: string): Promise<string> {
    const safe = assertSafeName(name);
    const absolute = path.join(this.stateRoot, ...safe.split('/'));
    await assertNoLinks(this.stateRoot, absolute);
    return absolute;
  }

  /** 内部: バックアップ保存先（状態root配下の隠しディレクトリ。既知形に合致しないので二重収集されない）。 */
  private backupsRoot(): string { return path.join(this.stateRoot, '.maintenance', 'backups'); }
  private backupDir(backupId: string): string {
    if (!BACKUP_ID_PATTERN.test(backupId)) throw new MaintenanceError('unsafe_name', `バックアップIDの形式が不正です: ${backupId}`);
    return path.join(this.backupsRoot(), backupId);
  }
  private manifestPath(backupId: string): string { return path.join(this.backupDir(backupId), 'manifest.json'); }
  /** 内部: 復元前に自分の状態を退避する場所（人が確認できる場所に保持する）。 */
  preRestoreRoot(): string { return path.join(this.stateRoot, '.maintenance', 'pre-restore'); }

  /** 内部: 再帰ファイル列挙（ディレクトリは辿るが、リンクは辿らない = lstat で弾く）。 */
  private async walk(dir: string, depth = 0): Promise<string[]> {
    if (depth > 4) return []; // goal-store の階層は `<goal>/tx/<todo>.json` で最深2。それ以深は未知とみなす。
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const found: string[] = [];
    for (const name of names) {
      const absolute = path.join(dir, name);
      let info;
      try { info = await lstat(absolute); } catch { continue; }
      if (info.isSymbolicLink()) continue; // リンクは対象外の証拠として列挙から落とす（検査側では明示拒否する）
      if (info.isDirectory()) { found.push(...await this.walk(absolute, depth + 1)); continue; }
      if (!info.isFile()) continue;
      found.push(toRelativeName(this.stateRoot, absolute));
    }
    return found;
  }

  /**
   * 状態root配下から **既知の状態ファイルだけ** を集める。
   * 未知のファイルは known に返さず、`unknown` に並べるだけ（他人の作業ファイルを誤って触らないため）。
   */
  async listKnownStateFiles(): Promise<{ known: Array<{ name: string; kind: KnownStateKind }>; unknown: string[] }> {
    const all = await this.walk(this.stateRoot);
    const known: Array<{ name: string; kind: KnownStateKind }> = [];
    const unknown: string[] = [];
    for (const name of all) {
      if (name.startsWith('.maintenance/')) continue; // 自分の台帳は対象外
      if (isCredentialPath(name)) { unknown.push(name); continue; }   // 認証情報は既知形でも対象外
      let kind: KnownStateKind | undefined;
      try {
        assertSafeName(name);
        kind = classifyKnownName(name);
      } catch { kind = undefined; }
      if (!kind && this.extraKnown.includes(name)) kind = 'goal';
      if (kind) known.push({ name, kind }); else unknown.push(name);
    }
    known.sort((a, b) => a.name.localeCompare(b.name));
    return { known, unknown };
  }

  /** 内部: ファイル実体のSHA256・サイズ・更新時刻を取る（破損検査の基礎証拠 / Evidence）。 */
  private async fingerprint(absolute: string): Promise<{ sha256: string; bytes: number; mtimeMs: number }> {
    const buffer = await readFile(absolute);
    return { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length, mtimeMs: (await stat(absolute)).mtimeMs };
  }

  /** 内部: バックアップ内パスの解決（同じ安全検査を通す。基準rootは呼び出し側が渡す）。 */
  private async resolveWithin(base: string, name: string): Promise<string> {
    const safe = assertSafeName(name);
    const absolute = path.join(base, ...safe.split('/'));
    await assertNoLinks(base, absolute);
    return absolute;
  }

  /**
   * 既知の状態ファイルだけを SHA256 付きでバックアップする。
   * 書き込み先は必ず自分の状態root配下（`.maintenance/backups/<backupId>/`）。既存のバックアップを上書きしない。
   * 1件でも取りこぼした場合は成功を返さず、例外へ退避（部分バックアップを「成功」と見せない）。
   */
  async createBackup(now = new Date()): Promise<BackupManifest> {
    const writers = await this.detectActiveWriters();
    if (writers.running) throw new MaintenanceError('runtime_active', '稼働中または状態不明のためバックアップを拒否します。');
    const { known } = await this.listKnownStateFiles();
    if (!known.length) throw new MaintenanceError('read_failed', 'バックアップ対象の管理状態がありません。');
    const backupId = `${now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    if (!BACKUP_ID_PATTERN.test(backupId)) throw new MaintenanceError('unsafe_name', `バックアップID生成に失敗しました: ${backupId}`);
    const dir = this.backupDir(backupId);
    await mkdir(dir, { recursive: true });
    const files: StateFileEntry[] = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    for (const { name, kind } of known) {
      try {
        const live = await this.resolveManaged(name);            // 絶対パス解決 + リンク検査
        const print = await this.fingerprint(live);
        const target = await this.resolveWithin(dir, name);
        await mkdir(path.dirname(target), { recursive: true });
        const buffer = await readFile(live);
        await writeFileWithRetry(target, buffer);
        // 書き込んだ実体を読み戻してハッシュ一致を確認する（書けた気になる書き込み嘘を検査する）
        const written = await this.fingerprint(target);
        if (written.sha256 !== print.sha256) throw new MaintenanceError('corrupt_backup', `バックアップコピーのSHA256が元と一致しません: ${name}`);
        files.push({ name, kind, sha256: print.sha256, bytes: print.bytes, mtimeMs: print.mtimeMs });
      } catch (error) {
        rejected.push({ name, reason: describeError(error) });
      }
    }
    // コピー終了時も全原本を再検査し、混在した時点の状態を正常バックアップと扱わない。
    for (const entry of files) {
      try { if ((await this.fingerprint(await this.resolveManaged(entry.name))).sha256 !== entry.sha256) rejected.push({ name: entry.name, reason: 'バックアップ中に原本が変更されました。' }); }
      catch (error) { rejected.push({ name: entry.name, reason: describeError(error) }); }
    }
    const finalNames = (await this.listKnownStateFiles()).known.map(entry => entry.name);
    if (JSON.stringify(finalNames) !== JSON.stringify(known.map(entry => entry.name)) || (await this.detectActiveWriters()).running) rejected.push({ name: '(状態一覧)', reason: 'バックアップ中に状態一覧または稼働状態が変化しました。' });
    const manifest: BackupManifest = {
      version: '1.0', backupId, scope: 'managed-state-only', restoreRequires: 'runtimeStopped=true',
      stateRoot: this.stateRoot, createdAt: now.toISOString(), files, rejected,
    };
    await writeFileWithRetry(path.join(dir, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
    if (rejected.length) {
      // 一部でも失敗したバックアップを「成功」と見せない（受入条件は全件一致）
      throw new MaintenanceError('read_failed', `バックアップ全件取得に失敗しました（失敗 ${rejected.length}件 / 台帳は ${dir} に不完全のまま残しています）`, JSON.stringify(rejected));
    }
    return manifest;
  }

  /** 台帳（manifest.json）を読み、形式・スコープ・状態rootの整合をみる。 */
  async readManifest(backupId: string): Promise<BackupManifest> {
    const file = this.manifestPath(backupId);
    await assertNoLinks(this.stateRoot, file);
    let manifest: BackupManifest;
    try { manifest = JSON.parse(await readFile(file, 'utf8')) as BackupManifest; }
    catch (error) { throw new MaintenanceError('corrupt_backup', `バックアップ台帳が読めません: ${backupId} (${describeError(error)})`); }
    if (manifest.version !== '1.0' || manifest.backupId !== backupId) throw new MaintenanceError('corrupt_backup', `バックアップ台帳の形式が不正です: ${backupId}`);
    if (manifest.scope !== 'managed-state-only') throw new MaintenanceError('corrupt_backup', `台帳のスコープが管理状態限定ではありません: ${String(manifest.scope)}`);
    // 台帳が別rootを指している場合、そのrootへ復元しに行く事故を防ぐ（root跨ぎ復元拒否）
    if (path.resolve(manifest.stateRoot) !== this.stateRoot) throw new MaintenanceError('path_escape', `台帳の状態rootが本インスタンスのrootと一致しません: ${manifest.stateRoot} != ${this.stateRoot}`);
    if (!Array.isArray(manifest.files)) throw new MaintenanceError('corrupt_backup', `台帳の files が配列ではありません: ${backupId}`);
    for (const entry of manifest.files) {
      assertSafeName(entry.name);
      if (!/^[0-9a-f]{64}$/.test(String(entry.sha256))) throw new MaintenanceError('corrupt_backup', `台帳のSHA256形式が不正です: ${entry.name}`);
    }
    return manifest;
  }

  /**
   * バックアップ内容の **全件事前検査**（Pre-flight Inspection）。
   * 1件でも破損・欠損・型不一致があれば passed=false。復元側は passed=false のまま進めない（All-or-Nothing）。
   */
  async inspectBackup(backupId: string): Promise<InspectionResult> {
    const manifest = await this.readManifest(backupId);
    const findings: InspectionFinding[] = [];
    for (const entry of manifest.files) {
      const absolute = await this.resolveWithin(this.backupDir(backupId), entry.name);
      try {
        const buffer = await readFile(absolute);
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        if (sha256 !== entry.sha256) { findings.push({ name: entry.name, ok: false, detail: `SHA256不一致（期待 ${entry.sha256.slice(0, 12)}… / 実 ${sha256.slice(0, 12)}…）` }); continue; }
        if (buffer.length !== entry.bytes) { findings.push({ name: entry.name, ok: false, detail: `サイズ不一致（期待 ${entry.bytes} / 実 ${buffer.length}）` }); continue; }
        const content = this.inspectContent(entry.kind, buffer);
        findings.push({ name: entry.name, ok: content.ok, detail: content.detail });
      } catch (error) {
        findings.push({ name: entry.name, ok: false, detail: `読み出し失敗: ${describeError(error)}` });
      }
    }
    return { passed: findings.every(finding => finding.ok), findings };
  }

  /** 内部: 内容の意味検査（JSON型と goal-store / goal-transaction の必須フィールド）。 */
  private inspectContent(kind: KnownStateKind, buffer: Buffer): { ok: boolean; detail: string } {
    const text = buffer.toString('utf8');
    if (kind === 'pause') {
      return text.trim() === 'pause'
        ? { ok: true, detail: '中断要求ファイルとして正常' }
        : { ok: false, detail: `中断要求ファイルの中身が预期外です: ${JSON.stringify(text.slice(0, 40))}` };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (error) { return { ok: false, detail: `JSON破損: ${describeError(error)}` }; }
    const record = parsed as Record<string, unknown>;
    if (kind === 'goal') {
      if (record.version !== '1.0') return { ok: false, detail: `Goal の version が 1.0 ではありません: ${String(record.version)}` };
      if (typeof record.id !== 'string' || !GOAL_ID_PATTERN.test(record.id)) return { ok: false, detail: `Goal ID が規約外です: ${String(record.id)}` };
      if (!Array.isArray(record.todos) || !Array.isArray(record.blocked)) return { ok: false, detail: 'Goal の todos / blocked が配列ではありません' };
      if (!record.metrics || typeof record.metrics !== 'object') return { ok: false, detail: 'Goal の metrics がありません' };
      if (!record.stop || typeof record.stop !== 'object') return { ok: false, detail: 'Goal の stop（実行許可バウンド）がありません' };
      return { ok: true, detail: `Goal として正常（TODO ${record.todos.length}件）` };
    }
    if (record.version !== '1.0') return { ok: false, detail: `Transaction の version が 1.0 ではありません: ${String(record.version)}` };
    if (typeof record.todoId !== 'string' || !TODO_ID_PATTERN.test(record.todoId)) return { ok: false, detail: `todoId が規約外です: ${String(record.todoId)}` };
    if (typeof record.goalId !== 'string' || !GOAL_ID_PATTERN.test(record.goalId)) return { ok: false, detail: `goalId が規約外です: ${String(record.goalId)}` };
    if (typeof record.phase !== 'string') return { ok: false, detail: `phase が文字列ではありません: ${String(record.phase)}` };
    return { ok: true, detail: `Transaction として正常（phase=${String(record.phase)}）` };
  }

  /**
   * バックアップの無傷さ（backupIntact）と、実状態がバックアップ時点から動いていないか（drift）を検証する。
   * drift は「他人が更新した可能性」のシグナルなので、復元側は明示承認なしにこれを押し潰さない。
   */
  async verifyBackup(backupId: string): Promise<VerifyResult> {
    const manifest = await this.readManifest(backupId);
    const inspection = await this.inspectBackup(backupId);
    const findings = [...inspection.findings];
    const drifted: string[] = [];
    const missing: string[] = [];
    for (const entry of manifest.files) {
      try {
        const live = await this.resolveManaged(entry.name);
        const print = await this.fingerprint(live);
        if (print.sha256 !== entry.sha256) {
          drifted.push(entry.name);
          findings.push({ name: entry.name, ok: true, detail: `実状態がバックアップ時点から変化しています（台帳 ${entry.sha256.slice(0, 12)}… / 実 ${print.sha256.slice(0, 12)}…）` });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          missing.push(entry.name);
          findings.push({ name: entry.name, ok: true, detail: '実状態に存在しません（削除されたか、まだ作られていません）' });
        } else {
          findings.push({ name: entry.name, ok: false, detail: `実状態の検査に失敗: ${describeError(error)}` });
        }
      }
    }
    return {
      backupId,
      backupIntact: inspection.passed,
      drifted,
      missing,
      findings,
      summary: `バックアップ ${backupId}: 無傷=${inspection.passed ? 'はい' : 'いいえ'} / 対象 ${manifest.files.length}件 / 実状態の差分 ${drifted.length}件 / 欠損 ${missing.length}件`,
    };
  }

  /**
   * 稼働中の実子プロセス（Active Writer）と未完了トランザクションを検知する。
   * goal-transaction.ts が書く `pid` と `phase` をそのまま使い、pid の生存は signal 0 で確認する。
   * 判定:
   *  - 未完了 phase（start / checkpoint / running）かつ pid 生存 → running=true（確実に稼働中）
   *  - 中断要求ファイル `.pause` が存在                  → running=true（中断処理が進行中）
   *  - 未完了 phase かつ pid 死亡                   → stale として計上（＝中断復旧の現場。running にはしない）
   */
  async detectActiveWriters(): Promise<ActiveWriterReport> {
    const { known } = await this.listKnownStateFiles();
    const transactions: ActiveWriterReport['transactions'] = [];
    const staleTransactions: string[] = [];
    const reasons: string[] = [];
    let running = false;
    let pauseFiles = 0;
    for (const { name, kind } of known) {
      try {
        const absolute = await this.resolveManaged(name);
        if (kind === 'pause') {
          pauseFiles += 1;
          running = true;
          reasons.push(`中断要求ファイルが存在します: ${name}`);
          continue;
        }
        if (kind !== 'transaction') continue;
        const tx = JSON.parse(await readFile(absolute, 'utf8')) as { phase?: string; pid?: number };
        const phase = typeof tx.phase === 'string' ? tx.phase : 'unknown';
        const pid = typeof tx.pid === 'number' ? tx.pid : -1;
        if (!INCOMPLETE_TX_PHASES.includes(phase)) continue;   // done / failed / rolled-back は稼働中と数えない
        const alive = isProcessAlive(pid);
        transactions.push({ name, pid, phase, alive });
        if (alive) { running = true; reasons.push(`稼働中のトランザクションがあります: ${name} (phase=${phase}, pid=${pid})`); }
        else staleTransactions.push(name);
      } catch { running = true; reasons.push(`稼働状態を確認できないため復元を拒否します: ${name}`); }
    }
    return { running, reasons, transactions, staleTransactions, pauseFiles };
  }

  /**
   * バックアップからの復元（Restore）。**更新失敗からの復旧専用**。
   *
   * 実行順序（この順序が安全条件そのもの）:
   *  1. `options.runtimeStopped === true` の明示を要求する（未指定は即拒否 = 稼働中に復元しない）。
   *  2. 自動検知（detectActiveWriters）で稼働中を実検したら、フラグが立っていても拒否する（フラグは必要十分条件ではない）。
   *  3. 台帳を読み、バックアップ全文を事前検査する（ passed=false なら 1バイトも書かない = 部分適用しない）。
   *  4. 実状態がバックアップ時点から変わっているファイル（drift）を数える。他人の作業状態かもしれないので、
   *     `options.overwriteDrifted === true` の明示承認がない限り復元を進めない。
   *  5. 復元前に実状態を `.maintenance/pre-restore/<backupId>-<stamp>/` へ退避する（自分のコピーなので他人の状態は書かない）。
   *  6. 1ファイルずつ原子的リネームで書き、書き戻しハッシュを照合する。途中で失敗したら
   *     すでに復元した分を退避コピーへ巻き戻す（Restore の Rollback）。
   */
  async restoreBackup(backupId: string, options: {
    /** 稼働停止の明示宣言。必ず true を明記して呼ぶこと（既定拒否）。 */
    runtimeStopped?: boolean;
    /** drift（バックアップ取得後に変化した実状態）を上書きする明示承認。既定は拒否。 */
    overwriteDrifted?: boolean;
    /** 検証用に内部検査をスキップする手段は **意図的に用意していない**（常に全件検査する）。 */
  } = {}): Promise<RestoreResult> {
    if (options.runtimeStopped !== true) {
      throw new MaintenanceError('restore_flag_required', '復元には runtimeStopped: true の明示指定が必要です（稼働中の復元は禁止）。');
    }
    const writers = await this.detectActiveWriters();
    if (writers.running) {
      throw new MaintenanceError('runtime_active', `稼働中のため復元を拒否します: ${writers.reasons.join(' / ')}`);
    }
    const manifest = await this.readManifest(backupId);
    const inspection = await this.inspectBackup(backupId);
    if (!inspection.passed) {
      const broken = inspection.findings.filter(finding => !finding.ok).map(finding => `${finding.name}: ${finding.detail}`);
      throw new MaintenanceError('corrupt_backup', `バックアップに破損があるため復元を中止します（部分適用しません / ${broken.length}件）: ${broken.join(' | ')}`);
    }
    // 4. drift 検知（他人の作業状態を上書きしないための自己防衛）
    const drifted: string[] = [];
    for (const entry of manifest.files) {
      try {
        const live = await this.resolveManaged(entry.name);
        const print = await this.fingerprint(live);
        if (print.sha256 !== entry.sha256) drifted.push(entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MaintenanceError('read_failed', `復元前の実状態検査に失敗しました: ${entry.name} (${describeError(error)})`);
      }
    }
    if (drifted.length && options.overwriteDrifted !== true) {
      throw new MaintenanceError('drift_refused', `バックアップ取得後に変化した状態があります。他人の作業状態の可能性があるため復元を中止します: ${drifted.join(', ')}（本当に上書きするなら overwriteDrifted: true を明示）`);
    }
    // 5. 復元前の実状態を退避する（巻き戻し用。対象はこれから書くファイルだけ = 他人の作業状態には触らない）
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const preRestoreDir = path.join(this.preRestoreRoot(), `${backupId}-${stamp}`);
    await mkdir(preRestoreDir, { recursive: true });
    const backedUpLive = new Map<string, string | undefined>();   // name → 退避先の絶対パス（実体が無ければ undefined）
    for (const entry of manifest.files) {
      const live = await this.resolveManaged(entry.name);
      try {
        const buffer = await readFile(live);
        const sink = await this.resolveWithin(preRestoreDir, entry.name);
        await mkdir(path.dirname(sink), { recursive: true });
        await writeFileWithRetry(sink, buffer);
        backedUpLive.set(entry.name, sink);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') backedUpLive.set(entry.name, undefined);
        else throw new MaintenanceError('read_failed', `復元前の退避に失敗しました: ${entry.name} (${describeError(error)})`);
      }
    }
    // 6. 適用（失敗時は適用済み分を巻き戻す）
    const restored: string[] = [];
    const skipped: string[] = [];
    const rolledBack: string[] = [];
    try {
      for (const entry of manifest.files) {
        const source = await this.resolveWithin(this.backupDir(backupId), entry.name);
        const target = await this.resolveManaged(entry.name);
        const buffer = await readFile(source);
        const current = await this.fingerprint(source);
        if (current.sha256 !== entry.sha256) throw new MaintenanceError('corrupt_backup', `適用直前の再検査でSHA256不一致: ${entry.name}`);
        // 実状態がすでに一致しているファイルは書かない（冪等 / 不要な上書きをしない）
        let alreadyMatches = false;
        try { alreadyMatches = (await this.fingerprint(target)).sha256 === entry.sha256; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (alreadyMatches) { skipped.push(entry.name); continue; }
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.${Date.now()}.maintenance.tmp`;
        await writeFile(temporary, buffer, { encoding: 'utf8', mode: 0o600 });
        await renameWithRetry(temporary, target);
        const after = await this.fingerprint(target);
        if (after.sha256 !== entry.sha256) throw new MaintenanceError('corrupt_backup', `復元後のSHA256が台帳と一致しません: ${entry.name}`);
        restored.push(entry.name);
      }
    } catch (error) {
      // 適用途中の失敗: 適用済みファイルを復元前の実状態へ巻き戻す（壊れた中間状態を残さない）
      for (const name of restored) {
        const entry = manifest.files.find(item => item.name === name);
        if (!entry) continue;
        try {
          const target = await this.resolveManaged(name);
          const sink = backedUpLive.get(name);
          if (sink) {
            const buffer = await readFile(sink);
            await writeFileWithRetry(target, buffer);
          } else {
            await rm(target, { force: true });   // 復元前になかったファイルなので、削除して元に戻す
          }
          rolledBack.push(name);
        } catch { /* 巻き戻し失敗は下の例外に添えて報告する（上書き元の退避は残っているので人手で復旧できる） */ }
      }
      const suffix = rolledBack.length ? `（巻き戻し ${rolledBack.length}件 / 退避先 ${preRestoreDir}）` : `（退避先 ${preRestoreDir}）`;
      throw new MaintenanceError('corrupt_backup', `復元適用に失敗したため、適用済み分を巻き戻しました${suffix}: ${describeError(error)}`);
    }
    return {
      restored,
      skipped,
      rolledBack,
      preRestoreDir,
      staleTransactions: writers.staleTransactions.length,
      summary: `復元完了: 適用 ${restored.length}件 / 一致スキップ ${skipped.length}件 / drift上書き ${drifted.length}件 / staleトランザクション ${writers.staleTransactions.length}件（退避先 ${preRestoreDir}）`,
    };
  }
}

/**
 * プロセス生存判定（signal 0 の送信）。ESRCH なら死んでいる、EPERMなら存在するが自分では叩けない＝生存扱い。
 * 自分自身のpidは常に生存とみなす（単一プロセスで試験する時に自己判定で誤って止めないため）。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Windows の短いファイルロック（Defender / Indexer）を吸収して書き込む（goal-store の atomicWrite と同じ思想）。 */
async function writeFileWithRetry(target: string, buffer: Buffer): Promise<void> {
  const delays = [0, 10, 40, 100, 250, 500];
  let lastError: unknown;
  for (const delayMs of delays) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try { await writeFile(target, buffer, { mode: 0o600 }); return; }
    catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
    }
  }
  throw lastError;
}

/** 簡易ファクトリ。root だけ渡して使う時の入口（意図を明示するため new と同じ意味）。 */
export function createRuntimeMaintenance(stateRoot: string, extraKnownNames?: string[]): RuntimeMaintenance {
  return new RuntimeMaintenance({ stateRoot, ...(extraKnownNames ? { extraKnownNames } : {}) });
}
