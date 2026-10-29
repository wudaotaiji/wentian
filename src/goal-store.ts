/**
 * Project Goal Store: 長期goal (数日〜数週間で完走する作業) の単一情報源。
 * `.wentian/goals/<goal-id>.json` に原子書込で永続化し、5層アーキテクチャ L1 を提供します。
 *
 * 設計参照: docs/ARCHITECTURE.md
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateAcceptance, type AcceptanceCheck, type DeliveryVerification } from './delivery-verification.js';
import type { SessionTokenUsage } from './agent-session.js';

export type GoalStatus = 'active' | 'paused' | 'completed' | 'aborted';
export type TodoStatus = 'pending' | 'active' | 'done' | 'blocked' | 'failed';
export type TodoOwner = 'agent' | 'human';

export interface StopPolicy {
  maxConsecutiveFailures: number;
  maxTotalAttempts: number;
  maxWallClockHours: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxReplans?: number;
}

export interface GoalTodo {
  usage?: SessionTokenUsage;
  acceptance?: AcceptanceCheck[];
  verification?: DeliveryVerification;
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
  owner: TodoOwner;
  dependsOn: string[];
  attempts: number;
  lastError: string | null;
  checkpoint: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BlockedEntry {
  todoId: string;
  reason: string;
  since: string;
}

export interface GoalMetrics {
  elapsedRuntimeMs?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  totalReplans?: number;
  totalAttempts: number;
  consecutiveFailures: number;
  completedCount: number;
  blockedCount: number;
  startedAt: string;
  lastTickAt: string;
}

export interface GoalStore {
  executionMode?: 'internal' | 'orchestrated';
  workspace?: string;
  version: '1.0';
  id: string;
  createdAt: string;
  updatedAt: string;
  status: GoalStatus;
  title: string;
  description: string;
  context: string;
  todos: GoalTodo[];
  blocked: BlockedEntry[];
  metrics: GoalMetrics;
  stop: StopPolicy;
}

const GOAL_ID_PATTERN = /^goal-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]{2,40}$/;
const DEFAULT_STOP: StopPolicy = { maxConsecutiveFailures: 3, maxTotalAttempts: 100, maxWallClockHours: 72, maxTokens: 500_000, maxReplans: 3 };

/** 停止方針（Stop Policy）は壊れた値を無制限と解釈せず、旧形式の不足値だけ補完します。 */
export function validateStopPolicy(value: Partial<StopPolicy>): StopPolicy {
  const stop = { ...DEFAULT_STOP, ...value };
  for (const key of ['maxConsecutiveFailures', 'maxTotalAttempts', 'maxWallClockHours', 'maxTokens', 'maxCostUsd', 'maxReplans'] as const) {
    const limit = stop[key];
    if (limit === undefined) continue;
    if (!Number.isFinite(limit) || limit < 0 || (!['maxCostUsd', 'maxReplans'].includes(key) && limit === 0)) throw new Error(`停止予算（Stop Budget）の${key}が不正です。`);
  }
  return stop;
}

/** Goal Store のルートディレクトリを返します。環境変数で上書き可能です。 */
export function goalsRoot(): string {
  return process.env.WENTIAN_GOAL_PATH || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'goals');
}

/** ファイルシステムパスを返します。IDは厳格にバリデーションして path traversal を防ぎます。 */
export function goalPath(id: string): string {
  if (!GOAL_ID_PATTERN.test(id)) throw new Error(`不正なGoal IDです: ${id}`);
  return path.join(goalsRoot(), `${id}.json`);
}

/** 中断要求をGoal本体とは別ファイルに保存し、実行側の進捗保存との競合を避けます。 */
export async function requestGoalPause(id: string): Promise<void> {
  await atomicWrite(`${goalPath(id)}.pause`, 'pause');
}

export async function consumeGoalPause(id: string): Promise<boolean> {
  try { await unlink(`${goalPath(id)}.pause`); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** 並行終了でも壊れたJSONを残さないよう、一時ファイルから原子的に置換します。 */
async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  // Windows Defender などが直前に書いたファイルへ短時間ロックを残す場合があるため、
  // 短いバックオフを挟んでから rename を試みる。
  const delays = [0, 10, 40, 100, 250, 500];
  let lastError: unknown;
  for (const delayMs of delays) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try { await rename(temporary, target); return; } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
    }
  }
  throw lastError;
}

/** 人間可読なGoal IDを生成します。`goal-YYYY-MM-DD-<slug>-<rand>` の形式。 */
export function createGoalId(title: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'goal';
  const random = randomUUID().replace(/-/g, '').slice(0, 6);
  const id = `goal-${stamp}-${slug}-${random}`;
  // バリデーションを通るよう長さを整える
  return id.length <= 64 ? id : id.slice(0, 64).replace(/-+$/, '');
}

