/** 固定評価（Benchmark）は既知の答えをホスト側で照合し、モデルの自己採点を使いません。 */
import { ExecutionBudget, parseExecutionLimits } from './execution-budget.js';

export interface BenchmarkResult { model: string; task: string; accepted: boolean; latencyMs: number; requestId?: string; error?: string }
export async function runModelBenchmark(model: string, call: (body: Record<string, unknown>) => Promise<Record<string, any>>,
  onResult?: (result: BenchmarkResult) => Promise<void>): Promise<BenchmarkResult[]> {
  const cases = [
    { task: 'general', prompt: 'Return JSON with the field answer equal to WENTIAN_BENCH_OK.', answer: 'WENTIAN_BENCH_OK' },
    { task: 'reasoning', prompt: 'Compute 17 * 19. Return JSON with answer as a decimal string.', answer: '323' },
    { task: 'coding', prompt: 'Evaluate this Python expression without using tools: sum(x*x for x in range(4)). Return JSON with answer as a decimal string.', answer: '14' },
  ];
  const budget = new ExecutionBudget(parseExecutionLimits({ maxRuntimeMs: 120000, maxTokens: 8192 }));
  const results: BenchmarkResult[] = [];
  for (const item of cases) {
    const started = performance.now();
    const result: BenchmarkResult = { model, task: item.task, accepted: false, latencyMs: 0 };
    try {
      budget.reserve(Buffer.byteLength(item.prompt, 'utf8') + 256, 64);
      const response = await call({ model, messages: [{ role: 'user', content: item.prompt }], max_tokens: 64, stream: false,
        response_format: { type: 'json_object' }, wentian_task: item.task, wentian_adaptive: false, wentian_budget: { maxRuntimeMs: budget.remainingMs(), maxAttempts: 1 } });
      result.requestId = response.wentian?.request_id;
      const answer = JSON.parse(response.choices?.[0]?.message?.content ?? 'null');
      result.accepted = answer?.answer === item.answer;
    } catch (error) { result.error = String(error); }
    result.latencyMs = performance.now() - started;
    results.push(result);
    await onResult?.(result);
  }
  return results;
}
