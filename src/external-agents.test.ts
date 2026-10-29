import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { agentOrchestrationDirectory, loadExternalAgentSnapshot } from './external-agents.js';

test('10種類の外部エージェントをCLI実測状態へ正規化する', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wentian-agents-'));
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ runs: [{ run_id: 'recent', observed_time: '2026-09-02T09:00:00+09:00', agents: [{ name: 'goose', result: 'health_and_design_review_success' }, { name: 'crush', result: 'health_and_readonly_review_success' }, { name: 'kilo', result: 'available', model: 'kilo/kilo-auto/free' }, { name: 'cline', result: 'unavailable', reason: 'context limit' }] }] }));
  const snapshot = await loadExternalAgentSnapshot({ directory, now: new Date('2026-09-02T10:00:00+09:00'), probe: async () => ({ installed: true, liveState: 'healthy', checkedAt: '2026-09-02T01:00:00Z', version: 'test' }) });
  assert.equal(snapshot.agents.length, 10);
  assert.equal(snapshot.agents.find(agent => agent.id === 'goose')?.state, 'available');
  for (const agent of snapshot.agents) {
    assert.ok(agent.lastObservedAt);
    assert.ok(['healthy', 'not_installed', 'probe_failed'].includes(agent.liveState || ''));
  }
});

test('初回と同時読み込みで空のキャッシュを初期化し、未確認を正常扱いしない', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-first-agent-cache-'));
  const directory = path.join(root, '.agent_orchestration');
  const snapshots = await Promise.all(Array.from({ length: 4 }, () => loadExternalAgentSnapshot({ directory, probeLive: false })));
  const snapshot = snapshots[0];
  assert.equal(snapshot.summary.total, 10);
  for (const result of snapshots) assert.equal(result.warning, undefined);
  assert.equal(snapshot.summary.needs_recheck, 10);
  assert.equal(snapshot.cacheFreshWithin24Hours, false);
  assert.deepEqual(JSON.parse(await readFile(snapshot.source, 'utf8')), { runs: [] });
});

test('保存先は明示指定、環境変数、ユーザーホームの順で解決する', () => {
  const previous = process.env.WENTIAN_AGENT_ORCHESTRATION_DIR;
  try {
    delete process.env.WENTIAN_AGENT_ORCHESTRATION_DIR;
    const home = process.platform === 'win32' ? process.env.USERPROFILE || homedir() : homedir();
    assert.equal(agentOrchestrationDirectory(), path.join(home, '.agent_orchestration'));
    process.env.WENTIAN_AGENT_ORCHESTRATION_DIR = 'custom-cache';
    assert.equal(agentOrchestrationDirectory(), path.resolve('custom-cache'));
    assert.equal(agentOrchestrationDirectory('explicit-cache'), path.resolve('explicit-cache'));
    process.env.WENTIAN_AGENT_ORCHESTRATION_DIR = '  ';
    assert.equal(agentOrchestrationDirectory(), path.join(home, '.agent_orchestration'));
  } finally {
    if (previous === undefined) delete process.env.WENTIAN_AGENT_ORCHESTRATION_DIR;
    else process.env.WENTIAN_AGENT_ORCHESTRATION_DIR = previous;
  }
});

test('破損した既存キャッシュは上書きせず警告する', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wentian-invalid-agent-cache-'));
  const source = path.join(directory, 'summary.json');
  await writeFile(source, '{invalid');
  const snapshot = await loadExternalAgentSnapshot({ directory, probeLive: false });
  assert.ok(snapshot.warning);
  assert.equal(await readFile(source, 'utf8'), '{invalid');
});

test('ClineのTool Call未適用記録を利用不可として分類する', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wentian-cline-unapplied-'));
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ runs: [{ run_id: 'cline-review', observed_time: '2026-09-10T09:00:00+09:00', agents: [{ name: 'cline', result: 'tool_call_not_applied' }] }] }));
  const snapshot = await loadExternalAgentSnapshot({ directory, now: new Date('2026-09-10T10:00:00+09:00'), probeLive: false });
  assert.equal(snapshot.agents.find(agent => agent.id === 'cline')?.state, 'unavailable');
});
test('CLI確認を直列化し、中断後に次のCLIを起動しない',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'wentian-serial-probe-'));
  let active=0,maximum=0,calls=0;
  const controller=new AbortController();
  await assert.rejects(loadExternalAgentSnapshot({directory,signal:controller.signal,probe:async()=>{
    maximum=Math.max(maximum,++active);calls++;
    await new Promise(resolve=>setImmediate(resolve));
    active--;controller.abort();
    return {installed:true,liveState:'healthy',checkedAt:new Date().toISOString()};
  }}));
  assert.equal(calls,1);assert.equal(maximum,1);
});
