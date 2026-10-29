import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearGroupArgumentFailureCooldowns, markAgentRecovered, performanceScore, readAgentPerformance, recordAgentPerformance } from './agent-performance.js';

test('引数長の修復は該当する群の待機だけを解除し、成功実績や他の障害を書き換えない', async () => {
  const previous = process.env.WENTIAN_AGENT_PERFORMANCE_FILE, directory = await mkdtemp(path.join(tmpdir(), 'wentian-argument-recovery-'));
  process.env.WENTIAN_AGENT_PERFORMANCE_FILE = path.join(directory, 'performance.json');
  try {
    for (const [task, error] of [['group:coding', 'ENAMETOOLONG: name too long'], ['coding', 'ENAMETOOLONG: name too long'], ['group:text', 'Timeout']]) await recordAgentPerformance({ agent: 'test', task, error, success: false, latencyMs: 0, output: '' });
    await clearGroupArgumentFailureCooldowns();
    const metric = readAgentPerformance().agents.test;
    assert.equal(metric.successes, 0); assert.equal(metric.attempts, 3);
    assert.equal(metric.byTask['group:coding'].openUntil, undefined);
    assert.ok(metric.byTask.coding.openUntil); assert.ok(metric.byTask['group:text'].openUntil);
  } finally {
    if (previous === undefined) delete process.env.WENTIAN_AGENT_PERFORMANCE_FILE; else process.env.WENTIAN_AGENT_PERFORMANCE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Agent実績を永続化し成功率と速度を性能評価へ反映する', async () => {
  const previous = process.env.WENTIAN_AGENT_PERFORMANCE_FILE;
  const directory = await mkdtemp(path.join(tmpdir(), 'wentian-performance-'));
  process.env.WENTIAN_AGENT_PERFORMANCE_FILE = path.join(directory, 'performance.json');
  try {
    await recordAgentPerformance({ agent: 'fast', task: 'review', success: true, latencyMs: 500, output: '十分な品質の回答です。'.repeat(30) });
    await recordAgentPerformance({ agent: 'slow', task: 'review', success: true, latencyMs: 5_000, output: '十分な品質の回答です。'.repeat(30) });
    assert.ok(performanceScore('fast', 'review') > performanceScore('slow', 'review'));
    assert.equal(readAgentPerformance().agents.fast.successes, 1);
  } finally {
    if (previous === undefined) delete process.env.WENTIAN_AGENT_PERFORMANCE_FILE; else process.env.WENTIAN_AGENT_PERFORMANCE_FILE = previous;
  }
});

test('失敗AgentはCooldown中の性能候補から除外される', async () => {
  const previous = process.env.WENTIAN_AGENT_PERFORMANCE_FILE;
  const directory = await mkdtemp(path.join(tmpdir(), 'wentian-circuit-'));
  process.env.WENTIAN_AGENT_PERFORMANCE_FILE = path.join(directory, 'performance.json');
  try {
    await recordAgentPerformance({ agent: 'failed', task: 'review', success: false, latencyMs: 1_000, output: '', error: 'Timeout' });
    assert.equal(performanceScore('failed', 'review'), Number.NEGATIVE_INFINITY);
    await markAgentRecovered('failed');
    assert.equal(performanceScore('failed', 'review'), Number.NEGATIVE_INFINITY);
    assert.notEqual(performanceScore('failed', 'coding'), Number.NEGATIVE_INFINITY);
  } finally {
    if (previous === undefined) delete process.env.WENTIAN_AGENT_PERFORMANCE_FILE; else process.env.WENTIAN_AGENT_PERFORMANCE_FILE = previous;
  }
});
