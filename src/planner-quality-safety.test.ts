import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentPlan } from './agent-planner.js';

const writeProposal = JSON.stringify({ intent: 'delegate_external', operation: 'write', evidence_source: 'workspace',
  required_capabilities: ['file_read', 'file_write'], tools: ['read_file', 'write_file'],
  delegation: { enabled: true, parallel: false, requested_agents: ['kilo'] } });

test('学習モデルが変更禁止の依頼をwriteと誤分類しても、既存分類で再判定する', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (_url, options) => {
    requests++;
    const body = JSON.parse(String(options?.body));
    assert.equal(body.messages.at(-1).content, 'Kiloに修正せずソースの問題点を指摘してもらって');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ intent: 'delegate_external', operation: 'read',
      required_capabilities: ['review'], tools: [], delegation: { enabled: true, requested_agents: ['kilo'] } }) } }] });
  }) as typeof fetch;
  try {
    // 全体への書き込み許可があっても、学習モデルだけで今回の変更指示とは認定しません。
    const plan = await createAgentPlan('Kiloに修正せずソースの問題点を指摘してもらって', 'http://classification.invalid', undefined,
      { allowedWritePaths: ['.'] }, { inferTrained: async () => writeProposal });
    assert.equal(requests, 1);
    assert.equal(plan.operation, 'read');
    assert.equal(plan.classification?.source, 'gateway');
    assert.ok(!plan.tools.includes('write_file'));
  } finally { globalThis.fetch = originalFetch; }
});

test('書き込みの再判定経路が失敗した場合、学習モデルの提案を採用せず停止する', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ error: { message: '試験用認証拒否' } }, { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(createAgentPlan('設定を変更して', 'http://classification.invalid', undefined, { allowedWritePaths: ['.'] },
      { inferTrained: async () => writeProposal, classify: async () => { throw new Error('外部分類を実行してはいけません。'); } }), /HTTP 401/);
  } finally { globalThis.fetch = originalFetch; }
});

test('読み取りの学習結果は追加の分類要求なしで利用する', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('読み取りの追加分類は不要です。'); }) as typeof fetch;
  try {
    const plan = await createAgentPlan('README.mdを調べて', 'http://classification.invalid', undefined, {},
      { inferTrained: async () => JSON.stringify({ intent: 'local_tool', operation: 'read', evidence_source: 'workspace',
        required_capabilities: ['file_read'], tools: ['read_file'] }) });
    assert.equal(plan.classification?.source, 'trained');
    assert.equal(plan.operation, 'read');
  } finally { globalThis.fetch = originalFetch; }
});
