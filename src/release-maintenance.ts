/**
 * Release Maintenance: Wentian Gateway の **ローカル更新失敗復旧（Recovery from Failed Local Update）**。
 *
 * 目的（Scope）
 * ------------
 * runtime-maintenance.ts は状態ファイル（State File）専用の復旧で、コード世代の戻し方は
 * 「リリース手順のロールバックを使う」と明示されつつ未実装だった。本モジュールはその欠けた
 * **バージョン更新（Version Update）の失敗復旧** を、専用リリースroot（Dedicated Release Root）内だけで実装する。
 *
 * 流れ（Pipeline）
 * ----------------
 * 1. stageRelease(): 候補ファイル群（Candidate Files）を `<releaseRoot>/versions/<versionId>/files/` へ
 *    ステージング（Staging）し、実体の SHA256 から台帳（Manifest）を作る。原本（Source）は読むだけで不変。
 * 2. switchRelease(): 全ファイルの SHA256 検査（Verify）→ ホスト固定の検証関数（Validator Function）成功 →
 *    `current.json` をアトミック切替（Atomic Rename）。**検証が1つでも失敗したら current.json は1バイトも動かない。**
 * 3. rollbackRelease(): 前回有効版（Previous Active Version）の台帳を再検証してから current.json を戻す。
 *
 * 安全設計（Safety Invariants）— runtime-maintenance.ts と同じ強さを守る
 * ------------------------------------------------------------------
 * 1. root と祖先・配下の全階層でシンボリックリンク（Symbolic Link）/ ジャンクション（Junction）/
 *    ハードリンク（Hard Link, nlink>1）を拒否する。
 * 2. 候補名は絶対パス（Absolute Path）・ドライブ指定（C:\）・UNC・`..`・`\`・nul 文字を拒否する。
 * 3. 認証情報（Credential / Secret）らしき名前はステージング段階で拒否する（判定は runtime-maintenance.ts と共通化）。
 * 4. **任意コマンド（Arbitrary Command）は一切実行しない**。child_process（サブプロセス）を import せず、
 *    validator に文字列等の関数以外を渡されたら `command_refused` で拒否する（関数はホストプロセスに固定された実体だけ）。
 * 5. 稼働中切替禁止: `runtimeStopped: true` の明示がなければ即拒否。実際のアプリ起動・配置（Deploy/Launch）は行わない。
 * 6. 書き込みは releaseRoot 配下だけ。candidateRoot は読み取り専用。失敗時は旧有効版（Active Version）と原本が不変。
 *
 * 依存（Dependencies）: Node.js 標準ライブラリと safe-file.ts / atomic-file.js / runtime-maintenance.js の公開ヘルパーのみ。
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, lstat, mkdir, writeFile, rm, realpath, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertOrdinaryPath, atomicOrdinaryWrite } from './safe-file.js';
import { isCredentialPath } from './runtime-maintenance.js';

/** エラーコード（例外の型判定用。メッセージ文字列比較をさせない）。 */
export type ReleaseErrorCode =
  | 'root_unsafe' | 'root_overlap' | 'unsafe_version_id' | 'unsafe_name' | 'path_escape'
  | 'credential_excluded' | 'link_refused' | 'command_refused' | 'runtime_flag_required'
  | 'version_exists' | 'unknown_version' | 'corrupt_release' | 'unexpected_file'
  | 'validation_failed' | 'no_previous_version' | 'read_failed';

