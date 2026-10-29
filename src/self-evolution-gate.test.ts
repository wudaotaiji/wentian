import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SelfEvolutionGate } from './self-evolution-gate.js';

async function fixture(commands: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-evolution-'));
  await mkdir(path.join(root, '.wentian'), { recursive: true });
  await writeFile(path.join(root, '.wentian', 'evolution.json'), JSON.stringify({ version: 1, maxEvaluationMs: 10_000, commands }), 'utf8');
  return root;
}

test('固定検査とベンチマークが維持された変更を合格にする', async () => {
  const root = await fixture([
    { id: 'check', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 2_000, kind: 'check' },
    { id: 'score', executable: process.execPath, args: ['-e', 'console.log(100)'], timeoutMs: 2_000, kind: 'benchmark', maxRegression: 0 },
  ]);
  try {
    const gate = await SelfEvolutionGate.load(root); const baseline = await gate.captureBaseline(root); const result = await gate.evaluate(root, baseline);
    assert.equal(result.passed, true); assert.match(result.summary, /2件/); assert.match(result.reportPath, /\.json$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ベンチマーク低下を検出して不合格にする', async () => {
  const root = await fixture([{ id: 'score', executable: process.execPath, args: ['-e', "const fs=require('fs');console.log(fs.readFileSync('score.txt','utf8'))"], timeoutMs: 2_000, kind: 'benchmark', maxRegression: 0 }]);
  try {
    await writeFile(path.join(root, 'score.txt'), '100', 'utf8'); const gate = await SelfEvolutionGate.load(root); const baseline = await gate.captureBaseline(root);
    await writeFile(path.join(root, 'score.txt'), '90', 'utf8'); const result = await gate.evaluate(root, baseline);
    assert.equal(result.passed, false); assert.match(result.summary, /100から90へ低下/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('相対実行ファイルや重複IDを設定で拒否する', async () => {
  const root = await fixture([{ id: 'bad', executable: 'node', args: [], timeoutMs: 1_000, kind: 'check' }]);
  try { await assert.rejects(SelfEvolutionGate.load(root), /形式が不正/); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('設定が存在しない場合は品質ゲートを無効として扱う', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-evolution-none-'));
  try { assert.equal(await SelfEvolutionGate.loadIfConfigured(root), undefined); }
  finally { await rm(root, { recursive: true, force: true }); }
});
