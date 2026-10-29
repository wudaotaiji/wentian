import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertOrdinaryPath } from './safe-file.js';
import { assertTaskPathIncluded } from './task-workspace.js';

export type SourceInspection =
  | { operation: 'search'; query: string }
  | { operation: 'read'; path: string; startLine?: number };
export interface SourceEdit { path: string; expected: string; replacement: string }

/** 調査対象は製品ソースと仕様書に限定し、設定・実行時台帳・依存物を含めません。 */
function sourceName(name: string): boolean {
  return /^(?:src\/[a-zA-Z0-9_.\/-]+\.ts|docs\/[a-zA-Z0-9_.\/-]+\.md)$/.test(name)
    && !name.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'));
}

/** 生成物は不活性な候補として専用領域へ保存し、稼働中のソースを変更しません。 */
export function validateSourceEdit(value: unknown): SourceEdit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('修正候補の形式が不正です。');
  const edit = value as Record<string, unknown>;
  if (Object.keys(edit).some(key => !['path', 'expected', 'replacement'].includes(key))
    || typeof edit.path !== 'string' || !sourceName(edit.path) || !edit.path.startsWith('src/')
    || typeof edit.expected !== 'string' || edit.expected.length < 1 || edit.expected.length > 12000
    || typeof edit.replacement !== 'string' || edit.replacement.length > 12000 || edit.expected === edit.replacement) {
    throw new Error('修正候補の形式が不正です。');
  }
  return { path: edit.path, expected: edit.expected, replacement: edit.replacement };
}

export async function stageMaintenanceSourceEdit(edit: SourceEdit, stagingRoot: string, signal?: AbortSignal, installRoot?: string): Promise<unknown> {
  const input = validateSourceEdit(edit);
  const root = await realpath(installRoot || process.env.WENTIAN_INSTALL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const file = await checkedFile(root, input.path);
  const original = await readFile(file, 'utf8');
  const index = original.indexOf(input.expected);
  if (index < 0 || original.indexOf(input.expected, index + 1) >= 0) throw new Error('修正前の内容を一意に照合できません。');
  const result = original.slice(0, index) + input.replacement + original.slice(index + input.expected.length);
  signal?.throwIfAborted();
  // 候補ごとに新しいディレクトリーを作り、既存候補や利用者のファイルを上書きしません。
  await assertOrdinaryPath(stagingRoot);
  await mkdir(stagingRoot, { recursive: true });
  await assertOrdinaryPath(stagingRoot);
  const directory = path.join(stagingRoot, randomUUID());
  await mkdir(directory);
  const target = path.join(directory, 'candidate.ts');
  await writeFile(target, result, { flag: 'wx', mode: 0o600 });
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifest = { version: 1, source: input.path, beforeHash: digest(original), afterHash: digest(result), candidate: 'candidate.ts', status: 'unverified', createdAt: new Date().toISOString() };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...manifest, candidateId: path.basename(directory) };
}

export function validateSourceInspection(value: unknown): SourceInspection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ソース調査の指定が不正です。');
  const request = value as Record<string, unknown>;
  if (request.operation === 'search' && Object.keys(request).every(key => ['operation', 'query'].includes(key))
    && typeof request.query === 'string' && request.query.trim().length > 0 && request.query.length <= 160
    && !/[\r\n\0]/.test(request.query)) return { operation: 'search', query: request.query };
  if (request.operation === 'read' && Object.keys(request).every(key => ['operation', 'path', 'startLine'].includes(key))
    && typeof request.path === 'string' && sourceName(request.path)
    && (request.startLine === undefined || (Number.isInteger(request.startLine) && Number(request.startLine) >= 1 && Number(request.startLine) <= 100000))) {
    return { operation: 'read', path: request.path, ...(request.startLine === undefined ? {} : { startLine: Number(request.startLine) }) };
  }
  throw new Error('ソース調査の指定が不正です。');
}

/** 実パスと無視設定を再確認し、リンク・範囲外・Git無視対象を読みません。 */
async function checkedFile(root: string, name: string, included = false): Promise<string> {
  if (!sourceName(name)) throw new Error('調査できないパスです。');
  if (!included) await assertTaskPathIncluded(root, name);
  const requested = path.resolve(root, name);
  await assertOrdinaryPath(requested);
  const actual = await realpath(requested);
  const relative = path.relative(root, actual);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('調査範囲外のパスです。');
  const stat = await lstat(requested);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('通常のソースファイルを確認できません。');
  return actual;
}

/** AIの検索語は文字列検索としてのみ使用し、分類・コマンド・正規表現には使用しません。 */
export async function inspectMaintenanceSource(request: SourceInspection, signal?: AbortSignal, installRoot?: string): Promise<unknown> {
  const root = await realpath(installRoot || process.env.WENTIAN_INSTALL_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const checked = validateSourceInspection(request);
  signal?.throwIfAborted();
  if (checked.operation === 'read') {
    const file = await checkedFile(root, checked.path);
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    const start = checked.startLine || 1;
    return { operation: 'read', path: checked.path, startLine: start, totalLines: lines.length,
      lines: lines.slice(start - 1, start + 19).map((line, index) => ({ line: start + index, text: line.slice(0, 400) })) };
  }
  let names: string[] = [];
  let included = false;
  try {
    // 一括列挙により検索対象をGit無視設定に合わせ、ファイルごとのGit起動を避けます。
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
    const result = await promisify(execFile)('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'docs'],
      { cwd: root, env, windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, signal });
    names = [...new Set(result.stdout.split('\0').filter(sourceName))].sort();
    included = true;
  } catch (error) {
    signal?.throwIfAborted();
    // Git管理外の配布版は通常ファイルを探索し、読取り時に個別に範囲を検査します。
    if ((error as { code?: unknown }).code !== 128 && (error as { code?: unknown }).code !== 'ENOENT') throw error;
  }
  async function walk(directory: string, relative: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else if (entry.isFile() && sourceName(name)) names.push(name);
      if (names.length > 5000) throw new Error('調査対象が上限を超えています。');
    }
  }
  if (!included) { await walk(path.join(root, 'src'), 'src'); await walk(path.join(root, 'docs'), 'docs'); }
  if (names.length > 5000) throw new Error('調査対象が上限を超えています。');
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const name of names) {
    signal?.throwIfAborted();
    let file: string;
    try { file = await checkedFile(root, name, included); } catch { continue; }
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].includes(checked.query)) matches.push({ path: name, line: index + 1, text: lines[index].slice(0, 300) });
      if (matches.length >= 12) return { operation: 'search', query: checked.query, matches, truncated: true };
    }
  }
  return { operation: 'search', query: checked.query, matches, truncated: false };
}