/** Release 専用エラー。`code` で分岐できる。 */
export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;
  readonly detail?: string;
  constructor(code: ReleaseErrorCode, message: string, detail?: string) {
    super(message); this.name = 'ReleaseError'; this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 版ごとの台帳（Release Manifest）。ステージング時に実体の SHA256 から作る。 */
export interface ReleaseManifest {
  version: '1.0';
  versionId: string;
  /** 管理スコープ。リリースroot内限定である証跡（Evidence）を台帳に刻む。 */
  scope: 'managed-release-only';
  switchRequires: 'runtimeStopped=true';
  createdAt: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
}

/** current.json が指す有効版ポインタ（Active Pointer）。 */
export interface CurrentPointer {
  version: '1.0';
  activeVersionId: string;
  /** 切替直前に有効だった版。rollback の唯一の復旧元（null = 初回切替）。 */
  previousVersionId: string | null;
  switchedAt: string;
}

/** 版IDはパス区切りを含まない安全な英数字記号だけ受け付ける（`..` を構造的に不可能にする）。 */
const VERSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** SHA256 は 64 桁の小文字16進だけ。 */
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const CURRENT_NAME = 'current.json';
const VERSIONS_DIR = 'versions';
const FILES_DIR = 'files';
const MANIFEST_NAME = 'manifest.json';

/** 内部: root・祖先・対象パスのリンク検査。safe-file.ts の assertOrdinaryPath を基に専用エラーへ翻訳する。 */
async function assertNoLinks(absolute: string): Promise<void> {
  try { await assertOrdinaryPath(absolute); }
  catch (error) { throw new ReleaseError('link_refused', `リンク（Link/Hard Link）経由の操作は拒否します: ${absolute}（${(error as Error).message}）`); }
}

/** 内部: root相対の安全名検査（絶対パス・ドライブ・UNC・`..`・認証情報を一括拒否）。 */
function assertSafeName(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) throw new ReleaseError('unsafe_name', `ファイル名が不正です: ${JSON.stringify(name).slice(0, 120)}`);
  if (/^[a-zA-Z]:/.test(name) || name.startsWith('\\\\') || name.startsWith('//') || path.isAbsolute(name)) throw new ReleaseError('unsafe_name', `絶対パスは指定できません: ${name}`);
  if (name.includes('\\') || name.includes('\0')) throw new ReleaseError('unsafe_name', `不正な文字を含む名前です: ${JSON.stringify(name).slice(0, 120)}`);
  const segments = name.split('/');
  if (segments.some(s => s === '' || s === '.' || s === '..')) throw new ReleaseError('path_escape', `'..' と空要素を含む名前は拒否します: ${name}`);
  if (isCredentialPath(name)) throw new ReleaseError('credential_excluded', `認証情報（Credential/Secret）とみなす名前は対象外です: ${name}`);
  return segments.join('/');
}

