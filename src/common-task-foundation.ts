import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';

export type TaskStatus = 'queued' | 'running' | 'input_required' | 'completed' | 'failed' | 'canceled';
export interface TaskArtifact { name: string; uri?: string; mediaType?: string; }
export interface TaskVerification { status: 'passed' | 'failed' | 'not_configured' | 'blocked'; details?: string; }
export interface TaskInfo {
  taskId: string; ownerId: string; status: TaskStatus; prompt: string; context?: Record<string, unknown>;
  progress?: { percent?: number; message?: string }; artifacts: TaskArtifact[]; verification?: TaskVerification;
  error?: string; createdAt: string; updatedAt: string;
}
export interface SubmitTaskInput { prompt: string; context?: Record<string, unknown>; }
export interface TaskResult { taskId: string; status: TaskStatus; artifacts: TaskArtifact[]; verification?: TaskVerification; error?: string; }
export interface CommonTaskService {
  submitTask(ownerId: string, input: SubmitTaskInput): Promise<TaskInfo>;
  getTask(ownerId: string, taskId: string): Promise<TaskInfo>;
  listTasks(ownerId: string): Promise<TaskInfo[]>;
  cancelTask(ownerId: string, taskId: string): Promise<TaskInfo>;
  getResult(ownerId: string, taskId: string): Promise<TaskResult>;
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'canceled', 'failed'], running: ['input_required', 'completed', 'failed', 'canceled'],
  input_required: ['running', 'failed', 'canceled'], completed: [], failed: [], canceled: [],
};

/** 所有者を含む永続タスクを、1タスク1ファイルで原子的に保存します。 */
export class FileTaskService implements CommonTaskService {
  private readonly root: string;
  private mutationQueue: Promise<void> = Promise.resolve();
  constructor(root = '.wentian/tasks') { this.root = path.resolve(root); }

  async submitTask(ownerId: string, input: SubmitTaskInput): Promise<TaskInfo> {
    if (!ownerId.trim() || ownerId.length > 256) throw new Error('有効な所有者IDが必要です。');
    if (!input.prompt.trim() || input.prompt.length > 100_000) throw new Error('依頼本文は1～100,000文字で指定してください。');
    const now = new Date().toISOString();
    const task: TaskInfo = { taskId: `task_${randomUUID()}`, ownerId, status: 'queued', prompt: input.prompt.trim(),
      ...(input.context ? { context: structuredClone(input.context) } : {}), artifacts: [], createdAt: now, updatedAt: now };
    await this.writeTask(task); return structuredClone(task);
  }

  async getTask(ownerId: string, taskId: string): Promise<TaskInfo> {
    const task = await this.readTask(taskId); this.ensureOwner(task, ownerId); return structuredClone(task);
  }

  async listTasks(ownerId: string): Promise<TaskInfo[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const tasks: TaskInfo[] = [];
    for (const name of names.filter(name => /^task_[0-9a-f-]+\.json$/i.test(name))) {
      try { const task = this.validate(JSON.parse(await readFile(path.join(this.root, name), 'utf8'))); if (task.ownerId === ownerId) tasks.push(task); }
      catch { /* 壊れた別タスクのために一覧全体を失敗させません。 */ }
    }
    return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(task => structuredClone(task));
  }

  async transition(ownerId: string, taskId: string, status: TaskStatus, patch: Partial<Pick<TaskInfo, 'progress' | 'artifacts' | 'verification' | 'error'>> = {}): Promise<TaskInfo> {
    return this.mutate(async () => {
      const task = await this.readTask(taskId); this.ensureOwner(task, ownerId);
      if (!transitions[task.status].includes(status)) throw new Error(`状態遷移 ${task.status} → ${status} は許可されていません。`);
      Object.assign(task, structuredClone(patch), { status, updatedAt: new Date().toISOString() });
      await this.writeTask(task); return structuredClone(task);
    });
  }

  async cancelTask(ownerId: string, taskId: string): Promise<TaskInfo> {
    return this.mutate(async () => {
      const task = await this.readTask(taskId); this.ensureOwner(task, ownerId);
      if (task.status === 'canceled') return structuredClone(task);
      if (!transitions[task.status].includes('canceled')) throw new Error(`状態遷移 ${task.status} → canceled は許可されていません。`);
      task.status = 'canceled'; task.updatedAt = new Date().toISOString();
      await this.writeTask(task); return structuredClone(task);
    });
  }

  /** 永続ワーカーが再起動時に未完了タスクを復旧するための内部一覧です。所有者向けAPIには公開しません。 */
  async listRunnableTasks(): Promise<TaskInfo[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const tasks: TaskInfo[] = [];
    for (const name of names.filter(name => /^task_[0-9a-f-]+\.json$/i.test(name))) {
      try {
        const task = this.validate(JSON.parse(await readFile(path.join(this.root, name), 'utf8')));
        if (task.status === 'queued' || task.status === 'running') tasks.push(task);
      } catch { /* 壊れたタスクは実行せず、正常なタスクの復旧を続けます。 */ }
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(task => structuredClone(task));
  }

  /** 実行中の進捗だけを更新します。キャンセルと同じ直列化境界を通し、終了状態を上書きしません。 */
  async updateRunning(ownerId: string, taskId: string, progress: TaskInfo['progress']): Promise<TaskInfo> {
    return this.mutate(async () => {
      const task = await this.readTask(taskId); this.ensureOwner(task, ownerId);
      if (task.status !== 'running') return structuredClone(task);
      task.progress = structuredClone(progress); task.updatedAt = new Date().toISOString();
      await this.writeTask(task); return structuredClone(task);
    });
  }

  async getResult(ownerId: string, taskId: string): Promise<TaskResult> {
    const task = await this.getTask(ownerId, taskId);
    return { taskId: task.taskId, status: task.status, artifacts: structuredClone(task.artifacts),
      ...(task.verification ? { verification: structuredClone(task.verification) } : {}), ...(task.error ? { error: task.error } : {}) };
  }

  private taskPath(taskId: string): string {
    if (!/^task_[0-9a-f-]+$/i.test(taskId)) throw new Error('タスクIDの形式が不正です。');
    return path.join(this.root, `${taskId}.json`);
  }
  private async readTask(taskId: string): Promise<TaskInfo> {
    const target = this.taskPath(taskId);
    try { return this.validate(JSON.parse(await readFile(target, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`タスク '${taskId}' は存在しません。`); throw error; }
  }
  private validate(value: unknown): TaskInfo {
    const task = value as TaskInfo;
    if (!task || typeof task !== 'object' || !/^task_[0-9a-f-]+$/i.test(task.taskId) || typeof task.ownerId !== 'string'
      || !(task.status in transitions) || typeof task.prompt !== 'string' || !Array.isArray(task.artifacts)
      || typeof task.createdAt !== 'string' || typeof task.updatedAt !== 'string') throw new Error('保存されたタスクの形式が不正です。');
    return task;
  }
  private async writeTask(task: TaskInfo): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.taskPath(task.taskId); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await renameWithRetry(temporary, target);
  }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  private ensureOwner(task: TaskInfo, ownerId: string): void { if (task.ownerId !== ownerId) throw new Error('このタスクへのアクセス権がありません。'); }
}
