import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { listOperations, registerOperationsCenter, summarizeOperation } from './operations-center.js';
import { operationsHtml } from './operations-center.js';
import { Window, HTMLInputElement, HTMLSelectElement, HTMLButtonElement } from 'happy-dom';
import { Script } from 'node:vm';

test('作業状況の集計・検索・状態絞込・詳細・更新失敗表示が公開情報から動作する', async () => {
  const window = new Window({ url: 'http://127.0.0.1:8787/operations' });
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  let failed = false;
  window.fetch = (async (url: any) => {
    if (String(url).endsWith('/me')) return new window.Response(JSON.stringify({ user: { displayName: '検証者' } }));
    if (failed) return new window.Response('{}', { status: 500 });
    return new window.Response(JSON.stringify({ warnings: [], goals: [], operations: [
      { id: 'flow-a', kind: 'workflow', status: 'failed', stage: 'review', agents: ['claude'], models: ['example/model'], reason: '<script>停止</script>', changes: [{ kind: 'modified', path: 'report.md' }], verification: 'failed', nextAction: '再試行' },
      { id: 'run-b', kind: 'execution', status: 'completed', stage: '完了', agents: ['kilo'], models: [], changes: [], verification: 'passed' },
    ] }));
  }) as typeof window.fetch;
  try {
    window.document.write(operationsHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    for (const script of operationsHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) { new Script(script[1]); window.eval(script[1]); }
    await window.happyDOM.waitUntilComplete();
    const doc = window.document;
    assert.equal(doc.querySelectorAll('#summary .card').length, 4);
    assert.equal(doc.querySelectorAll('#tasks tbody tr').length, 2);
    const search = doc.getElementById('search') as HTMLInputElement;
    search.value = 'claude'; search.dispatchEvent(new window.Event('input'));
    assert.equal(doc.querySelectorAll('#tasks tbody tr').length, 1);
    (doc.querySelector('#tasks button') as HTMLButtonElement).click();
    assert.match(doc.getElementById('detail')!.textContent, /report.md/);
    assert.equal(doc.querySelector('#detail script'), null);
    assert.equal(doc.querySelector('#tasks a')!.getAttribute('href'), '/workflows#flow-a');
    const filter = doc.getElementById('filter') as HTMLSelectElement;
    filter.value = 'done'; filter.dispatchEvent(new window.Event('change'));
    assert.match(doc.getElementById('tasks')!.textContent, /一致する作業がありません/);
    failed = true; (doc.getElementById('refresh') as HTMLButtonElement).click();
    await window.happyDOM.waitUntilComplete();
    assert.match(doc.getElementById('notice')!.textContent, /前回取得/);
  } finally { await window.happyDOM.close(); }
});

test('作業状況は台帳の秘密・依頼本文・外部CLIの生出力を返さない', () => {
  const result = summarizeOperation({ task: { taskId: 't1', prompt: '秘密の依頼' }, result: {
    outcome: { status: 'failed', reason: '範囲外のため拒否' }, reports: [{ role: 'builder', output: '秘密の出力', model: 'example/model' }],
    selectedAgents: ['claude'], acceptance: { status: 'failed' }, evidence: { changes: [{ path: 'a.ts', kind: 'modified' }] },
  } });
  assert.equal(result.verification, 'failed'); assert.deepEqual(result.models, ['example/model']);
  assert.ok(!JSON.stringify(result).includes('秘密')); assert.equal(result.changes[0].path, 'a.ts');
});

test('作業状況の画面とAPIは認証が必要で、壊れた台帳を警告する', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'wentian-operations-'));
  await mkdir(path.join(workspace, '.wentian/orchestration/runs/t1'), { recursive: true });
  await writeFile(path.join(workspace, '.wentian/orchestration/runs/t1/manifest.json'), '{invalid');
  assert.equal((await listOperations(workspace)).warnings.length, 1);
  const app = Fastify();
  registerOperationsCenter(app, { workspace, authorize: (_q, r) => { r.code(403).send({ error: '認証が必要' }); return false; } });
  try {
    assert.equal((await app.inject('/api/workbench/operations')).statusCode, 403);
    assert.equal((await app.inject('/operations')).statusCode, 403);
  } finally { await app.close(); }
});
