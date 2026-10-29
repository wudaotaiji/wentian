import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { TaskOutcome } from './task-outcome.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

test('実CLIの結果・終了コード・書込み境界・直接実装の受入を検証する', { timeout: 120_000 }, async t => {
  for (const scenario of ['success', 'scope_denied', 'command_denied', 'needs_review', 'acceptance_failed', 'timeout', 'delegate_denied', 'proposal', 'no_redelegation', 'planner_failed', 'no_changes', 'implicit_scope_auto', 'implicit_scope_direct', 'upstream_429', 'upstream_429_recovers']) {
    await t.test(scenario, async () => {
      // 導入済み外部CLIや実LLMを呼ばず、HTTP応答だけを置換して実Wentian CLIを起動します。
      const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-contract-'));
      await writeFile(path.join(root, 'approved.txt'), 'old'); await writeFile(path.join(root, 'outside.txt'), 'keep');
      await writeFile(path.join(root, 'protected.txt'), '受入検証の保護ファイル');
      if (scenario !== 'needs_review') {
        await mkdir(path.join(root, '.wentian'));
        const code = scenario === 'timeout' ? 'setTimeout(()=>{},60000)' : scenario === 'acceptance_failed' ? 'process.exit(1)' : "if(require('fs').readFileSync('approved.txt','utf8')!=='new')process.exit(1)";
        await writeFile(path.join(root, '.wentian/acceptance.json'), JSON.stringify({ version: 1, protectedFiles: ['protected.txt'], commands: [{ id: 'content', criterion: '内容がnew', executable: process.execPath, args: ['-e', code], timeoutMs: scenario === 'timeout' ? 100 : 5000 }] }));
      }
      const app = Fastify({ logger: false }); let calls = 0; let writes = 0; let limitSent = false;
      app.post('/v1/chat/completions', async (req, reply) => {
        const body = req.body as any;
        if (req.headers['x-wentian-decision-kind']) {
          const plan = { intent: 'local_tool', operation: 'write', execution_mode: scenario === 'no_redelegation' ? 'direct' : 'auto', text: body.messages.at(-1).content, required_capabilities: ['file_write'], tools: ['write_file', 'run_command'], delegation: { enabled: true } };
          return { choices: [{ message: { content: scenario === 'planner_failed' ? '構造化計画を生成できませんでした。' : JSON.stringify(req.headers['x-wentian-decision-kind'] === 'conversation-turn' ? { kind: 'task', plan } : plan) } }] };
        }
        // 上流の利用制限（HTTP 429）を再現します。復旧シナリオは1回目だけ制限を返し、`calls` を進めずに待機後の再試行で同じ作業を通します。
        if (scenario === 'upstream_429' || (scenario === 'upstream_429_recovers' && !limitSent)) {
          limitSent = true;
          return reply.code(503).send({ error: { message: '上流の利用制限', details: { upstream: { status: 429, provider: 'fixture', retryAfter: scenario === 'upstream_429' ? '60' : '3' } } } });
        }
        calls++;
        if (scenario === 'no_changes') return { choices: [{ message: { role: 'assistant', content: '実装しました。' } }] };
        if (scenario === 'proposal') {
          assert.ok(!body.tools?.some((tool: any) => tool.function.name === 'write_file')); return { choices: [{ message: { role: 'assistant', content: '修正案だけを説明します。' } }] };
        }
        if (calls === 1) {
          writes++;
          const name = scenario === 'command_denied' ? 'run_command' : 'write_file';
          const args = name === 'run_command' ? { command: "python -c \"open('outside.txt','w').write('bad')\"" } : { path: scenario === 'scope_denied' ? 'outside.txt' : 'approved.txt', content: 'new' };
          return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'write', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] };
        }
        return { choices: [{ message: { role: 'assistant', content: '実装しました。' } }] };
      });
      try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const mode = scenario === 'implicit_scope_auto' ? 'auto' : scenario === 'delegate_denied' ? 'delegate' : scenario === 'proposal' ? 'propose' : 'direct';
        const prompt = scenario === 'no_redelegation' ? '再委譲は禁止です。自分でapproved.txtを実装してください。\n編集対象: approved.txt' : 'approved.txtにnewを書いて実装してください。';
        const args = [path.join(project, 'bin/wentian.js'), 'agent', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--model', 'test/model', '--json', ...(scenario === 'no_redelegation' ? [] : ['--execution-mode', mode]), ...(scenario === 'planner_failed' || scenario.startsWith('implicit_scope') ? [] : ['--allow-write', 'approved.txt']), ...(scenario === 'upstream_429_recovers' ? ['--wait-on-limit'] : []), '--', prompt];
        let code = 0, stdout = '';
        try { stdout = (await execute(process.execPath, args, { cwd: root, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, WENTIAN_ENV_FILE: path.join(root, 'missing.env'), WENTIAN_API_KEY: '', WENTIAN_ENABLE_EXTERNAL_ORCHESTRATION: 'true' } })).stdout; }
        catch (error) { const failure = error as { code: number; stdout: string }; code = failure.code; stdout = failure.stdout; }
        const outcome = JSON.parse(stdout.trim()) as TaskOutcome;
        const expected = ['success', 'no_redelegation', 'upstream_429_recovers'].includes(scenario) ? 'success' : scenario === 'proposal' ? 'proposal' : scenario === 'needs_review' || scenario.startsWith('implicit_scope') ? 'needs_review' : scenario === 'timeout' ? 'timeout' : 'failed';
        assert.equal(outcome.status, expected, stdout); assert.equal(code, outcome.exitCode);
        assert.equal(code, expected === 'success' || expected === 'proposal' ? 0 : expected === 'needs_review' ? 2 : expected === 'timeout' ? 124 : 1);
        assert.equal(await readFile(path.join(root, 'approved.txt'), 'utf8'), expected === 'success' || scenario === 'needs_review' ? 'new' : 'old');
        if (scenario === 'needs_review') assert.match(outcome.reason || '', /変更は反映済みです/);
        assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'keep');
        if (scenario === 'delegate_denied') { assert.equal(calls, 0); assert.equal(writes, 0); }
        if (scenario === 'planner_failed') assert.equal(calls, 0);
        if (scenario.startsWith('implicit_scope')) { assert.equal(calls, 0); assert.equal(writes, 0); }
        // 既定（待機オフ）は、利用制限を待たずに構造化された失敗として即返します。テスト側が理由もなく止まらないための保証です。
        if (scenario === 'upstream_429') assert.deepEqual(outcome.failure, { gatewayStatus: 503, upstreamStatus: 429, provider: 'fixture', retryAfter: '60' });
        // 待機を明示した場合だけ、制限→待機→再試行→同一作業の続行を通ることを実CLIで確認します。
        if (scenario === 'upstream_429_recovers') assert.ok(limitSent && calls >= 2, '利用制限からの復旧経路（再試行後の書込み）を通過していません。');
        if (scenario === 'proposal') assert.equal(writes, 0);
        if (outcome.manifestPath) {
          const manifest = JSON.parse(await readFile(outcome.manifestPath, 'utf8'));
          assert.equal(manifest.result.outcome.status, outcome.status);
          assert.deepEqual(manifest.task.allowedWritePaths, ['approved.txt']);
          if (scenario === 'scope_denied') assert.equal(await readFile(path.join(manifest.result.workspace.directory, 'outside.txt'), 'utf8'), 'keep');
          if (manifest.result.workspace) await rm(manifest.result.workspace.directory, { recursive: true, force: true });
        }
      } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    });
  }
});
