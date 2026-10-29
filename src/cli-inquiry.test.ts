import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

test('Plannerがプロジェクト作業報告を分類し、Git状態と作業レポートを読んで回答する', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-work-report-')); const app = Fastify(); let turns = 0;
  await execute('git', ['init', '--quiet'], { cwd: root });
  await mkdir(path.join(root, 'reports'));
  await writeFile(path.join(root, 'reports', 'work-2026-10-13.md'), '# 今日の作業\n\n- Wentian内部LLMの経路を調査\n- 作業報告の参照先を修正');
  app.get('/api/mcp/agent-tools', async () => ({ tools: [] }));
  app.post('/v1/chat/completions', async request => {
    const body = request.body as any;
    if (request.headers['x-wentian-decision-kind'] === 'task-plan') return { choices: [{ message: { content: JSON.stringify({ intent: 'local_tool', operation: 'read', evidence_source: 'workspace', language: 'zh', required_capabilities: ['file_read'], tools: ['inspect_workspace_activity', 'list_files', 'read_file'] }) } }] };
    const step = turns++;
    const names = body.tools.map((tool: any) => tool.function.name);
    for (const name of ['inspect_workspace_activity', 'list_files', 'read_file']) assert.ok(names.includes(name));
    const last = body.messages.at(-1);
    if (step === 0) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'git-activity', type: 'function', function: { name: 'inspect_workspace_activity', arguments: '{}' } }] } }] };
    if (step === 1) {
      assert.equal(last.name, 'inspect_workspace_activity'); assert.match(last.content, /reports/);
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'find-report', type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ query: 'work-2026-10-13.md', depth: 2 }) } }] } }] };
    }
    if (step === 2) {
      assert.equal(last.name, 'list_files');
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'read-report', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: path.join('reports', 'work-2026-10-13.md') }) } }] } }] };
    }
    assert.equal(last.name, 'read_file'); assert.match(last.content, /参照先を修正/);
    return { choices: [{ message: { role: 'assistant', content: '根据工作区证据，今天记录的工作包括调查 Wentian 内部 LLM 调用路径，以及修正作业报告的证据来源。依据是 Git 状态和 2026-10-13 的项目工作报告；这些记录不能证明报告外的工作。' } }] };
  });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const result = await execute(process.execPath, [path.join(project, 'bin/wentian.js'), 'agent', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--execution-mode', 'direct', '--timeout-ms', '10000', '--', '报告一下今天的作业内容，都干了些什么工作啊？'], { cwd: root, timeout: 45000, env: { ...process.env, WENTIAN_API_KEY: '' } });
    assert.equal(turns, 4); assert.match(result.stdout, /修正作业报告的证据来源/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('Plannerが履歴取得を指定した場合、記録を読んでから中国語で回答する', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-history-answer-'));
  const sessions = path.join(root, 'sessions');
  const app = Fastify(); let answerCalls = 0;
  await mkdir(sessions);
  await writeFile(path.join(sessions, 'wt-20261013-010000-1234abcd.json'), JSON.stringify({ version: '1.0', id: 'wt-20261013-010000-1234abcd', workspace: root, model: 'fixture/model', createdAt: '2026-10-13T01:00:00.000Z', updatedAt: '2026-10-13T01:10:00.000Z', messages: [{ role: 'user', content: '检查 Gateway 的健康状态' }, { role: 'assistant', content: '健康检查返回正常。' }] }));
  app.get('/api/mcp/agent-tools', async () => ({ tools: [] }));
  app.post('/v1/chat/completions', async request => {
    const body = request.body as any;
    if (request.headers['x-wentian-decision-kind'] === 'task-plan') return { choices: [{ message: { content: JSON.stringify({ intent: 'local_tool', operation: 'read', language: 'zh', evidence_source: 'runtime', runtime_requirements: [{ tool: 'list_agent_sessions' }], required_capabilities: ['text'], tools: ['list_agent_sessions'] }) } }] };
    answerCalls++;
    if (answerCalls === 1) {
      assert.equal(body.tool_choice, 'required');
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'history', type: 'function', function: { name: 'list_agent_sessions', arguments: '{}' } }] } }] };
    }
    assert.equal(body.messages.at(-1).name, 'list_agent_sessions');
    assert.match(body.messages.at(-1).content, /检查 Gateway 的健康状态/);
    return { choices: [{ message: { role: 'assistant', content: 'Wentian 记录显示：检查了 Gateway 健康状态；记录中的回答称健康检查正常。其他工作的完成情况无法从这些会话确认。' } }] };
  });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const result = await execute(process.execPath, [path.join(project, 'bin/wentian.js'), 'agent', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--execution-mode', 'direct', '--timeout-ms', '10000', '--', '报告一下今天的作业内容'], { cwd: root, timeout: 45000, env: { ...process.env, WENTIAN_API_KEY: '', WENTIAN_SESSION_PATH: sessions } });
    assert.equal(answerCalls, 2);
    assert.match(result.stdout, /其他工作的完成情况无法从这些会话确认/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('textだけに分類されても実CLIが資料探索・読取ツールを実行する', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-text-tools-')); const app = Fastify(); let turns = 0;
  await writeFile(path.join(root, 'README.md'), '例示クラスタは開発用Kubernetes環境です。');
  app.get('/api/mcp/agent-tools', async () => ({ tools: [] }));
  app.post('/v1/chat/completions', async request => {
    const body = request.body as any;
    if (request.headers['x-wentian-decision-kind'] === 'task-plan') return { choices: [{ message: { content: JSON.stringify({ intent: 'chat', operation: 'answer', required_capabilities: ['text'], tools: [] }) } }] };
    assert.equal(body.wentian_requires_tool, true);
    for (const name of ['list_files', 'read_file', 'inspect_kubernetes', 'inspect_workspace_activity']) assert.ok(body.tools.some((tool: any) => tool.function.name === name));
    assert.ok(!body.tools.some((tool: any) => ['write_file', 'run_command'].includes(tool.function.name)));
    if (turns++ < 2) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `read-${turns}`, type: 'function', function: { name: turns === 1 ? 'list_files' : 'read_file', arguments: turns === 1 ? '{}' : '{"path":"README.md"}' } }] } }] };
    if (turns === 3) {
      assert.match(body.messages.at(-1).content, /開発用Kubernetes/);
      // 存在しない設定を指定して接続失敗を検証します。実環境のクラスター（Cluster）には接続しません。
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'inspect', type: 'function', function: { name: 'inspect_kubernetes', arguments: JSON.stringify({ operation: 'top', resource: 'pods', kubeconfig: path.join(root, 'missing-config') }) } }] } }] };
    }
    const evidence = JSON.parse(body.messages.at(-1).content);
    assert.equal(evidence.success, false); assert.equal(evidence.executable, 'kubectl');
    assert.ok(evidence.error); assert.doesNotMatch(evidence.error, /書き込み許可/);
    return { choices: [{ message: { role: 'assistant', content: 'README確認済み。例示クラスタは開発用Kubernetes環境です。実測は設定ファイルがないため失敗しました。' } }] };
  });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const result = await execute(process.execPath, [path.join(project, 'bin/wentian.js'), 'agent', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--execution-mode', 'direct', '--timeout-ms', '10000', '--', '開発環境の各モジュールのリソース利用率を教えて'], { cwd: root, timeout: 45000, env: { ...process.env, WENTIAN_API_KEY: '' } });
    assert.equal(turns, 4); assert.match(result.stdout, /README確認済み/); assert.match(result.stdout, /設定ファイルがない/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('実CLIで利用率照会の回答・空回答の失敗・書込み未許可の理由を表示する', { timeout: 90_000 }, async t => {
  for (const scenario of ['inquiry', 'empty', 'write_denied', 'runtime_missing', 'runtime_wrong_observation']) await t.test(scenario, async () => {
    // 実LLM・外部エージェントを呼ばず、誤分類を返すHTTPサーバー（HTTP Server）で実CLIを検証します。
    const app = Fastify(); let answerCalls = 0;
    const input = scenario === 'write_denied' ? '画面を開発してください' : '開発環境の各モジュールのリソース利用率を教えて';
    app.get('/api/mcp/agent-tools', async () => ({ tools: [] }));
    app.post('/v1/chat/completions', async request => {
      const body = request.body as any;
      if (request.headers['x-wentian-decision-kind'] === 'task-plan') return {
        choices: [{ message: { content: JSON.stringify({ intent: 'local_tool', operation: scenario === 'write_denied' ? 'write' : 'read', evidence_source: scenario.startsWith('runtime_') ? 'runtime' : 'none', runtime_requirements: [{ tool: 'inspect_kubernetes', operation: 'top', resource: 'pods' }], text: 'Windowsの安全な操作を説明してください', required_capabilities: ['text', 'file_read', 'file_write'], tools: ['read_file', 'write_file'], delegation: { enabled: false } }) } }],
      };
      answerCalls++;
      // 分類モデルによる原文の変更と、参照だけの依頼への書込み権限追加を防ぎます。
      if (answerCalls === 1) assert.equal(body.messages.at(-1).content, input);
      else if (scenario === 'runtime_wrong_observation' && answerCalls === 2) { assert.equal(body.messages.at(-1).role, 'tool'); }
      else { assert.match(body.messages.at(-1).content, /現在値の取得がまだありません/); assert.equal(body.tool_choice, 'required'); }
      assert.ok(!body.tools?.some((tool: any) => tool.function.name === 'write_file'));
      if (scenario === 'runtime_wrong_observation' && answerCalls === 1) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'wrong-observation', type: 'function', function: { name: 'inspect_kubernetes', arguments: JSON.stringify({ operation: 'get', resource: 'namespaces', kubeconfig: path.join(os.tmpdir(), 'wentian-missing-config-for-test') }) } }] } }] };
      return { choices: [{ message: { role: 'assistant', content: scenario === 'empty' ? '  ' : '環境の監視データを取得できていないため、利用率は未確認です。' } }] };
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      let stdout = ''; let code = 0;
      try {
        stdout = (await execute(process.execPath, [path.join(project, 'bin/wentian.js'), 'agent', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--execution-mode', 'direct', '--timeout-ms', '10000', '--', input], { cwd: project, timeout: 45000, env: { ...process.env, WENTIAN_API_KEY: '' } })).stdout;
      } catch (error) {
        const failure = error as { code: number; stdout: string }; code = failure.code; stdout = failure.stdout;
      }
      if (scenario === 'inquiry') {
        assert.equal(code, 0); assert.equal(answerCalls, 1);
        assert.match(stdout, /利用率は未確認/); assert.match(stdout, /最終結果: success/);
      } else if (scenario === 'empty') {
        assert.equal(code, 1); assert.match(stdout, /空の回答/); assert.match(stdout, /最終結果: failed/);
      } else if (scenario.startsWith('runtime_')) {
        assert.equal(code, 1); assert.equal(answerCalls, scenario === 'runtime_missing' ? 2 : 3); assert.match(stdout, /必要な観測が未実施/); assert.match(stdout, /最終結果: failed/);
      } else {
        assert.equal(code, 2); assert.equal(answerCalls, 0);
        assert.match(stdout, /書き込み許可範囲が未指定/); assert.match(stdout, /最終結果: needs_review/);
      }
    } finally { await app.close(); }
  });
});

test('対話CLIは回答前の終了理由を表示し、次の入力待ちと会話記録へ残す', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-inquiry-session-'));
  const app = Fastify();
  app.post('/v1/chat/completions', async () => ({ choices: [{ message: { content: '{"intent":"local_tool","operation":"write","tools":["write_file"],"required_capabilities":["file_write"]}' } }] }));
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    // 実際の対話ループを起動し、入力待ちになった時にキーイベントを送ります。
    // 実画面の代替として通常端末経路を検証し、OpenTUI描画試験とは確認範囲を分けます。
    const source = `
      import { stdin, stdout } from 'node:process';
      Object.defineProperty(stdin, 'isTTY', { value: false, writable: true });
      Object.defineProperty(stdout, 'isTTY', { value: false, writable: true });
      stdin.setRawMode = () => stdin;
      process.env.WT_SESSION = '';
      let prompts = 0;
      const write = stdout.write.bind(stdout);
      stdout.write = (chunk, ...args) => {
        const text = String(chunk);
        if (text.includes('Wentian Agentを起動しました')) { stdin.isTTY = true; stdout.isTTY = true; }
        const plain = text.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, '');
        if (/(?:^|[\\r\\n])wentian> (?:[\\r\\n]|$)/.test(plain)) {
          const input = ['/theme green', '画面を開発してください', 'quit'][prompts++] || 'quit';
          setTimeout(() => { stdin.emit('keypress', input, {}); stdin.emit('keypress', '\\r', { name: 'return' }); }, 10);
        }
        return write(chunk, ...args);
      };
      process.argv = ['node', 'cli', 'agent', '--server', ${JSON.stringify(`http://127.0.0.1:${(app.server.address() as any).port}`)}, '--execution-mode', 'direct'];
      await import(${JSON.stringify(new URL('./cli.ts', import.meta.url).href)});
    `;
    let output = '';
    try { output = (await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { timeout: 20000, env: { ...process.env, WENTIAN_SESSION_PATH: root, WENTIAN_API_KEY: '', WENTIAN_TERMINAL_SETTINGS_FILE: path.join(root, 'settings', 'terminal.json') } })).stdout; }
    catch (error) { const failure = error as { code: number; stdout: string; killed?: boolean }; assert.equal(failure.killed, false); assert.equal(failure.code, 2); output = failure.stdout; }
    assert.match(output, /書き込み許可範囲が未指定/);
    assert.match(output, /入力背景: green/); assert.doesNotMatch(output, /wentian> 入力してください/);
    assert.equal(JSON.parse(await readFile(path.join(root, 'settings', 'terminal.json'), 'utf8')).theme, 'green');
    assert.ok(output.lastIndexOf('wentian> ') > output.indexOf('書き込み許可範囲が未指定'));
    const finalBoundary = output.lastIndexOf('─'.repeat(20), output.lastIndexOf('wentian> '));
    assert.ok(finalBoundary > output.indexOf('書き込み許可範囲が未指定'), '結果の後に区切り線を表示します');
    assert.ok(finalBoundary < output.lastIndexOf('wentian> '), '次の入力待ちになる前に区切り線を表示します');
    const files = await readdir(root);
    const session = JSON.parse(await readFile(path.join(root, files.find(name => name.endsWith('.json'))!), 'utf8'));
    assert.equal(session.messages[0].content, '画面を開発してください');
    assert.match(session.messages[1].content, /書き込み許可範囲が未指定/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
