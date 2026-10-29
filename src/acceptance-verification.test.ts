import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAcceptancePlan, verifyAcceptance, type AcceptancePlan } from './acceptance-verification.js';
import { terminateProcessTree } from './external-orchestrator.js';
import type { ArtifactSnapshot } from './artifact-evidence.js';

/** 自作の一時ファイルとNode.js子プロセスだけで、検証器そのものの失敗経路を確認します。 */
async function fixture(run: (root: string, plan: AcceptancePlan, baseline: ArtifactSnapshot) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-acceptance-'));
  try {
    await writeFile(path.join(root, 'criteria.txt'), '受入条件');
    const baseline = { capturedAt: new Date().toISOString(), complete: true, issues: [], files: { 'criteria.txt': createHash('sha256').update('受入条件').digest('hex') } };
    const plan: AcceptancePlan = { version: 1, protectedFiles: ['criteria.txt'], commands: [{ id: 'check', criterion: '出力と終了コードの記録', executable: process.execPath, args: ['-e', 'console.log("検証成功")'], timeoutMs: 5000 }] };
    await run(root, plan, baseline);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('実プロセスの終了コードと日本語ログを記録する', async () => fixture(async (root, plan, baseline) => {
  const result = await verifyAcceptance(root, plan, baseline, { terminate: terminateProcessTree });
  assert.equal(result.status, 'passed');
  assert.equal(result.commands[0].exitCode, 0);
  assert.match(result.commands[0].stdout, /検証成功/);
  assert.equal(result.commands[0].cwd, root);
}));

test('非ゼロ終了では失敗とし、後続コマンドを実行しない', async () => fixture(async (root, plan, baseline) => {
  plan.commands[0].args = ['-e', 'console.error("不一致");process.exit(3)'];
  plan.commands.push({ ...plan.commands[0], id: 'second' });
  const result = await verifyAcceptance(root, plan, baseline, { terminate: terminateProcessTree });
  assert.equal(result.status, 'failed');
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].exitCode, 3);
  assert.match(result.commands[0].stderr, /不一致/);
}));

test('保護した検証用ファイルの改変は実行前に拒否する', async () => fixture(async (root, plan, baseline) => {
  await writeFile(path.join(root, 'criteria.txt'), '都合のよい条件');
  const result = await verifyAcceptance(root, plan, baseline, { terminate: terminateProcessTree });
  assert.equal(result.status, 'blocked');
  assert.equal(result.commands.length, 0);
  assert.match(result.note, /変更されました/);
}));

test('時間超過した実プロセスを停止し、合格にしない', async () => fixture(async (root, plan, baseline) => {
  plan.commands[0].args = ['-e', 'setInterval(()=>{},1000)'];
  plan.commands[0].timeoutMs = 100;
  const result = await verifyAcceptance(root, plan, baseline, { terminate: terminateProcessTree });
  assert.equal(result.status, 'failed');
  assert.equal(result.commands[0].reason, '時間超過');
}));

test('未設定と中断済みを合格にしない', async () => fixture(async (root, plan, baseline) => {
  assert.equal((await verifyAcceptance(root, undefined, baseline, { terminate: terminateProcessTree })).status, 'not_configured');
  const signal = AbortSignal.abort();
  const result = await verifyAcceptance(root, plan, baseline, { signal, terminate: terminateProcessTree });
  assert.equal(result.status, 'blocked');
  assert.equal(result.commands.length, 0);
}));

test('設定を読み取った後の書換えは実行計画に反映しない', async () => fixture(async (root, plan) => {
  await mkdir(path.join(root, '.wentian'));
  const file = path.join(root, '.wentian', 'acceptance.json');
  await writeFile(file, JSON.stringify(plan));
  const loaded = await loadAcceptancePlan(root);
  await writeFile(file, '{}');
  assert.deepEqual(loaded, plan);
  await assert.rejects(loadAcceptancePlan(root), /形式が不正/);
  plan.commands[0].executable = 'relative.exe';
  await writeFile(file, JSON.stringify(plan));
  await assert.rejects(loadAcceptancePlan(root), /形式が不正/);
}));
