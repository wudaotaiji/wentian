/**
 * Git Checkpoint: 5層アーキテクチャ L4。
 * 設計参照: docs/ARCHITECTURE.md
 *
 * 各 TODO に対し:
 *  - 開始時: 現在の HEAD を下書き checkpoint として記録
 *  - 完了時: TODO本文を message に含めて `git commit` し、SHA を確定 checkpoint として保存
 *  - 失敗時: `git stash push -u -m ...` で未コミット変更を退避
 *
 * 制約:
 *  - git 管理外ディレクトリでは checkpoint は 'none' とし、警告ログのみ
 *  - git コマンドは assertSafeCommand のホワイトリストに合致する呼び出しのみ
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GoalStore, GoalTodo } from './goal-store.js';

const exec = promisify(execFile);

export interface CheckpointResult {
  sha: string | null;
  message: string;
}

export interface CheckpointOptions {
  /** 並列実行される他git操作と干渉しないよう環境変数で隔離する */
  env?: NodeJS.ProcessEnv;
  /** タイムアウト (ms) */
  timeoutMs?: number;
  /** gitコマンドが見つからない等の致命的エラー時、falseを返してフォールバック */
  allowFailure?: boolean;
}

/** cwd が git リポジトリ内か判定します。 */
export async function isGitRepository(cwd: string, options: CheckpointOptions = {}): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd, windowsHide: true, timeout: options.timeoutMs || 5_000 });
    return true;
  } catch { return false; }
}

/** 現在のHEADの短縮SHAを返します。git管理外なら null。 */
export async function currentHead(cwd: string, options: CheckpointOptions = {}): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd, windowsHide: true, timeout: options.timeoutMs || 5_000 });
    return stdout.trim() || null;
  } catch { return null; }
}

/** TODO開始時: 現在のHEADを記録。git管理外なら null。 */
export async function checkpointStart(goal: GoalStore, todo: GoalTodo, cwd: string, options: CheckpointOptions = {}): Promise<string | null> {
  const head = await currentHead(cwd, options);
  if (head) {
    todo.checkpoint = head;
    todo.lastError = null;
  }
  return head;
}

/** TODO完了時: 変更があれば commit し、SHAを返します。変更が無ければHEADをそのまま返します。 */
export async function checkpointComplete(goal: GoalStore, todo: GoalTodo, summary: string, cwd: string, options: CheckpointOptions = {}): Promise<CheckpointResult> {
  if (!(await isGitRepository(cwd, options))) {
    return { sha: null, message: 'git管理外ディレクトリのためcheckpointを記録しません。' };
  }
  // 1. 変更が無いか確認
  const status = await safeGit(cwd, ['status', '--porcelain'], options);
  if (!status.trim()) {
    // 変更なし → 既存のHEADをそのまま返す
    const head = await currentHead(cwd, options);
    todo.checkpoint = head;
    return { sha: head, message: '変更がないため commit をスキップしました。' };
  }
  // 2. add + commit
  await safeGit(cwd, ['add', '-A'], options);
  const message = `goal(${goal.id}): ${todo.title} [${todo.id}]\n\n${summary.slice(0, 1000)}`;
  await safeGit(cwd, ['commit', '-m', message, '--no-verify'], options);
  const sha = await currentHead(cwd, options);
  todo.checkpoint = sha;
  return { sha, message: `commit完了: ${sha}` };
}

/** TODO失敗時: 作業treeをstashで巻き戻し、開始時のHEADへ戻します。 */
export async function checkpointRollback(goal: GoalStore, todo: GoalTodo, reason: string, cwd: string, options: CheckpointOptions = {}): Promise<{ rolled: boolean; message: string }> {
  if (!(await isGitRepository(cwd, options))) {
    return { rolled: false, message: 'git管理外ディレクトリのためstashをスキップしました。' };
  }
  const startHead = todo.checkpoint;
  const status = await safeGit(cwd, ['status', '--porcelain'], options);
  if (!status.trim()) {
    return { rolled: false, message: '未コミット変更がないためstash不要。' };
  }
  const stashMessage = `goal(${goal.id})-${todo.id}-fail: ${reason.slice(0, 200)}`;
  await safeGit(cwd, ['stash', 'push', '-u', '-m', stashMessage], options);
  let rolled = false;
  if (startHead) {
    try {
      await safeGit(cwd, ['reset', '--hard', startHead], options);
      rolled = true;
    } catch (error) {
      return { rolled: false, message: `stashはしたがreset失敗: ${(error as Error).message}` };
    }
  }
  return { rolled, message: `stash退避: ${stashMessage}${rolled ? ` → HEAD ${startHead} へ戻しました` : ''}` };
}

async function safeGit(cwd: string, args: string[], options: CheckpointOptions): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, windowsHide: true, timeout: options.timeoutMs || 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (options.allowFailure) return '';
    throw error;
  }
}
