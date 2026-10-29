/** 性能テレメトリー（Performance Telemetry）を既存台帳へ保存し、再起動後に復元します。 */
import { MetricsRegistry, type RequestMetric, type TaskKind } from './manager.js';
import type { JsonlEventStore } from './storage.js';

const tasks = new Set(['general', 'coding', 'reasoning', 'tool', 'vision']);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export async function persistRequestMetric(store: JsonlEventStore, metric: RequestMetric): Promise<void> {
  const detail: Record<string, string | number | boolean | null> = { task: metric.task ?? 'general' };
  for (const key of ['ttftMs', 'promptTokens', 'outputTokens', 'routingMs', 'ramUsedBytes', 'vramUsedBytes', 'costUsd'] as const) {
    if (nonnegative(metric[key])) detail[key] = metric[key]!;
  }
  if (metric.requestId) detail.requestId = metric.requestId;
  await store.append({ kind: 'metric', action: 'runtime_performance', occurredAt: metric.startedAt, provider: metric.provider,
    model: metric.model, success: metric.success, latencyMs: metric.latencyMs, detail });
}

/** 保存期限外、破損データ、負数を取り込まず、過去の互換形式も必要な数値だけ復元します。 */
export async function restoreRuntimeMetrics(store: JsonlEventStore, registry: MetricsRegistry): Promise<number> {
  const events = await store.list({ limit: store.options.maxRecords });
  const items: RequestMetric[] = [];
  for (const event of events) {
    if (event.action !== 'runtime_performance' || !event.model || !event.provider || !nonnegative(event.latencyMs) || typeof event.success !== 'boolean') continue;
    const detail = event.detail ?? {};
    const metric: RequestMetric = { provider: event.provider, model: event.model, startedAt: event.occurredAt,
      latencyMs: event.latencyMs, success: event.success, task: tasks.has(String(detail.task)) ? detail.task as TaskKind : 'general' };
    for (const key of ['ttftMs', 'promptTokens', 'outputTokens', 'routingMs', 'ramUsedBytes', 'vramUsedBytes', 'costUsd'] as const) if (nonnegative(detail[key])) metric[key] = detail[key] as number;
    if (typeof detail.requestId === 'string') metric.requestId = detail.requestId;
    items.push(metric);
  }
  registry.restore(items);
  for (const event of events) if (event.action === 'model_evaluation' && typeof event.detail?.requestId === 'string') {
    registry.evaluate(event.detail.requestId, { accepted: typeof event.detail.accepted === 'boolean' ? event.detail.accepted : undefined,
      verified: typeof event.detail.verified === 'boolean' ? event.detail.verified : undefined });
  }
  return registry.list().length;
}