export interface CreateGoalInput {
  executionMode?: 'internal' | 'orchestrated';
  workspace?: string;
  id?: string;
  title: string;
  description: string;
  context?: string;
  stop?: Partial<StopPolicy>;
  now?: Date;
}

/** 新規Goalを作成して永続化し、初期化されたGoalStoreを返します。 */
export async function createGoal(input: CreateGoalInput): Promise<GoalStore> {
  const now = input.now || new Date();
  const id = input.id || createGoalId(input.title, now);
  if (!GOAL_ID_PATTERN.test(id)) throw new Error(`Goal IDが命名規約に合いません: ${id}`);
  const goal: GoalStore = {
    executionMode: input.executionMode,
    workspace: input.workspace ? path.resolve(input.workspace) : undefined,
    version: '1.0', id, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    status: 'active', title: input.title, description: input.description, context: input.context || '',
    todos: [], blocked: [],
    metrics: { totalAttempts: 0, consecutiveFailures: 0, completedCount: 0, blockedCount: 0, startedAt: now.toISOString(), lastTickAt: now.toISOString() },
    stop: validateStopPolicy(input.stop ?? {}),
  };
  await saveGoal(goal);
  return goal;
}

/** 既存Goalをファイルから読み込みます。 */
export async function loadGoal(id: string): Promise<GoalStore> {
  const raw = await readFile(goalPath(id), 'utf8');
  const parsed = JSON.parse(raw) as GoalStore;
  if (parsed.version !== '1.0' || parsed.id !== id) throw new Error(`Goalファイルが不正です: ${id}`);
  if (!Array.isArray(parsed.todos) || !Array.isArray(parsed.blocked)) throw new Error(`Goalファイルの構造が不正です: ${id}`);
  parsed.stop = validateStopPolicy(parsed.stop);
  return parsed;
}

/** タスク本体を削除済み領域へ原子的に移し、一覧から除外します。成果物と実行ログは保持します。呼び出し側で実行停止と権限を確認してください。 */
export async function deleteGoal(id: string): Promise<void> {
  const source = goalPath(id);
  const archive = path.join(path.dirname(source), 'deleted');
  await mkdir(archive, { recursive: true });
  await rename(source, path.join(archive, `${id}.${randomUUID()}.json`));
}

