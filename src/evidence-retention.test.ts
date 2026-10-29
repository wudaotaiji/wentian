import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { maintenancePythonCommand } from './maintenance-python.js';

const execute = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windowsの実行エイリアス（Execution Alias）を避け、導入済みPythonで検証スクリプトを起動します。
const python = maintenancePythonCommand();

test('実検証スクリプトが一時領域の削除後も原台帳・ログ・検証資料を保持する', { timeout: 30_000 }, async () => {
  // 実LLMを使わず、Wentian自身の読取り・書込み・ホスト検証・保存まで通します。
  const app = Fastify({ logger: false });
  let calls = 0;
  app.post('/v1/chat/completions', async request => {
    if (request.headers['x-wentian-decision-kind'] === 'task-plan') return { choices: [{ message: { content: JSON.stringify({ intent: 'local_tool', operation: 'write', required_capabilities: ['file_write'], tools: ['write_file'], delegation: { enabled: false } }) } }] };
    calls++;
    const data = { target: { endpoint: 'http://127.0.0.1:1234/v1', model: 'local-model', enabled: false, note: '既存値を維持' }, custom: { endpoint: 'http://localhost:11434/v1', model: 'custom-model', enabled: false } };
    return { choices: [{ message: calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.json', content: JSON.stringify(data) }) } }] }
      : { role: 'assistant', content: '変更しました。' } }] };
  });
  const reportRoot = path.join(project, '.wentian/evaluation-validation');
  const before = new Set(await readdir(reportRoot).catch(() => []));
  let report: string | undefined;
  let fixture: string | undefined;
  let stage: string | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    await execute(python.executable, [...python.args, path.join(project, 'scripts/verify-wentian-small-task.py'), '--repeat', '1', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--model', 'fixture/model'], { cwd: project, timeout: 25_000, maxBuffer: 1024 * 1024 });
    const names = (await readdir(reportRoot)).filter(name => !before.has(name));
    assert.equal(names.length, 1);
    report = path.join(reportRoot, names[0]);
    const result = JSON.parse(await readFile(path.join(report, 'summary.json'), 'utf8')).results[0];
    assert.equal(result.passed, true);
    assert.equal(result.evidence.complete, true);
    fixture = result.fixture;
    const original = await readFile(result.outcome.manifestPath, 'utf8');
    stage = JSON.parse(original).result.workspace.directory;
    assert.equal(await readFile(result.evidence.manifestPath, 'utf8'), original);
    // 削除対象は今回の試験が作った一時ディレクトリーだけです。
    await rm(path.dirname(fixture!), { recursive: true, force: true });
    await rm(stage!, { recursive: true, force: true });
    const index = JSON.parse(await readFile(result.evidence.index, 'utf8'));
    for (const [name, entry] of Object.entries(index.files) as [string, { sha256: string }][]) {
      const bytes = await readFile(path.join(result.evidence.directory, name));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    }
    const manifest = JSON.parse(await readFile(result.evidence.manifestPath, 'utf8'));
    assert.equal(manifest.result.acceptance.status, 'passed');
    assert.equal(manifest.result.publication.status, 'published');
    assert.ok(index.files['cli.log']);
    assert.ok(index.files['baseline.json']);
  } finally {
    await app.close();
    if (fixture) await rm(path.dirname(fixture), { recursive: true, force: true });
    if (stage) await rm(stage, { recursive: true, force: true });
    if (report) await rm(report, { recursive: true, force: true });
  }
});
