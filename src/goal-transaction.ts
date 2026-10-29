/**
 * Goal Transaction ログ: 5層アーキテクチャ拡張 Phase 7。
 * 設計参照: docs/ARCHITECTURE.md
 *
 * 各TODOの実行状態を .wentian/goals/<id>/tx/<todo-id>.json に書き、
 * 電源断や強制終了でmarkDone/markFailed書き込み前に死んでも、
 * 再起動時に整合を取れるようにする。
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { goalsRoot, type GoalStore, type GoalTodo, saveGoal } from './goal-store.js';
import { currentHead } from './git-checkpoint.js';

export type TxPhase = 'start' | 'checkpoint' | 'running' | 'done' | 'failed' | 'rolled-back';

export interface GoalTransaction {
  version: '1.0';
  todoId: string;
  goalId: string;
  phase: TxPhase;
  startedAt: string;
  lastUpdate: string;
  checkpointSha: string | null;
  pid: number;
  error?: string | null;
}

function txDir(goalId: string): string { return path.join(goalsRoot(), goalId, 'tx'); }
function txPath(goalId: string, todoId: string): string { return path.join(txDir(goalId), `${todoId}.json`); }

/** 原子書込 (Windows EPERM バックオフ付き) */
async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  const delays = [0, 10, 40, 100, 250, 500];
  let lastError: unknown;
  for (const d of delays) {
    if (d > 0) await new Promise(r => setTimeout(r, d));
    try { await rename(tmp, target); return; } catch (e) {
      lastError = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw e;
    }
  }
  throw lastError;
}

/** TODO実行開始の transaction を作成。 */
export async function txStart(goal: GoalStore, todo: GoalTodo, cwd: string): Promise<GoalTransaction> {
  const head = await currentHead(cwd, { allowFailure: true });
  const tx: GoalTransaction = {
    version: '1.0', todoId: todo.id, goalId: goal.id, phase: 'start',
    startedAt: new Date().toISOString(), lastUpdate: new Date().toISOString(),
    checkpointSha: head, pid: process.pid, error: null,
  };
  await atomicWrite(txPath(goal.id, todo.id), JSON.stringify(tx, null, 2));
  return tx;
}

/** 現在の transaction 状態を更新 (heartbeat等)。 */
export async function txTouch(goal: GoalStore, todoId: string, phase: TxPhase, error?: string | null): Promise<GoalTransaction> {
  const current = await loadTx(goal.id, todoId);
  if (!current) throw new Error(`Transaction not found: ${goal.id}/${todoId}`);
  current.phase = phase;
  current.lastUpdate = new Date().toISOString();
  if (error !== undefined) current.error = error ? error.slice(0, 4_000) : null;
  await atomicWrite(txPath(goal.id, todoId), JSON.stringify(current, null, 2));
  return current;
}

/** 成功時: tx.delete() で transaction を消す。 */
export async function txComplete(goal: GoalStore, todoId: string): Promise<void> {
  await unlink(txPath(goal.id, todoId)).catch(() => undefined);
}

/** 失敗時: tx.delete() で transaction を消す。 */
export async function txFail(goal: GoalStore, todoId: string, error: string): Promise<void> {
  await txTouch(goal, todoId, 'failed', error).catch(() => undefined);
  // failed 状態は記録として残し、resume 時に参照可能にする
}

/** Transaction を読み込みます。 */
export async function loadTx(goalId: string, todoId: string): Promise<GoalTransaction | undefined> {
  try {
    const raw = await readFile(txPath(goalId, todoId), 'utf8');
    return JSON.parse(raw) as GoalTransaction;
  } catch { return undefined; }
}

/** 該当Goalの全 transaction を列挙します。 */
export async function listTxs(goalId: string): Promise<GoalTransaction[]> {
  const dir = txDir(goalId);
  let names: string[] = []; try { names = await readdir(dir); } catch { return []; }
  const result: GoalTransaction[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const todoId = name.replace(/\.json$/, '');
    const tx = await loadTx(goalId, todoId);
    if (tx) result.push(tx);
  }
  return result;
}

export interface ReconcileResult {
  reconciled: number;
  recovered: number;
  rolledBack: number;
  details: Array<{ todoId: string; action: 'recovered' | 'rolled-back' | 'kept-active'; checkpointSha: string | null }>;
}

/**
 * Goalの全 active TODO を再起動耐性の観点で整合を取ります。
 *  - tx.phase='done'/'failed' かつ 該当TODOがまだactive → markDone/markFailedを再実行
 *  - tx未完了 (start/checkpoint/running) → checkpointShaへreset + pendingへ戻す
 *  - tx無しでactive → (前バージョンのため) pendingへ戻す
 */
export async function reconcileGoalTransactions(goal: GoalStore, cwd: string): Promise<ReconcileResult> {
  const txs = await listTxs(goal.id);
  const txByTodo = new Map(txs.map(tx => [tx.todoId, tx]));
  const result: ReconcileResult = { reconciled: 0, recovered: 0, rolledBack: 0, details: [] };
  for (const todo of goal.todos) {
    if (todo.status !== 'active') continue;
    const tx = txByTodo.get(todo.id);
    if (!tx) {
      // tx無しでactive: 安全側でpendingへ
      todo.status = 'pending';
      todo.lastError = 'resumed: no transaction found, safe rollback to pending';
      result.reconciled += 1;
      result.rolledBack += 1;
      result.details.push({ todoId: todo.id, action: 'rolled-back', checkpointSha: null });
      continue;
    }
    if (tx.phase === 'done') {
      // 既にdoneまで進行 → markDone再呼び出しで整合 (冪等)
      todo.status = 'done';
      todo.checkpoint = tx.checkpointSha;
      todo.completedAt = tx.lastUpdate;
      result.reconciled += 1;
      result.recovered += 1;
      result.details.push({ todoId: todo.id, action: 'recovered', checkpointSha: tx.checkpointSha });
    } else   if (tx.phase === 'failed') {
      todo.status = 'failed';
      todo.lastError = tx.error || 'failed (from tx)';
      todo.attempts = Math.max(1, todo.attempts);
      result.reconciled += 1;
      result.recovered += 1;
      result.details.push({ todoId: todo.id, action: 'recovered', checkpointSha: tx.checkpointSha });
    } else {
      // 未完了 (start/checkpoint/running) → checkpointShaへreset
      if (tx.checkpointSha) {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const exec = promisify(execFile);
          await exec('git', ['reset', '--hard', tx.checkpointSha], { cwd, windowsHide: true, timeout: 10_000 });
        } catch { /* git管理外の場合はno-op */ }
      }
      todo.status = 'pending';
      todo.checkpoint = tx.checkpointSha;
      todo.lastError = `resumed: tx phase=${tx.phase} was incomplete, rolled back`;
      result.reconciled += 1;
      result.rolledBack += 1;
      result.details.push({ todoId: todo.id, action: 'rolled-back', checkpointSha: tx.checkpointSha });
    }
  }
  await saveGoal(goal);
  return result;
}

/** 該当Goalのすべての transaction を削除します (完走時等)。 */
export async function clearAllTxs(goalId: string): Promise<void> {
  const dir = txDir(goalId);
  let names: string[] = []; try { names = await readdir(dir); } catch { return; }
  for (const name of names) {
    if (name.endsWith('.json')) await unlink(path.join(dir, name)).catch(() => undefined);
  }
}
