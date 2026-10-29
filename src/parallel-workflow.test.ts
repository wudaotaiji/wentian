import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowStore, createWorkflow, runWorkflow, retryWorkflow, validateWorkflowPlan, type WorkflowNode } from './parallel-workflow.js';

const node = (id: string): WorkflowNode => ({ id, dependencies: [], allowedWritePaths: [`${id}.txt`], inputs: ['input.txt'], acceptance: '結果をホストで検査', sideEffect: false });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-parallel-test-'));
  const workspace = path.join(root, 'source');
  const { mkdir } = await import('node:fs/promises'); await mkdir(workspace);
  await writeFile(path.join(workspace, 'input.txt'), '固定入力');
  return { workspace, store: new WorkflowStore(path.join(root, 'state')) };
}
test('循環・欠落依存・重複書込みを実行前に拒否する', () => {
  assert.throws(() => validateWorkflowPlan([{ ...node('a'), dependencies: ['missing'] }]), /依存/);
  assert.throws(() => validateWorkflowPlan([{ ...node('a'), dependencies: ['b'] }, { ...node('b'), dependencies: ['a'] }]), /循環/);
  assert.throws(() => validateWorkflowPlan([node('a'), { ...node('b'), allowedWritePaths: ['a.txt'] }]), /重な/);
});
test('2件の実ファイル変更を並列で統合し、全体検証後に原本へ反映する', async () => {
  const { store, workspace } = await fixture(); const plan = await createWorkflow(store, [node('a'), node('b')]);
  let active = 0, peak = 0;
  // 固定30msの重なり判定は全体試験のI/O負荷で揺れるため、2工程が実際に入るまで待つ。
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const result = await runWorkflow(store, plan.id, { workspace, executeNode: async c => {
    active++; peak = Math.max(peak, active); if (active === 2) release();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('2工程が並列実行へ到達しませんでした。')), 20000);
      barrier.then(() => { clearTimeout(timer); resolve(); }, reject);
    });
    await writeFile(path.join(c.directory, `${c.node.id}.txt`), `成果${c.node.id}`); active--;
  }, verifyIntegration: async c => { for (const id of ['a', 'b']) assert.equal(await readFile(path.join(c.directory, `${id}.txt`), 'utf8'), `成果${id}`); } });
  assert.equal(result.status, 'completed', JSON.stringify(result.history)); assert.equal(peak, 2);
  assert.equal(await readFile(path.join(workspace, 'a.txt'), 'utf8'), '成果a');
  assert.equal(await readFile(path.join(workspace, 'b.txt'), 'utf8'), '成果b');
});
test('3件中失敗した1件だけを再実行し、成功2件は再利用する', async () => {
  const { store, workspace } = await fixture(); const plan = await createWorkflow(store, [node('a'), node('b'), node('c')]);
  const counts: Record<string, number> = {};
  const executeNode = async (c: { node: WorkflowNode; directory: string }) => {
    counts[c.node.id] = (counts[c.node.id] || 0) + 1;
    if (c.node.id === 'b' && counts.b === 1) throw new Error('試験用の一時失敗');
    await writeFile(path.join(c.directory, `${c.node.id}.txt`), `成果${c.node.id}`);
  };
  const verifyIntegration = async (c: { directory: string }) => { for (const id of ['a', 'b', 'c']) assert.equal(await readFile(path.join(c.directory, `${id}.txt`), 'utf8'), `成果${id}`); };
  assert.equal((await runWorkflow(store, plan.id, { workspace, executeNode, verifyIntegration })).status, 'failed');
  const result = await retryWorkflow(store, plan.id, { workspace, executeNode, verifyIntegration });
  assert.equal(result.status, 'completed', JSON.stringify(result.history)); assert.deepEqual(counts, { a: 1, b: 2, c: 1 });
});
test('検証未設定・統合検証失敗・実行中の原本変更は反映しない', async () => {
  for (const kind of ['missing', 'failed', 'conflict']) {
    const { store, workspace } = await fixture(); await writeFile(path.join(workspace, 'a.txt'), '原本');
    const plan = await createWorkflow(store, [node('a')]);
    const result = await runWorkflow(store, plan.id, { workspace, executeNode: async c => {
      await writeFile(path.join(c.directory, 'a.txt'), '提案');
      if (kind === 'conflict') await writeFile(path.join(workspace, 'a.txt'), '人間の更新');
    }, ...(kind === 'missing' ? {} : { verifyIntegration: async () => { if (kind === 'failed') throw new Error('試験不合格'); } }) });
    assert.notEqual(result.status, 'completed'); assert.equal(await readFile(path.join(workspace, 'a.txt'), 'utf8'), kind === 'conflict' ? '人間の更新' : '原本');
  }
});
