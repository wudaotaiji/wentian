import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureArtifactSnapshot, compareArtifactSnapshots } from './artifact-evidence.js';
import { classifyOrchestrationOutcome } from './external-orchestrator.js';

test('実ファイルの追加・変更・削除を検出し、開始前からある内容を成果と誤認しない', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-evidence-'));
  try {
    execFileSync('git', ['init', root], { stdio: 'pipe' });
    await writeFile(path.join(root, 'existing.txt'), '開始前からある変更');
    await writeFile(path.join(root, 'modified.txt'), '以前');
    await writeFile(path.join(root, 'deleted.txt'), '削除対象');
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, 'ignored.txt'), '台帳に含めない');
    const before = await captureArtifactSnapshot(root);
    await writeFile(path.join(root, 'modified.txt'), '変更後');
    await writeFile(path.join(root, 'added.txt'), '新規');
    await rm(path.join(root, 'deleted.txt'));
    const after = await captureArtifactSnapshot(root);
    const evidence = compareArtifactSnapshots(before, after);
    assert.equal(before.complete, true);
    assert.equal(after.complete, true);
    assert.deepEqual(evidence.changes.map(change => [change.path, change.kind]), [
      ['added.txt', 'added'], ['deleted.txt', 'deleted'], ['modified.txt', 'modified'],
    ]);
    assert.equal(evidence.verification, 'needs_review');
    assert.equal('ignored.txt' in before.files, false);
    assert.equal(JSON.stringify(evidence).includes('開始前からある変更'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Git管理外の読取り失敗を変更なし・検証済みとして扱わない', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-evidence-'));
  try {
    const snapshot = await captureArtifactSnapshot(root);
    assert.equal(snapshot.complete, true);
    assert.equal(compareArtifactSnapshots(snapshot, snapshot).verification, 'needs_review');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('全担当が成功を報告しても制作物の検収を省略しない', () => {
  const reports = (['builder', 'tester', 'verifier'] as const).map(role => ({ role, agent: role, success: true, output: '成功しました' }));
  assert.equal(classifyOrchestrationOutcome(true, reports), 'needs_review');
  assert.equal(classifyOrchestrationOutcome(true, [{ ...reports[0], success: false }]), 'failed');
  assert.equal(classifyOrchestrationOutcome(false, [{ role: 'reviewer', agent: 'reviewer', success: false, output: '' }]), 'failed');
});