/** ディレクトリ内の全Goalを読み込み、updatedAt 降順で返します。 */
export async function listGoals(): Promise<GoalStore[]> {
  let names: string[] = [];
  try { names = await readdir(goalsRoot()); } catch { return []; }
  const results = await Promise.all(
    names
      .filter(name => /^goal-.*\.json$/.test(name))
      .map(async name => {
        const id = name.replace(/\.json$/, '');
        try { return await loadGoal(id); } catch { return undefined; }
      }),
  );
  return results
    .filter((goal): goal is GoalStore => Boolean(goal))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Goalを原子書込で永続化します。updatedAtも更新します。 */
export async function saveGoal(goal: GoalStore): Promise<void> {
  goal.updatedAt = new Date().toISOString();
  goal.metrics.lastTickAt = goal.updatedAt;
  await atomicWrite(goalPath(goal.id), `${JSON.stringify(goal, null, 2)}\n`);
}

export interface AddTodoInput {
  acceptance?: AcceptanceCheck[];
  title: string;
  description?: string;
  owner?: TodoOwner;
  dependsOn?: string[];
}

/** TODOを追加してGoalへ保存し、追加されたTODOを返します。 */
export async function addTodo(goal: GoalStore, input: AddTodoInput): Promise<GoalTodo> {
  const todo: GoalTodo = {
    acceptance: validateAcceptance(input.acceptance || []),
    id: createTodoId(goal),
    title: input.title, description: input.description,
    status: 'pending', owner: input.owner || 'agent',
    dependsOn: input.dependsOn || [],
    attempts: 0, lastError: null, checkpoint: null, startedAt: null, completedAt: null,
  };
  for (const depId of todo.dependsOn) {
    if (!goal.todos.find(t => t.id === depId)) throw new Error(`依存先TODOが存在しません: ${depId}`);
  }
  goal.todos.push(todo);
  await saveGoal(goal);
  return todo;
}

function createTodoId(goal: GoalStore): string {
  const used = new Set(goal.todos.map(t => t.id));
  for (let index = goal.todos.length + 1; index < goal.todos.length + 1000; index++) {
    const id = `t${index}`;
    if (!used.has(id)) return id;
  }
  return `t-${randomUUID().slice(0, 6)}`;
}

/** TODOを部分更新します。存在しないIDは例外。 */
export async function updateTodo(goal: GoalStore, id: string, patch: Partial<GoalTodo>): Promise<GoalTodo> {
  const todo = goal.todos.find(t => t.id === id);
  if (!todo) throw new Error(`TODOが見つかりません: ${id}`);
  if (patch.dependsOn) {
    for (const depId of patch.dependsOn) {
      if (depId === id) throw new Error(`TODOは自身に依存できません: ${id}`);
      if (!goal.todos.find(t => t.id === depId)) throw new Error(`依存先TODOが存在しません: ${depId}`);
    }
  }
  Object.assign(todo, patch);
  await saveGoal(goal);
  return todo;
}

/** TODOを `active` にし開始時刻を記録します。1度に1TODOだけactiveになるよう他を `pending` に戻します。 */
export async function activateTodo(goal: GoalStore, id: string): Promise<GoalTodo> {
  for (const todo of goal.todos) {
    if (todo.status === 'active' && todo.id !== id) todo.status = 'pending';
  }
  const target = goal.todos.find(t => t.id === id);
  if (!target) throw new Error(`TODOが見つかりません: ${id}`);
  if (target.status === 'done') throw new Error(`TODOは既にdoneです: ${id}`);
  for (const depId of target.dependsOn) {
    const dep = goal.todos.find(t => t.id === depId);
    if (!dep) throw new Error(`依存先TODOが存在しません: ${depId}`);
    if (dep.status !== 'done') throw new Error(`依存先TODOが未完了です: ${depId} (${dep.status})`);
  }
  target.status = 'active';
  target.startedAt = target.startedAt || new Date().toISOString();
  target.attempts += 1;
  goal.metrics.totalAttempts += 1;
  await saveGoal(goal);
  return target;
}

/** TODOを `done` にしてcheckpoint SHAを記録し、consecutiveFailuresを0にリセットします。 */
export async function markDone(goal: GoalStore, id: string, checkpoint: string | null): Promise<GoalTodo> {
  const todo = goal.todos.find(t => t.id === id);
  if (!todo) throw new Error(`TODOが見つかりません: ${id}`);
  todo.status = 'done';
  todo.checkpoint = checkpoint;
  todo.completedAt = new Date().toISOString();
  todo.lastError = null;
  goal.metrics.completedCount += 1;
  goal.metrics.consecutiveFailures = 0;
  await saveGoal(goal);
  return todo;
}

/** TODOの失敗を記録します。戻り値は更新後のconsecutiveFailures値。 */
export async function markFailed(goal: GoalStore, id: string, error: string): Promise<number> {
  const todo = goal.todos.find(t => t.id === id);
  if (!todo) throw new Error(`TODOが見つかりません: ${id}`);
  todo.status = 'failed';
  todo.lastError = error.slice(0, 4000);
  todo.completedAt = new Date().toISOString();
  goal.metrics.consecutiveFailures += 1;
  if (goal.metrics.consecutiveFailures >= goal.stop.maxConsecutiveFailures) {
    goal.status = 'aborted';
  }
  await saveGoal(goal);
  return goal.metrics.consecutiveFailures;
}

/** TODOを `blocked` にし、BlockedEntryを追加します。 */
export async function markBlocked(goal: GoalStore, id: string, reason: string): Promise<void> {
  const todo = goal.todos.find(t => t.id === id);
  if (!todo) throw new Error(`TODOが見つかりません: ${id}`);
  todo.status = 'blocked';
  todo.lastError = reason.slice(0, 2000);
  goal.blocked = goal.blocked.filter(entry => entry.todoId !== id);
  goal.blocked.push({ todoId: id, reason: reason.slice(0, 2000), since: new Date().toISOString() });
  goal.metrics.blockedCount += 1;
  goal.metrics.consecutiveFailures += 1;
  await saveGoal(goal);
}

/**
 * 依存関係と状態を考慮し、次に実行するTODOを選びます。
 * 優先順位: pending (dependsOn全done) → failed (再試行) → blocked
 * blockedTODOは依存解消待ちとして pending より低優先。
 */
export function pickNextTodo(goal: GoalStore): GoalTodo | undefined {
  const isPendingReady = (todo: GoalTodo) => {
    if (todo.status !== 'pending' && todo.status !== 'failed') return false;
    return todo.dependsOn.every(depId => goal.todos.find(t => t.id === depId)?.status === 'done');
  };
  const pending = goal.todos.find(isPendingReady);
  if (pending) return pending;
  return undefined;
}

/** 空のGoalや保留項目を完了と見なさず、全TODOのdoneを要求します。 */
export function isGoalFinished(goal: GoalStore): boolean {
  return goal.todos.length > 0 && goal.todos.every(t => t.status === 'done');
}

/** 進捗サマリを1行テキストで返します。loop表示とloggerで利用。 */
export function formatGoalProgress(goal: GoalStore): string {
  const total = goal.todos.length;
  const done = goal.metrics.completedCount;
  const blocked = goal.metrics.blockedCount;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return `[${goal.id}] status=${goal.status} progress=${done}/${total} (${pct}%) blocked=${blocked} consecutiveFailures=${goal.metrics.consecutiveFailures}/${goal.stop.maxConsecutiveFailures} totalAttempts=${goal.metrics.totalAttempts}`;
}
