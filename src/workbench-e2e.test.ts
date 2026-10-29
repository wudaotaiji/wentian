import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { registerWorkbench } from './workbench.js';
import { loadGoal } from './goal-store.js';
import { readDaemonRecord, isPidAlive, stopGoalDaemon } from './goal-daemon.js';

test('工作台から実CLIを起動し、Skill読込・ファイル作成・ホスト検証・完了まで実行する', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-e2e-'));
  const keys = ['WENTIAN_GOAL_PATH', 'WENTIAN_INSTALL_ROOT', 'WENTIAN_ENV_FILE', 'WENTIAN_API_KEY', 'WENTIAN_ENABLE_EXTERNAL_ORCHESTRATION'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  // 実運用と同じGit除外領域に台帳を置き、作業コピーが更新中のdaemon.logを複製しないようにします。
  process.env.WENTIAN_GOAL_PATH = path.join(root, '.wentian', 'goals');
  process.env.WENTIAN_INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.env.WENTIAN_ENV_FILE = path.join(root, 'nonexistent.env');
  process.env.WENTIAN_API_KEY = 'e2e-only';
  process.env.WENTIAN_ENABLE_EXTERNAL_ORCHESTRATION = 'false';
  const app = Fastify(); const calls: string[] = []; let goalId = '';
  app.post('/v1/chat/completions', async req => {
    assert.equal(req.headers.authorization, 'Bearer e2e-only');
    const body = req.body as any;
    let message: Record<string, unknown>;
    if (req.headers['x-wentian-decision-kind']) {
      message = { role: 'assistant', content: JSON.stringify({ intent: 'local_tool', operation: 'write', text: body.messages.at(-1).content, required_capabilities: ['file_write'], tools: ['write_file'], delegation: { enabled: false } }) };
    } else {
      assert.ok(body.tools.some((tool: any) => tool.function.name === 'load_skill'));
      const outputs = body.messages.filter((item: any) => item.role === 'tool');
      if (!outputs.length) { calls.push('skill'); message = { role: 'assistant', content: null, tool_calls: [{ id: 'skill', type: 'function', function: { name: 'load_skill', arguments: '{"name":"verified-delivery"}' } }] }; }
      else if (outputs.length === 1) { calls.push('write'); message = { role: 'assistant', content: null, tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'output.md', content: 'Wentian ready\nVerified sample.' }) } }] }; }
      else message = { role: 'assistant', content: 'DONE: output.md' };
    }
    return { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  });
  registerWorkbench(app, { workspace: root, authorize: () => true, models: async () => [{ id: 'mock/model' }], providerSaved: () => {}, testModel: async () => 'ready' });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const created = await app.inject({ method: 'POST', url: '/api/workbench/goals', payload: { title: 'Create file', description: 'Create output.md with Wentian ready.', acceptance: [{ path: 'output.md', contains: 'Wentian ready' }] } });
    goalId = created.json().id;
    const started = await app.inject({ method: 'POST', url: `/api/workbench/goals/${goalId}/run`, payload: { model: 'mock/model' } });
    assert.equal(started.statusCode, 200, started.body + '\n' + await readFile(path.join(root, '.wentian', 'goals', goalId, 'daemon.log'), 'utf8').catch(() => ''));
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await loadGoal(goalId)).status !== 'completed') await new Promise(resolve => setTimeout(resolve, 100));
    const result = await loadGoal(goalId);
    const log = await app.inject(`/api/workbench/goals/${goalId}/log`);
    assert.equal(result.status, 'completed', log.body);
    assert.equal(result.todos[0].verification?.status, 'passed');
    // 分類15トークンと実作業45トークンの両方を実行予算へ計上します。
    assert.equal(result.todos[0].usage?.total, 60);
    assert.deepEqual(calls, ['skill', 'write']);
    assert.match(await readFile(path.join(root, 'output.md'), 'utf8'), /Wentian ready/);
  } finally {
    if (goalId) { const record = await readDaemonRecord(goalId); if (record && await isPidAlive(record.pid)) await stopGoalDaemon(goalId); }
    await app.close(); for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    // Windowsでは停止直後の子プロセスが一時的にフォルダーを保持するため、解除を短く再試行します。
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
