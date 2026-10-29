import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadAgentSelectionConfig } from './agent-selection.js';

export interface AgentPerformanceMetric {
  attempts: number; successes: number; consecutiveFailures: number;
  averageLatencyMs: number; averageQuality: number; estimatedTokens: number; estimatedCostUsd: number;
  byTask: Record<string, { attempts: number; successes: number; averageLatencyMs: number; consecutiveFailures?: number; openUntil?: string; lastError?: string }>;
  openUntil?: string; lastError?: string; updatedAt: string;
}
type Store = { version: '1.0'; agents: Record<string, AgentPerformanceMetric> };
let writeQueue = Promise.resolve();

export function performancePath(): string { return process.env.WENTIAN_AGENT_PERFORMANCE_FILE || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'agent-performance.json'); }
export function readAgentPerformance(): Store { try { return existsSync(performancePath()) ? JSON.parse(readFileSync(performancePath(), 'utf8')) as Store : { version: '1.0', agents: {} }; } catch { return { version: '1.0', agents: {} }; } }

/** 実行結果を永続集計し、再起動後も成功率・速度・品質・Circuit状態を引き継ぎます。 */
export function recordAgentPerformance(input: { agent: string; task: string; success: boolean; latencyMs: number; output: string; error?: string }): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const store = readAgentPerformance(); const old = store.agents[input.agent];
    const attempts = (old?.attempts || 0) + 1; const successes = (old?.successes || 0) + Number(input.success);
    const quality = input.success ? Math.min(1, Math.max(0.2, input.output.trim().length / 400)) : 0;
    const tokens = Math.ceil(Buffer.byteLength(input.output, 'utf8') / 4); const taskOld = old?.byTask[input.task]; const taskAttempts = (taskOld?.attempts || 0) + 1;
    const consecutiveFailures = input.success ? 0 : (old?.consecutiveFailures || 0) + 1;
    const taskConsecutiveFailures = input.success ? 0 : (taskOld?.consecutiveFailures || 0) + 1;
    const taskState = { attempts: taskAttempts, successes: (taskOld?.successes || 0) + Number(input.success), averageLatencyMs: ewma(taskOld?.averageLatencyMs, input.latencyMs), consecutiveFailures: taskConsecutiveFailures,
      ...(input.success ? {} : { openUntil: new Date(Date.now() + loadAgentSelectionConfig().cooldownMs).toISOString(), lastError: input.error || input.output.slice(0, 500) }) };
    store.agents[input.agent] = { attempts, successes, consecutiveFailures,
      averageLatencyMs: ewma(old?.averageLatencyMs, input.latencyMs), averageQuality: ewma(old?.averageQuality, quality),
      estimatedTokens: (old?.estimatedTokens || 0) + tokens, estimatedCostUsd: (old?.estimatedCostUsd || 0) + tokens / 1_000_000 * (loadAgentSelectionConfig().costPerMillionTokens[input.agent] || 0),
      byTask: { ...(old?.byTask || {}), [input.task]: taskState },
      updatedAt: new Date().toISOString() };
    const target = performancePath(); await mkdir(path.dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8'); await renameWithRetry(temporary, target);
  }); return writeQueue;
}
function ewma(previous: number | undefined, current: number): number { return previous === undefined ? current : previous * 0.7 + current * 0.3; }

/** Windows引数長の修復後、ローカル起動失敗だけの待機を解除します。実績と他の障害は保持します。 */
export async function clearGroupArgumentFailureCooldowns(): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const store = readAgentPerformance(); let changed = false;
    for (const metric of Object.values(store.agents)) for (const [task, state] of Object.entries(metric.byTask)) {
      if (task.startsWith('group:') && state.openUntil && state.lastError?.startsWith('ENAMETOOLONG:')) {
        delete state.openUntil; changed = true;
      }
    }
    if (!changed) return;
    const target = performancePath(), temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 }); await renameWithRetry(temporary, target);
  });
  return writeQueue;
}

/** 安全条件合格後の候補を、成功率・タスク実績・品質・実応答速度の順で性能採点します。 */
export function performanceScore(agent: string, task: string, now = Date.now()): number {
  const metric = readAgentPerformance().agents[agent]; if (!metric) return 0;
  const taskMetric = metric.byTask[task]; const successRate = (taskMetric?.successes ?? metric.successes) / Math.max(1, taskMetric?.attempts ?? metric.attempts);
  // 失敗した役割だけを隔離し、Tester障害でBuilderやReviewerまで候補外になることを防ぎます。
  if (taskMetric?.openUntil && Date.parse(taskMetric.openUntil) > now) return Number.NEGATIVE_INFINITY;
  // 旧形式の全体Circuitは役割横断停止を起こすため採点には使用せず、次回保存時にTask別形式へ移行します。
  const latency = taskMetric?.averageLatencyMs ?? metric.averageLatencyMs;
  const averageCost = metric.estimatedCostUsd / Math.max(1, metric.attempts);
  return successRate * 100_000 + metric.averageQuality * 10_000 - Math.min(latency, 120_000) - averageCost * 10_000 - (taskMetric?.consecutiveFailures ?? 0) * 20_000;
}

/** バックグラウンド再確認の成功時にCircuitを閉じ、自動選択へ復帰させます。 */
export async function markAgentRecovered(agent: string): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const store = readAgentPerformance(); const metric = store.agents[agent]; if (!metric) return;
    delete metric.openUntil; metric.consecutiveFailures = 0; delete metric.lastError;
    // 接続の生存確認は制作・検証能力の証明ではないため、役割ごとの失敗隔離は解除しません。
    metric.updatedAt = new Date().toISOString();
    const target = performancePath(); await mkdir(path.dirname(target), { recursive: true }); const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8'); await renameWithRetry(temporary, target);
  });
  await writeQueue;
}
