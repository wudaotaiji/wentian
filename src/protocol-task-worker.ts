import path from 'node:path';
import type { AgentPlan } from './agent-planner.js';
import { FileTaskService, type CommonTaskService, type SubmitTaskInput, type TaskArtifact, type TaskInfo, type TaskResult, type TaskVerification } from './common-task-foundation.js';
import { orchestrateExternalTask, type OrchestrationResult } from './external-orchestrator.js';

export interface ProtocolTaskWorkerOptions {
  workspace?: string;
  executionEnabled?: boolean;
  execute?: (task: TaskInfo, signal: AbortSignal, emit: (message: string) => void) => Promise<OrchestrationResult>;
}

/**
 * MCP/A2Aで受け付けた永続タスクを一件ずつ処理します。
 * 単一プロセス内の直列実行により、外部Agentの同時書込みを避けます。
 */
export class ProtocolTaskWorker {
  private readonly pending: string[] = [];
  private readonly pendingSet = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private draining = false;
  private stopped = false;
  private drainPromise: Promise<void> = Promise.resolve();

  constructor(private readonly store: FileTaskService, private readonly options: ProtocolTaskWorkerOptions = {}) {}

  /** 再起動前にqueued/runningだったタスクを古い順に再投入します。 */
  async start(): Promise<void> {
    this.stopped = false;
    for (const task of await this.store.listRunnableTasks()) this.enqueue(task.taskId);
  }

  enqueue(taskId: string): void {
    if (this.stopped || this.pendingSet.has(taskId) || this.controllers.has(taskId)) return;
    this.pending.push(taskId); this.pendingSet.add(taskId);
    if (!this.draining) this.drainPromise = this.drain();
  }

  cancel(taskId: string): void {
    this.controllers.get(taskId)?.abort(new Error('タスクが利用者により中断されました。'));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers.values()) controller.abort(new Error('Wentian終了によりタスクを中断しました。'));
    await this.drainPromise;
  }

  async waitForIdle(): Promise<void> { await this.drainPromise; }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.pending.length) {
        const taskId = this.pending.shift()!; this.pendingSet.delete(taskId);
        await this.run(taskId);
      }
    } finally { this.draining = false; }
  }

  private async run(taskId: string): Promise<void> {
    let task: TaskInfo;
    try {
      const candidates = await this.store.listRunnableTasks();
      const found = candidates.find(item => item.taskId === taskId);
      if (!found) return;
      task = found.status === 'queued'
        ? await this.store.transition(found.ownerId, found.taskId, 'running', { progress: { percent: 1, message: '実行を開始しました。' } })
        : await this.store.updateRunning(found.ownerId, found.taskId, { percent: 1, message: '再起動後に実行を復旧しました。' });
    } catch { return; }

    const controller = new AbortController(); this.controllers.set(taskId, controller);
    try {
      const execute = this.options.execute ?? ((item, signal, emit) => orchestrateExternalTask(this.plan(item), {
        workspace: path.resolve(this.options.workspace ?? process.cwd()), enabled: this.options.executionEnabled === true, signal, emit,
      }));
      const result = await execute(task, controller.signal, message => { void this.store.updateRunning(task.ownerId, task.taskId, { message }); });
      const latest = await this.store.getTask(task.ownerId, task.taskId);
      if (latest.status === 'canceled') return;
      const mapped = this.mapResult(result);
      await this.store.transition(task.ownerId, task.taskId, mapped.status, mapped.patch);
    } catch (error) {
      const latest = await this.store.getTask(task.ownerId, task.taskId).catch(() => undefined);
      // Gateway終了時はrunningを保持し、次回起動時の復旧対象にします。
      if (this.stopped || !latest || latest.status === 'canceled') return;
      await this.store.transition(task.ownerId, task.taskId, 'failed', { error: error instanceof Error ? error.message : String(error) });
    } finally { this.controllers.delete(taskId); }
  }

  private plan(task: TaskInfo): AgentPlan {
    return {
      version: '1.0', intent: 'delegate_external', language: /[ぁ-んァ-ヶ]/.test(task.prompt) ? 'ja' : /[一-龥]/.test(task.prompt) ? 'zh' : 'en',
      text: task.prompt, attachments: [], requiredCapabilities: ['text', 'file_read', 'file_write', 'terminal', 'review'],
      tools: ['read_file', 'write_file', 'run_command'], delegation: { enabled: true, parallel: false, requestedAgents: [], objective: task.prompt }, source: 'fallback',
    };
  }

  private mapResult(result: OrchestrationResult): { status: 'completed' | 'input_required' | 'failed'; patch: { artifacts: TaskArtifact[]; verification: TaskVerification; error?: string; progress: TaskInfo['progress'] } } {
    const artifacts: TaskArtifact[] = [{ name: '実行台帳', uri: result.manifestPath, mediaType: 'application/json' }];
    if (result.workspace?.directory) artifacts.push({ name: '隔離成果物', uri: result.workspace.directory });
    const verification: TaskVerification = result.acceptance
      ? { status: result.acceptance.status, details: result.acceptance.note }
      : { status: 'not_configured', details: result.note ?? '受入検証は実行されていません。' };
    if (result.status === 'completed') return { status: 'completed', patch: { artifacts, verification, progress: { percent: 100, message: '完了しました。' } } };
    if (result.status === 'failed') return { status: 'failed', patch: { artifacts, verification, error: result.note ?? '外部Agent実行に失敗しました。', progress: { message: '失敗しました。' } } };
    return { status: 'input_required', patch: { artifacts, verification, progress: { percent: 100, message: result.note ?? '成果物の人手確認が必要です。' } } };
  }
}

/** 登録直後の投入と、中断シグナルの伝播を共通タスクAPIへ付加します。 */
export class WorkerTaskService implements CommonTaskService {
  constructor(private readonly store: FileTaskService, private readonly worker: ProtocolTaskWorker) {}
  async submitTask(ownerId: string, input: SubmitTaskInput): Promise<TaskInfo> { const task = await this.store.submitTask(ownerId, input); this.worker.enqueue(task.taskId); return task; }
  getTask(ownerId: string, taskId: string): Promise<TaskInfo> { return this.store.getTask(ownerId, taskId); }
  listTasks(ownerId: string): Promise<TaskInfo[]> { return this.store.listTasks(ownerId); }
  async cancelTask(ownerId: string, taskId: string): Promise<TaskInfo> { const task = await this.store.cancelTask(ownerId, taskId); this.worker.cancel(taskId); return task; }
  getResult(ownerId: string, taskId: string): Promise<TaskResult> { return this.store.getResult(ownerId, taskId); }
}