/** 内部: リリースrootの検査。存在確認（未作成なら作成可）・祖先リンク拒否・candidateRoot との重なり拒否。 */
async function assertReleaseRoot(releaseRoot: string, candidateRoot?: string): Promise<string> {
  const root = path.resolve(releaseRoot);
  await assertNoLinks(root); // root 自体と祖先全階層のリンク/hard link を拒否
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ReleaseError('root_unsafe', `リリースrootは通常のディレクトリである必要があります: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; // 未存在はステージング時に作成するので許す
  }
  if (candidateRoot !== undefined) {
    const candidate = path.resolve(candidateRoot);
    const rel = path.relative(root, candidate);
    const overlaps = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ||
      ((r => r === '' || (!r.startsWith('..') && !path.isAbsolute(r)))(path.relative(candidate, root)));
    if (overlaps) throw new ReleaseError('root_overlap', '候補root（Candidate Root）とリリースrootの重なりは拒否します（原本破壊防止）。');
  }
  return root;
}

/** 内部: リンク検査付きで root 相対パスを解決する（各階層を lstat で辿り root 外も弾く）。 */
async function resolveInRoot(root: string, relativeName: string): Promise<string> {
  const target = path.join(root, ...relativeName.split('/'));
  await assertNoLinks(target); // 祖先（root 含む）〜末端のリンク検査
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new ReleaseError('path_escape', `root 外のパスは扱えません: ${target}`);
  return target;
}

/** 内部: バイト列の SHA256（16進小文字）。 */
function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }

/** 内部: 検証関数（Validator）検査。文字列・コマンド・データ由来を拒否し、ホスト固定の関数実体だけ通す。 */
function assertValidatorFunction(validator: unknown): (context: { releaseRoot: string; versionId: string }) => boolean | Promise<boolean> {
  if (typeof validator !== 'function') throw new ReleaseError('command_refused', `任意コマンド・文字列・データ由来の検証は拒否します。ホストプロセスに固定された validator 関数が必要です: ${typeof validator}`);
  return validator as (context: { releaseRoot: string; versionId: string }) => boolean | Promise<boolean>;
}

/** 内部: current.json 読取。未存在なら null、形の崩れは corrupt 扱いで拒否。 */
export async function readCurrentRelease(releaseRoot: string): Promise<CurrentPointer | null> {
  const target = await resolveInRoot(path.resolve(releaseRoot), CURRENT_NAME);
  let raw: string;
  try { raw = await readFile(target, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ReleaseError('read_failed', `current.json が読めません: ${(error as Error).message}`); }
  const parsed = JSON.parse(raw) as Partial<CurrentPointer>;
  if (parsed.version !== '1.0' || typeof parsed.activeVersionId !== 'string' || !VERSION_ID_PATTERN.test(parsed.activeVersionId)
    || !(parsed.previousVersionId === null || (typeof parsed.previousVersionId === 'string' && VERSION_ID_PATTERN.test(parsed.previousVersionId)))) {
    throw new ReleaseError('corrupt_release', 'current.json の形が不正です（手で直さないでください）。');
  }
  return parsed as CurrentPointer;
}

/**
 * ステージング（Staging）: candidateRoot 配下の候補ファイルを version 版ディレクトリへコピーし、
 * ステージ済み実体の SHA256 から台帳を作る。原本は読み取り専用で不変。秘密らしき名前・リンク・root重なりは拒否。
 */
async function stageReleaseUnlocked(options: { releaseRoot: string; versionId: string; candidateRoot: string }): Promise<ReleaseManifest> {
  if (typeof options.versionId !== 'string' || !VERSION_ID_PATTERN.test(options.versionId) || options.versionId.includes('..')) {
    throw new ReleaseError('unsafe_version_id', `版IDとして不安全です: ${JSON.stringify(options.versionId).slice(0, 120)}`);
  }
  const root = await assertReleaseRoot(options.releaseRoot, options.candidateRoot);
  const candidate = path.resolve(options.candidateRoot);
  await assertNoLinks(candidate); // 候補root自身の祖先リンクも拒否
  const versionDir = path.join(root, VERSIONS_DIR, options.versionId);
  const filesDir = path.join(versionDir, FILES_DIR);
  let manifestExists = true;
  try { await readFile(path.join(versionDir, MANIFEST_NAME)); } catch { manifestExists = false; }
  if (manifestExists) throw new ReleaseError('version_exists', `検証済み版は上書きできません（差し替えは新しい versionId を使ってください）: ${options.versionId}`);
  // 台帳のない半途ステージング（前回失敗の名残）だけ作り直す。検証済み版には絶対に触れない。
  await rm(versionDir, { recursive: true, force: true });
  await mkdir(filesDir, { recursive: true });
  const entries: Array<{ name: string; sha256: string; bytes: number }> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      await assertNoLinks(abs);
      const info = await lstat(abs);
      if (item.isSymbolicLink() || info.isSymbolicLink()) throw new ReleaseError('link_refused', `候補にシンボリックリンクがあります: ${abs}`);
      if (info.isFile() && info.nlink > 1) throw new ReleaseError('link_refused', `候補にハードリンク（nlink>1）があります: ${abs}`);
      if (item.isDirectory()) { await walk(abs, `${prefix}${item.name}/`); continue; }
      if (!item.isFile()) throw new ReleaseError('root_unsafe', `通常のファイル以外の候補は拒否します: ${abs}`);
      const name = assertSafeName(`${prefix}${item.name}`);
      const bytes = await readFile(abs);
      const staged = path.join(filesDir, ...name.split('/'));
      await mkdir(path.dirname(staged), { recursive: true });
      await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 }); // wx = 既存（リンク含む）なら失敗して上書き防止
      const after = await lstat(staged);
      if (!after.isFile() || after.nlink > 1) throw new ReleaseError('link_refused', `ステージ済みファイルが通常の単一ファイルではありません: ${staged}`);
      entries.push({ name, sha256: sha256(bytes), bytes: bytes.byteLength }); // 台帳はステージ済み実体から計算
    }
  };
  await walk(candidate, '');
  if (entries.length === 0) throw new ReleaseError('root_unsafe', '候補が 0 件では版を作れません。');
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const manifest: ReleaseManifest = {
    version: '1.0', versionId: options.versionId, scope: 'managed-release-only',
    switchRequires: 'runtimeStopped=true', createdAt: new Date().toISOString(), files: entries,
  };
  await writeFile(path.join(versionDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return manifest;
}

/** 内部: 台帳ファイルの形検査。 */
function parseManifest(raw: string, expectVersionId: string): ReleaseManifest {
  const parsed = JSON.parse(raw) as Partial<ReleaseManifest>;
  if (parsed.version !== '1.0' || parsed.scope !== 'managed-release-only' || parsed.versionId !== expectVersionId || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new ReleaseError('corrupt_release', `台帳（Manifest）の形が不正です: ${expectVersionId}`);
  }
  for (const file of parsed.files) {
    if (typeof file?.name !== 'string' || typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256) || !Number.isInteger(file.bytes) || file.bytes < 0) {
      throw new ReleaseError('corrupt_release', `台帳のファイル行が不正です: ${expectVersionId} / ${JSON.stringify(file).slice(0, 120)}`);
    }
    assertSafeName(file.name);
  }
  if (new Set(parsed.files.map(file => file.name.toLowerCase())).size !== parsed.files.length) throw new ReleaseError('corrupt_release', '台帳のファイル名が重複しています。');
  return parsed as ReleaseManifest;
}

/** 全ファイル SHA256 検査（Verify）: 台帳の全ファイル一致＋台帳外ファイル（リンク含む）の混入拒否。 */
export async function verifyRelease(options: { releaseRoot: string; versionId: string }): Promise<{ versionId: string; checked: number; summary: string }> {
  const root = await assertReleaseRoot(options.releaseRoot);
  if (typeof options.versionId !== 'string' || !VERSION_ID_PATTERN.test(options.versionId)) throw new ReleaseError('unsafe_version_id', `版IDとして不安全です: ${JSON.stringify(options.versionId).slice(0, 120)}`);
  const versionDir = path.join(root, VERSIONS_DIR, options.versionId);
  const filesDir = path.join(versionDir, FILES_DIR);
  let manifest: ReleaseManifest;
  await assertNoLinks(path.join(versionDir, MANIFEST_NAME));
  try { manifest = parseManifest(await readFile(path.join(versionDir, MANIFEST_NAME), 'utf8'), options.versionId); }
  catch (error) { if (error instanceof ReleaseError) throw error; if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ReleaseError('unknown_version', `未ステージングの版です: ${options.versionId}`); throw new ReleaseError('read_failed', `台帳が読めません: ${(error as Error).message}`); }
  const listed = new Set(manifest.files.map(f => f.name));
  const present = new Set<string>();
  const collect = async (dir: string, prefix: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      await assertNoLinks(abs);
      if (item.isSymbolicLink()) throw new ReleaseError('link_refused', `版ディレクトリ内のリンクは拒否します: ${abs}`);
      if (item.isDirectory()) { await collect(abs, `${prefix}${item.name}/`); continue; }
      const name = `${prefix}${item.name}`;
      present.add(name);
      if (!listed.has(name)) throw new ReleaseError('unexpected_file', `台帳にないファイルが混入しています: ${name}`);
    }
  };
  await collect(filesDir, '');
  for (const file of manifest.files) {
    const target = path.join(filesDir, ...file.name.split('/'));
    let bytes: Buffer;
    try { bytes = await readFile(target); } catch { throw new ReleaseError('corrupt_release', `台帳にあるファイルが存在しません: ${file.name}`); }
    const info = await lstat(target);
    if (!info.isFile() || info.nlink > 1) throw new ReleaseError('link_refused', `版内ファイルが通常の単一ファイルではありません: ${file.name}`);
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new ReleaseError('corrupt_release', `SHA256 不一致（破損・改ざん）: ${file.name}`);
  }
  if (present.size !== listed.size) throw new ReleaseError('corrupt_release', '台帳とファイル一覧が一致しません（欠落）。');
  return { versionId: options.versionId, checked: manifest.files.length, summary: `検証OK: ${manifest.files.length} ファイル（SHA256 全件一致）` };
}

/** 内部: current.json のアトミック切替（同一ディレクトリ内の一時ファイル→ renameWithRetry）。 */
async function writeCurrent(root: string, pointer: CurrentPointer): Promise<void> {
  await atomicOrdinaryWrite(path.join(root, CURRENT_NAME), `${JSON.stringify(pointer, null, 2)}\n`);
}

/** 切替（Switch）共通の稼働・validator 検査。runtimeStopped: true 必須／関数以外（任意コマンド）拒否。 */
function assertSwitchFlags(runtimeStopped: unknown, validator: unknown): void {
  if (runtimeStopped !== true) throw new ReleaseError('runtime_flag_required', '切替には runtimeStopped: true の明示指定が必要です（稼働中の切替は禁止）。');
  assertValidatorFunction(validator);
}

/**
 * 更新切替（Switch）: 検証 → validator 成功 → current.json アトミック切替。
 * どれかで失敗したら current.json は不変で、旧有効版と原本（candidateRoot）も不変のまま。
 */
async function switchReleaseUnlocked(options: {
  releaseRoot: string; versionId: string; runtimeStopped?: boolean;
  /** ホストプロセスに固定された検証関数。コマンド文字列・設定データ由来は command_refused で拒否。 */
  validator: unknown;
}): Promise<CurrentPointer> {
  assertSwitchFlags(options.runtimeStopped, options.validator);
  const root = await assertReleaseRoot(options.releaseRoot);
  await verifyRelease({ releaseRoot: root, versionId: options.versionId }); // 全ファイル SHA256 検査
  const before = await readCurrentRelease(root);
  let ok: boolean;
  try { ok = await assertValidatorFunction(options.validator)({ releaseRoot: root, versionId: options.versionId }); }
  catch (error) { throw new ReleaseError('validation_failed', `validator が例外を投げました（current.json は不変）。: ${(error as Error).message}`); } // validator の例外も検証失敗として統一（current.json には触れない）
  if (ok !== true) throw new ReleaseError('validation_failed', `validator が true を返しませんでした（current.json は不変）。: ${options.versionId}`);
  // 検証関数による変更も切替前に再検査する。
  await verifyRelease({ releaseRoot: root, versionId: options.versionId });
  const pointer: CurrentPointer = { version: '1.0', activeVersionId: options.versionId, previousVersionId: before?.activeVersionId ?? null, switchedAt: new Date().toISOString() };
  await writeCurrent(root, pointer);
  return pointer;
}

/**
 * ロールバック（Rollback）: current.json の previousVersionId（旧有効版）を台帳で再検証し、成功時だけ戻す。
 * 戻し先が破損していたら拒否し、現在のポインタは不変。rollback 後は二重巻き戻しを防ぐため previousVersionId を null にする。
 */
async function rollbackReleaseUnlocked(options: { releaseRoot: string; runtimeStopped?: boolean; validator?: unknown }): Promise<CurrentPointer> {
  if (options.validator !== undefined) assertSwitchFlags(options.runtimeStopped, options.validator);
  else if (options.runtimeStopped !== true) throw new ReleaseError('runtime_flag_required', 'rollback には runtimeStopped: true の明示指定が必要です（稼働中の切替は禁止）。');
  const root = await assertReleaseRoot(options.releaseRoot);
  const before = await readCurrentRelease(root);
  if (before === null || before.previousVersionId === null) throw new ReleaseError('no_previous_version', 'rollback 先の旧有効版が記録されていません（初回切替前または rollback 直後）。');
  await verifyRelease({ releaseRoot: root, versionId: before.previousVersionId }); // 旧有効版の検証済み manifest を再検証
  if (options.validator !== undefined) {
    let ok: boolean;
    try { ok = await assertValidatorFunction(options.validator)({ releaseRoot: root, versionId: before.previousVersionId }); }
    catch (error) { throw new ReleaseError('validation_failed', `validator が rollback 対象版で例外を投げました（current.json は不変）。: ${(error as Error).message}`); }
    if (ok !== true) throw new ReleaseError('validation_failed', `validator が rollback 対象版で true を返しませんでした（current.json は不変）。: ${before.previousVersionId}`);
  }
  await verifyRelease({ releaseRoot: root, versionId: before.previousVersionId });
  const pointer: CurrentPointer = { version: '1.0', activeVersionId: before.previousVersionId, previousVersionId: null, switchedAt: new Date().toISOString() };
  await writeCurrent(root, pointer);
  return pointer;
}

/** 別プロセスからの更新も排他する。中断後の残存ロックは停止確認まで保持する。 */
async function withReleaseLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  root = await assertReleaseRoot(root);
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, 'release.lock'); await assertNoLinks(lockPath);
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ReleaseError('validation_failed', '更新操作が実行中、または中断後の排他確認待ちです。'); throw error; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); return await work(); }
  finally { await handle.close(); await unlink(lockPath); }
}
export async function stageRelease(options: Parameters<typeof stageReleaseUnlocked>[0]) { await assertReleaseRoot(options.releaseRoot, options.candidateRoot); return withReleaseLock(options.releaseRoot, () => stageReleaseUnlocked(options)); }
export async function switchRelease(options: Parameters<typeof switchReleaseUnlocked>[0]) { return withReleaseLock(options.releaseRoot, () => switchReleaseUnlocked(options)); }
export async function rollbackRelease(options: Parameters<typeof rollbackReleaseUnlocked>[0]) { return withReleaseLock(options.releaseRoot, () => rollbackReleaseUnlocked(options)); }
