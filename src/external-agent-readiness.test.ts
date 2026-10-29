import assert from 'node:assert/strict';
import test from 'node:test';
import { agentsNeedingRepair, buildReadySnapshot, startExternalAgentReadinessManager } from './external-agent-readiness.js';
import type { ExternalAgentSnapshot, ExternalAgentStatus } from './external-agents.js';
import { withVerifiedWork } from './work-test-fixture.js';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { workIdentity } from './agent-work-policy.js';
import { connectionStorePath, type AgentConnection } from './agent-connection-policy.js';
import { codexImageEvidencePath } from './codex-image-evidence.js';

const agent = (id: string, liveState: ExternalAgentStatus['liveState']): ExternalAgentStatus => ({
  id, name: id, state: liveState === 'healthy' ? 'available' : 'needs_recheck', stateLabel: '', note: '',
  freshWithin24Hours: true, liveState,
});

test('接続済み・実作業未合格のCodexは会話だけ利用し、制作権限へ昇格しない', () => {
 const codex=agent('codex','healthy');codex.state='needs_recheck';
 codex.connection={mode:'native',model:'fixture',status:'verified',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:'fixture',policyHash:'fixture'};
 const source:ExternalAgentSnapshot={source:'試験',cacheFreshWithin24Hours:true,agents:[codex],summary:{available:0,candidate:0,needs_recheck:1,unavailable:0,total:1}};
 assert.deepEqual(buildReadySnapshot(source,300000).pools.text,['codex']);
 for(const category of ['image','reading','coding','testing','verification'] as const)assert.deepEqual(buildReadySnapshot(source,300000).pools[category],[]);
 for(const status of ['pending','failed'] as const){codex.connection.status=status;assert.deepEqual(buildReadySnapshot(source,300000).pools.text,[]);}
 codex.connection.status='verified';codex.connection.expiresAt=new Date(Date.now()-1000).toISOString();assert.deepEqual(buildReadySnapshot(source,300000).pools.text,[]);
 codex.connection.expiresAt=new Date(Date.now()+60000).toISOString();codex.liveState='probe_failed';assert.deepEqual(buildReadySnapshot(source,300000).pools.text,[]);
});

test('自己修復ループはprobe失敗と未導入の負キャッシュを再確認する', () => {
  const agents = [agent('kilo', 'healthy'), agent('opencode', 'probe_failed'), agent('crush', 'not_installed')];
  assert.deepEqual(agentsNeedingRepair(agents).map(value => value.id), ['opencode', 'crush']);
});

test('生存と作業能力の両方が検証済みのAgentだけを作業別Ready Poolへ分類する', () => {
  const agents = [agent('kilo', 'healthy'), agent('goose', 'healthy'), agent('hermes', 'healthy'), agent('cline', 'healthy'), agent('opencode', 'probe_failed')].map(withVerifiedWork);
  const source: ExternalAgentSnapshot = { source: 'test', cacheFreshWithin24Hours: true, agents, summary: { available: 4, candidate: 0, needs_recheck: 1, unavailable: 0, total: 5 } };
  const ready = buildReadySnapshot(source, 300_000, new Date('2026-09-03T00:00:00Z'));
  assert.deepEqual(ready.pools.image, []);
  assert.deepEqual(ready.pools.coding, ['kilo', 'goose', 'hermes']);
  assert.deepEqual(ready.pools.testing, ['kilo', 'goose', 'hermes']);
  assert.deepEqual(ready.pools.verification, ['kilo', 'goose', 'hermes', 'cline']);
  assert.ok(!ready.pools.coding.includes('cline'));
  assert.ok(!ready.pools.testing.includes('cline'));
  assert.ok(!ready.pools.coding.includes('opencode'));
});
test('Codexの画像生成を一律除外せず、同一接続で実画像検収済みの場合にReady Poolへ入れる', () => {
  const connectionFile = connectionStorePath(), imageFile = codexImageEvidencePath();
  const previous = [connectionFile, imageFile].map(f => existsSync(f) ? readFileSync(f) : undefined);
  const c: AgentConnection = { mode: 'native', model: 'test-model', status: 'verified', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: 'test', policyHash: 'test' };
  const source: ExternalAgentSnapshot = { source: 'test', cacheFreshWithin24Hours: true, agents: [agent('codex', 'healthy')], summary: { available: 1, candidate: 0, needs_recheck: 0, unavailable: 0, total: 1 } };
  try {
    writeFileSync(connectionFile, JSON.stringify({ agents: { codex: c } }));
    writeFileSync(imageFile, JSON.stringify({ passed: true, identity: workIdentity(c), expiresAt: c.expiresAt }));
    assert.deepEqual(buildReadySnapshot(source, 300000).pools.image, ['codex']);
    writeFileSync(connectionFile, JSON.stringify({ agents: { codex: { ...c, model: 'changed-model' } } }));
    assert.deepEqual(buildReadySnapshot(source, 300000).pools.image, []);
  } finally { [connectionFile, imageFile].forEach((f, i) => { if (previous[i]) writeFileSync(f, previous[i]!); else if (existsSync(f)) unlinkSync(f); }); }
});


test('実作業検証済みのOllamaとLM Studioを制作・試験・検収プールへ登録する',()=>{
 const agents=['ollama','lmstudio'].map(id=>withVerifiedWork(agent(id,'healthy')));
 const source:ExternalAgentSnapshot={source:'試験',cacheFreshWithin24Hours:true,agents,summary:{available:2,candidate:0,needs_recheck:0,unavailable:0,total:2}};
 const ready=buildReadySnapshot(source,300000);
 for(const category of ['text','reading','coding','testing','verification'] as const)assert.deepEqual(ready.pools[category],['ollama','lmstudio']);
 agents[1].workEvidence!.capabilities.coding=false;
 assert.deepEqual(buildReadySnapshot(source,300000).pools.coding,['ollama']);
});
