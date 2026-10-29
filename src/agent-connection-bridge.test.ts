import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maintenancePythonCommand } from './maintenance-python.js';

test('接続ブリッジは退避・復元し、並行変更と有料モデルを拒否する', async () => {
  // 実ユーザーの設定に触れず、一時ホーム（Temporary Home）で更新と復元を検証します。
  const home = await mkdtemp(path.join(os.tmpdir(), 'wentian-bridge-'));
  const target = path.join(home, '.config/opencode/opencode.jsonc');
  const original = '{"model":"before","secret":"保持する値"}';
  const args = ['scripts/maintain-agent-connection.py', '--agent', 'opencode', '--mode', 'free', '--model', 'opencode/example-free', '--home', home, '--report-root', path.join(home, 'backups')];
  // 文字列エンコーディングの戻り値（stdout: string）を固定し、呼出しごとの型揺れを避けます。
  const run = promisify(execFile) as unknown as (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }>;
  // Windowsの実行エイリアス（Execution Alias）を避け、導入済みPythonでブリッジを起動します。
  const python = maintenancePythonCommand();
  const pythonRun = (extra: string[], options?: { env?: NodeJS.ProcessEnv }) => run(python.executable, [...python.args, ...extra], options);
  const environment = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  try {
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, original);
    const planned = JSON.parse((await pythonRun(args, { env: environment })).stdout);
    assert.equal(planned.changedFiles.length, 1); assert.equal(await readFile(target, 'utf8'), original);
    const applied = JSON.parse((await pythonRun([...args, '--apply'], { env: environment })).stdout);
    assert.equal(JSON.parse(await readFile(target, 'utf8')).model, 'opencode/example-free');
    // CLIが整形だけを書き換えても指紋と復元判断が変わらないことを確認します。
    await writeFile(target, JSON.stringify(JSON.parse(await readFile(target, 'utf8'))));
    const reformatted = JSON.parse((await pythonRun(args, { env: environment })).stdout);
    assert.equal(reformatted.fingerprint, applied.fingerprint);
    await pythonRun([...args, '--rollback', applied.backup]);
    assert.equal(await readFile(target, 'utf8'), original);
    const independent = JSON.parse((await pythonRun([...args, '--apply'], { env: environment })).stdout);
    const independentValue = JSON.parse(await readFile(target, 'utf8')); independentValue.cliMetadata = '無関係な更新';
    await writeFile(target, JSON.stringify(independentValue));
    await pythonRun([...args, '--rollback', independent.backup]);
    const restored = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(restored.model, 'before'); assert.equal(restored.cliMetadata, '無関係な更新');
    const changed = JSON.parse((await pythonRun([...args, '--apply'], { env: environment })).stdout);
    await writeFile(target, '{"model":"同時変更"}');
    await assert.rejects(pythonRun([...args, '--rollback', changed.backup]));
    assert.equal(JSON.parse(await readFile(target, 'utf8')).model, '同時変更');
    await assert.rejects(pythonRun(args.map(value => value === 'opencode/example-free' ? 'opencode/paid' : value)));
  } finally { await rm(home, { recursive: true, force: true }); }
});
