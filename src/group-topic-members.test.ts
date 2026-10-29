import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { topicMembers } from './group-topic-members.js';
import { registerWorkbench } from './workbench.js';
import { AgentGroupStore } from './agent-group.js';
import { builtinVisualAssets } from './visual-assets.js';

test('AIの文脈判断で医療画像を選び、候補外の画像を拒否する', async () => {
  const choose = (visualAssetId: string | null) => async (_member: unknown, messages: Array<{ content: string }>) => {
    assert.ok(messages.some(m => m.content.includes('medical-professor')));
    return JSON.stringify({ members: [{ name: '研究責任者', role: '免疫蛋白の研究を指導する', visualAssetId, visualReason: '研究指導者の役割に合う医学教授の素材' }] });
  };
  const members = await topicMembers('免疫蛋白の遺伝子再構成', 'mock/model', choose('medical-professor'), builtinVisualAssets);
  assert.equal(members[0].visual?.assetId, 'medical-professor');
  assert.equal(members[0].visual?.url, '/assets/startup-forge/medical-professor.png');
  const unmatched = await topicMembers('別分野', 'mock/model', choose(null), builtinVisualAssets);
  assert.equal(unmatched[0].visual?.assetId, null);
  await assert.rejects(topicMembers('研究', 'mock/model', choose('invented'), builtinVisualAssets), /候補にない/);
});

test('主題をLLMへ渡し、固定辞書にない専門役も採用する', async () => {
  const members = await topicMembers('Web開発とデータ分析・クラウド運用', 'mock/model', async (_member, messages) => {
    assert.equal(messages.at(-1)?.content, 'Web開発とデータ分析・クラウド運用');
    return JSON.stringify({ members: [{ visualAssetId: null, visualReason: '適切な候補なし', name: '複合領域の調整担当', role: '主題全体の依存関係を整理する' }] });
  });
  assert.equal(members[0].name, '複合領域の調整担当');
  assert.equal(new Set(members.map(m => m.name)).size, members.length);
  assert.ok(members.every(m => m.model === 'mock/model'));
  await assert.rejects(topicMembers('旅行計画', 'mock/model', async () => '回答できません'), /有効なJSON/);
  await assert.rejects(topicMembers('旅行計画', 'mock/model', async () => '{"members":[]}'), /メンバー数/);
});

// 実際の作成APIで自動選定と保存を確認し、指定済みの参加者は置き換えないことを検証します。
test('空の参加者指定では自動追加し、明示した参加者とモデルを保持する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-topic-'));
  const app = Fastify();
  registerWorkbench(app, { workspace: root, authorize: () => true, models: async () => [{ id: 'mock/model' }], providerSaved: () => {}, testModel: async () => 'ok', groupRespond: async () => JSON.stringify({ members: [{ visualAssetId: null, visualReason: '適切な候補なし', name: 'テックリード', role: '構成と実装を検討する' }, { visualAssetId: null, visualReason: '適切な候補なし', name: 'データアーキテクト', role: 'データ構造を検討する' }] }) });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/workbench/groups', payload: { title: '開発相談室', names: [], model: 'mock/model' } });
    assert.equal(created.statusCode, 200, created.body);
    const group = created.json();
    assert.ok(group.members.some((m: any) => m.name === 'テックリード'));
    const loaded = await app.inject({ method: 'GET', url: '/api/workbench/groups/' + group.id });
    assert.deepEqual(loaded.json().members, group.members);
    const custom = await app.inject({ method: 'POST', url: '/api/workbench/groups', payload: { title: '開発', names: ['指定担当'], model: 'mock/model' } });
    assert.deepEqual(custom.json().members.map((m: any) => m.name), ['指定担当']);
    assert.equal(custom.json().members[0].model, 'mock/model');
    const store = new AgentGroupStore(root);
    const empty = await store.create('開発環境データ共有・分析基盤構築', []);
    await store.participate(empty.id, { id: 'human', name: '参加者' }, 'join');
    await store.post(empty.id, 'human', '保存する発言');
    const url = '/api/workbench/groups/' + empty.id + '/auto-members';
    const repaired = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(repaired.statusCode, 200, repaired.body);
    assert.ok(repaired.json().members.some((m: any) => m.name === 'データアーキテクト'));
    assert.equal(repaired.json().messages[0].content, '保存する発言');
    const repeated = await app.inject({ method: 'POST', url, payload: {} });
    assert.deepEqual(repeated.json().members, repaired.json().members);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
