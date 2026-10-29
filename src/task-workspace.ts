import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { captureArtifactSnapshot, type ArtifactSnapshot } from './artifact-evidence.js';
import { assertOrdinaryPath } from './safe-file.js';
import { transactionalPublish, type PublicationOptions } from './task-publication.js';

const exec = promisify(execFile);

/** 無視対象を隔離コピーへ黙って取り込まず、指定された操作を事前に拒否します。 */
export async function assertTaskPathIncluded(workspace: string, requested: string): Promise<void> {
  const relative = path.relative(path.resolve(workspace), path.resolve(workspace, requested)).replaceAll('\\', '/');
  if (relative.split('/').some(part => ['.git', '.wentian', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv'].includes(part.toLowerCase()))) throw new Error(`隔離コピーの対象外パスは変更できません: ${relative}`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  let ignored = false;
  try { await exec('git', ['check-ignore', '-q', '--', relative], { cwd: workspace, env, windowsHide: true, timeout: 10_000 }); ignored = true; }
  catch (error) {
    // 1は無視対象ではない、128はGit管理外。その他の診断失敗は無視しません。
    if (![1, 128].includes(Number((error as { code?: unknown }).code))) throw error;
  }
  if (ignored) throw new Error(`Git無視対象は隔離コピーへ含めないため変更できません: ${relative}。別の設定管理手順を使用してください。`);
}

export interface TaskWorkspace {
  source: string;
  directory: string;
  baselineSha: string;
  baseline: ArtifactSnapshot;
}

export interface PublishResult {
  status: 'published' | 'no_changes' | 'conflict';
  destination: string;
  files: string[];
  note: string;
  journalPath?: string;
  recoveryRequired?: boolean;
}

/**
 * 元のGit管理領域を共有しない、制作専用のリポジトリを作成します。
 * 現在の未コミット・未追跡ファイルを含むスナップショット（Snapshot）を複製し、
 * 原本へのcommit・reset・stashは一切行いません。依存物とGit無視対象は複製しません。
 * コピー中の変更や不完全な取得は例外として止め、原本での代替実行を許しません。
 * 作業場所は検収のため保持します。これはOSのサンドボックス（Sandbox）ではありません。
 */
export async function createTaskWorkspace(source: string, parentDirectory?: string): Promise<TaskWorkspace> {
  await assertOrdinaryPath(source);
  const root = await realpath(source);
  const snapshot = await captureArtifactSnapshot(root);
  if (!snapshot.complete) throw new Error(`制作場所を作成できません。元ファイルの取得が不完全です: ${snapshot.issues.join('; ')}`);
  // 内部の保守検証は許可済み専用領域内へコピーし、Temp全体の許可を要求しません。
  const parent = parentDirectory ? await realpath(parentDirectory) : tmpdir();
  await assertOrdinaryPath(parent);
  const directory = await mkdtemp(path.join(parent, 'wentian-task-'));
  for (const [name, hash] of Object.entries(snapshot.files)) {
    await assertOrdinaryPath(path.resolve(root, name));
    const input = await realpath(path.resolve(root, name));
    const relative = path.relative(root, input);
    const output = path.resolve(directory, name);
    const destination = path.relative(directory, output);
    if ([relative, destination].some(value => value === '..' || value.startsWith(`..${path.sep}`) || path.isAbsolute(value))) {
      throw new Error(`制作場所の範囲外です: ${name}`);
    }
    // Gitの管理用パスを成果物として取り込まず、共有インデックスやフックを持ち込ませません。
    if (name.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error(`Git管理用パスは複製できません: ${name}`);
    const content = await readFile(input);
    if (createHash('sha256').update(content).digest('hex') !== hash) throw new Error(`コピー中に変更されました: ${name}`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, content, { flag: 'wx', mode: (await stat(input)).mode });
  }
  // 初期化・基準コミットは新規作業場所だけで実施し、利用者のGitフックを実行しません。
  // GIT_DIRなどが親環境にあっても原本を操作しないよう、Git専用の環境変数を除去します。
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(directory, '.git', 'no-global-config');
  const git = (args: string[]) => exec('git', args, { cwd: directory, env, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  await git(['init', '--template=', '--initial-branch=wentian-task']);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'core.hooksPath', path.join(directory, '.git', 'disabled-hooks')]);
  // 元では追跡済みでもignore対象になっているファイルを、基準から落とさないよう明示登録します。
  // NUL区切りで一括登録し、空白・改行・パス指定の特殊文字もファイル名として扱います。
  if (Object.keys(snapshot.files).length) {
    await writeFile(path.join(directory, '.git', 'wentian-paths'), Object.keys(snapshot.files).join('\0') + '\0');
    await git(['--literal-pathspecs', 'add', '--force', '--pathspec-from-file=.git/wentian-paths', '--pathspec-file-nul']);
  }
  await git(['-c', 'user.name=Wentian', '-c', 'user.email=wentian@localhost', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', '制作開始時点のスナップショット']);
  const baselineSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const baseline = await captureArtifactSnapshot(directory);
  if (!baseline.complete || JSON.stringify(Object.entries(baseline.files).sort()) !== JSON.stringify(Object.entries(snapshot.files).sort())) {
    throw new Error(`制作場所のコピー検証に失敗しました: ${directory}`);
  }
  return { source: root, directory, baselineSha, baseline };
}

/**
 * 検収済みStagingの追加・変更ファイルを、開始後の競合とSymbolic Linkを確認してTargetへ反映します。
 * 削除は自動反映せず、各ファイルは同一Directory内の一時ファイルからAtomic Renameします。
 */
export async function publishTaskWorkspace(workspace: TaskWorkspace, changes: Array<{ path: string; kind: 'added' | 'modified' | 'deleted'; beforeHash?: string; afterHash?: string }>, options: PublicationOptions = {}): Promise<PublishResult> {
  return transactionalPublish(workspace, changes, options);
}
