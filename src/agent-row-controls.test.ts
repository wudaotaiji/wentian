import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentHealthCheckCommand, decorateAgentSnapshot, registerAgentRowControls } from './agent-row-controls.js';
import { connectionAllowsExecution } from './agent-connection-policy.js';
import type { AgentConnection } from './agent-connection-policy.js';
import type { ExternalAgentSnapshot, ExternalAgentStatus } from './external-agents.js';
import { agentRegistered, explicitAgentAllowed } from './agent-exclusion-policy.js';
import { loadManualAgents } from './manual-agent-registry.js';
import { performanceScore, recordAgentPerformance } from './agent-performance.js';
import { workIdentity } from './agent-work-policy.js';

test('確認欄の現在評価は会話と同じ最新性能値を返し、冷却はJSONのnullで区別する', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-row-score-'));
  const previous = process.env.WENTIAN_AGENT_PERFORMANCE_FILE;
  process.env.WENTIAN_AGENT_PERFORMANCE_FILE = path.join(root, 'performance.json');
  t.after(() => { if (previous === undefined) delete process.env.WENTIAN_AGENT_PERFORMANCE_FILE; else process.env.WENTIAN_AGENT_PERFORMANCE_FILE = previous; });
  const snapshot: ExternalAgentSnapshot = { source: '試験', cacheFreshWithin24Hours: true, summary: { total: 1, available: 1, candidate: 0, needs_recheck: 0, unavailable: 0 }, agents: [{ id: 'goose', name: 'goose', state: 'available', stateLabel: '', note: '', freshWithin24Hours: true }] };
  await recordAgentPerformance({ agent: 'goose', task: 'conversation', success: true, latencyMs: 1000, output: '試験応答' });
  const first = decorateAgentSnapshot(snapshot).agents[0];
  assert.equal(first.currentScore, performanceScore('goose', 'conversation')); assert.equal(first.scoreCoolingDown, false);
  await recordAgentPerformance({ agent: 'goose', task: 'conversation', success: false, latencyMs: 2000, output: '' });
  const cooled = JSON.parse(JSON.stringify(decorateAgentSnapshot(snapshot))).agents[0];
  assert.equal(cooled.currentScore, null); assert.equal(cooled.scoreCoolingDown, true);
});

test('行操作は管理者だけが実行でき、指定行だけを確認し、使用禁止を保存・解除する', async () => {
  const previous = process.env.WENTIAN_AGENT_EXCLUSIONS_FILE;
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-row-controls-'));
  process.env.WENTIAN_AGENT_EXCLUSIONS_FILE = path.join(root, 'exclusions.json');
  let snapshot: ExternalAgentSnapshot = { source: 'test', cacheFreshWithin24Hours: false,
    summary: { total: 2, available: 2, candidate: 0, needs_recheck: 0, unavailable: 0 },
    agents: ['goose', 'crush'].map(id => ({ id, name: id, cli: id, state: 'available', stateLabel: '利用可能', note: '', freshWithin24Hours: false })) };
  const probes: string[] = [];
  let maintenance = 0;
  const app = Fastify();
  registerAgentRowControls(app, { snapshot: async () => snapshot,
    maintain: () => { maintenance++; },
    update: async agent => { snapshot = { ...snapshot, agents: snapshot.agents.map(item => item.id === agent.id ? agent : item) }; },
    authorize: (req, reply) => { if (req.headers['x-test-admin'] !== 'true') { reply.code(403).send({ error: '管理者限定' }); return; } return 'test-admin'; },
    probe: async ({ cli }) => { probes.push(cli); return { installed: true, liveState: 'healthy', checkedAt: '2026-10-04T00:00:00Z', version: '1.0' }; } });
  const control = (id: string, action: string, admin = true) => app.inject({ method: 'POST', url: `/v1/manager/external-agents/${id}/control`, headers: admin ? { 'x-test-admin': 'true' } : {}, payload: { action } });
  try {
    assert.equal((await control('goose', 'prohibit', false)).statusCode, 403);
    assert.equal((await control('unknown', 'recheck')).statusCode, 404);
    assert.equal((await control('goose', 'invalid')).statusCode, 400);
    const checked = await control('goose', 'recheck');
    assert.equal(checked.statusCode, 200);
    assert.deepEqual(probes, ['goose']);
    assert.equal(maintenance, 1, '再確認はCLI確認後に接続検証も開始します');
    assert.equal(checked.json().agents[0].version, '1.0');
    assert.equal(snapshot.agents[1].lastObservedAt, undefined);
    assert.equal(snapshot.agents[0].connection, undefined, 'CLI成功で接続検証を捏造しません');
    const prohibited = await control('goose', 'prohibit');
    assert.equal(prohibited.json().agents[0].excluded, true);
    assert.equal(connectionAllowsExecution(snapshot.agents[0]), false, '古い一覧でも保存した禁止を優先します');
    assert.equal(decorateAgentSnapshot(snapshot).agents[0].excluded, true);
    assert.equal((await control('goose', 'recheck')).json().agents[0].excluded, true, '再確認で禁止を解除しません');
    assert.equal(maintenance, 1, '禁止中のAgentは接続保守を開始しません');
    assert.equal((await control('goose', 'allow')).json().agents[0].excluded, false);
    assert.equal(connectionAllowsExecution(snapshot.agents[0]), true);
    assert.equal(probes.length, 2, '禁止・許可はCLIを起動しません');
    assert.equal((await control('goose', 'force', false)).statusCode, 403);
    const forced = (await control('goose', 'force')).json();
    assert.equal(forced.agents.find((a:any)=>a.id==='goose').forceUse,true);
    const switched = (await control('crush', 'force')).json();
    assert.equal(switched.agents.find((a:any)=>a.id==='goose').forceUse,false);
    assert.equal(switched.agents.find((a:any)=>a.id==='crush').forceUse,true);
    assert.equal((await control('goose','unforce')).json().agents.find((a:any)=>a.id==='crush').forceUse,true);
    assert.equal((await control('crush','unforce')).json().agents.some((a:any)=>a.forceUse),false);
  } finally { await app.close(); if (previous === undefined) delete process.env.WENTIAN_AGENT_EXCLUSIONS_FILE; else process.env.WENTIAN_AGENT_EXCLUSIONS_FILE = previous; }
});

test('表示コマンドは空白・引用符を含むCLIパスをPowerShellのリテラルとして扱う', () => {
  assert.equal(agentHealthCheckCommand("C:\\agent's folder\\tool.exe"), "& 'C:\\agent''s folder\\tool.exe' --version");
});

test('3回連続失敗した行は保存済みの作業検証コマンドを表示し、旧記録は失敗証跡を案内する', () => {
  const base: ExternalAgentSnapshot = { source: 'fixture', cacheFreshWithin24Hours: false,
    summary: { total: 1, available: 0, candidate: 0, needs_recheck: 0, unavailable: 1 },
    agents: [{ id: 'goose', name: 'goose', cli: 'goose', state: 'unavailable', stateLabel: '', note: '', freshWithin24Hours: false,
      workEvidence: { revision: 1, identity: 'fixture', checkedAt: '', expiresAt: '', retryAt: '', status: 'failed', capabilities: {}, evidenceDirectory: "C:\\verify's\\attempt", reason: '', failures: 3, attentionRequired: true, manualCheckCommand: "Set-Location -LiteralPath 'C:\\verify\\standalone'; & 'goose' 'run'" } as any }] };
  const current = decorateAgentSnapshot(base).agents[0];
  assert.equal(current.healthCheckCommand, "Set-Location -LiteralPath 'C:\\verify\\standalone'; & 'goose' 'run'");
  assert.match(current.healthCheckLabel!, /再実行コマンド/);
  const legacy = decorateAgentSnapshot({ ...base, agents: [{ ...base.agents[0], workEvidence: { ...base.agents[0].workEvidence!, manualCheckCommand: undefined } }] }).agents[0];
  assert.match(legacy.healthCheckCommand!, /failure\.json/);
  assert.match(legacy.healthCheckCommand!, /-Encoding UTF8/, 'BOMなしUTF-8の日本語JSONを正しく読み取ります');
  assert.match(legacy.healthCheckLabel!, /未記録/);
});

test('候補一覧から追加と登録解除を行い、一覧・選択・再追加へ同じ設定を適用する', async () => {
  const previousRegistrations = process.env.WENTIAN_AGENT_REGISTRATIONS_FILE;
  const previousManual = process.env.WENTIAN_MANUAL_AGENTS_FILE;
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-marketplace-registration-'));
  process.env.WENTIAN_AGENT_REGISTRATIONS_FILE = path.join(root, 'registrations.json');
  process.env.WENTIAN_MANUAL_AGENTS_FILE = path.join(root, 'manual.json');
  let snapshot: ExternalAgentSnapshot = { source: 'fixture', cacheFreshWithin24Hours: false, agents: [], summary: { total: 0, available: 0, candidate: 0, needs_recheck: 0, unavailable: 0 } };
  let probes = 0;
  const app = Fastify();
  registerAgentRowControls(app, { snapshot: async () => snapshot,
    update: async agent => { snapshot = { ...snapshot, agents: [...snapshot.agents.filter(item => item.id !== agent.id), agent] }; },
    authorize: (req, reply) => { if (!req.headers['x-test-admin']) { reply.code(403).send({}); return; } return 'admin'; },
    probe: async () => { probes++; throw new Error('登録操作でCLIを起動してはいけません。'); } });
  const change = (id: string, action: string, admin = true) => app.inject({ method: 'POST', url: `/v1/manager/agent-marketplace/${id}/registration`, headers: admin ? { 'x-test-admin': 'true' } : {}, payload: { action } });
  try {
    assert.equal((await change('codex', 'add', false)).statusCode, 403);
    assert.equal((await change('unknown', 'add')).statusCode, 404);
    assert.equal((await change('codex', 'invalid')).statusCode, 400);
    const added = await change('codex', 'add');
    assert.equal(added.statusCode, 200);
    assert.equal(added.json().registered, true);
    assert.equal(added.json().snapshot.agents[0].id, 'codex');
    assert.equal((await loadManualAgents())[0].cli, 'codex');
    const removed = await change('codex', 'remove');
    assert.equal(removed.json().snapshot.agents.length, 0);
    assert.equal(agentRegistered('codex'), false);
    assert.equal(explicitAgentAllowed('codex'), false);
    assert.equal(connectionAllowsExecution(snapshot.agents[0]), false);
    assert.equal((await loadManualAgents()).length, 1, '登録解除でも設定情報を削除しません');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/manager/external-agents/codex/control', headers: { 'x-test-admin': 'true' }, payload: { action: 'recheck' } })).statusCode, 404);
    assert.equal((await change('codex', 'add')).json().snapshot.agents.length, 1);
    assert.equal(probes, 0);
  } finally {
    await app.close();
    if (previousRegistrations === undefined) delete process.env.WENTIAN_AGENT_REGISTRATIONS_FILE; else process.env.WENTIAN_AGENT_REGISTRATIONS_FILE = previousRegistrations;
    if (previousManual === undefined) delete process.env.WENTIAN_MANUAL_AGENTS_FILE; else process.env.WENTIAN_MANUAL_AGENTS_FILE = previousManual;
  }
});

test('利用可能0件の原因を実測状態から分類し、固定キーワード判定を使わない', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-availability-blockers-'));
  const names = ['WENTIAN_AGENT_EXCLUSIONS_FILE','WENTIAN_AGENT_REGISTRATIONS_FILE','WENTIAN_AGENT_MANAGEMENT_FILE','WENTIAN_AGENT_CONNECTION_CACHE','WENTIAN_AGENT_WORK_CACHE','WENTIAN_AGENT_PERFORMANCE_FILE'] as const;
  const previous = names.map(name => process.env[name]);
  process.env.WENTIAN_AGENT_EXCLUSIONS_FILE = path.join(root, 'exclusions.json');
  process.env.WENTIAN_AGENT_REGISTRATIONS_FILE = path.join(root, 'registrations.json');
  process.env.WENTIAN_AGENT_MANAGEMENT_FILE = path.join(root, 'management.json');
  process.env.WENTIAN_AGENT_CONNECTION_CACHE = path.join(root, 'connections.json');
  process.env.WENTIAN_AGENT_WORK_CACHE = path.join(root, 'work.json');
  process.env.WENTIAN_AGENT_PERFORMANCE_FILE = path.join(root, 'performance.json');
  const now = new Date().toISOString(), future = new Date(Date.now() + 86_400_000).toISOString();
  const connection = (extra: Partial<AgentConnection> = {}): AgentConnection => ({ mode: 'free', model: 'fixture-model', status: 'verified', checkedAt: now, expiresAt: future, fingerprint: 'fixture-fingerprint', policyHash: 'fixture-policy', ...extra });
  const claude = connection();
  await writeFile(process.env.WENTIAN_AGENT_EXCLUSIONS_FILE, JSON.stringify({ codex: { excluded: true, updatedAt: now } }));
  await writeFile(process.env.WENTIAN_AGENT_REGISTRATIONS_FILE, '{}');
  await writeFile(process.env.WENTIAN_AGENT_MANAGEMENT_FILE, JSON.stringify({ version: 1, order: [], uninstalled: {}, deleted: [] }));
  await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE, JSON.stringify({ version: '1.0', agents: {
    openclaw: connection({ maintenanceDeferred: true, maintenanceDeferredKind: 'permission' }),
    lmstudio: connection({ maintenanceDeferred: true, maintenanceDeferredKind: 'model' }),
    goose: connection({ status: 'pending' }),
    crush: connection(),
    cline: connection({ status: 'pending' }),
    claude
  } }));
  await writeFile(process.env.WENTIAN_AGENT_WORK_CACHE, JSON.stringify({ version: 1, agents: { claude: {
    revision: 1, identity: workIdentity(claude), checkedAt: now, expiresAt: future, retryAt: future,
    status: 'passed', capabilities: {}, evidenceDirectory: '', reason: '実作業の合格記録'
  } } }));
  const agent = (id: string, liveState: ExternalAgentStatus['liveState'] = 'healthy') => ({ id, name: id, cli: id, state: 'available' as const, stateLabel: '利用可能', note: '試験用', freshWithin24Hours: true, liveState });
  try {
    const decorated = decorateAgentSnapshot({ source: 'test', cacheFreshWithin24Hours: true,
      summary: { total: 7, available: 7, candidate: 0, needs_recheck: 0, unavailable: 0 },
      agents: [agent('codex'), agent('openclaw'), agent('lmstudio'), agent('goose'), agent('crush'), agent('cline', 'probe_failed'), agent('claude')] }) as ExternalAgentSnapshot & { availabilityBlockers: Record<string, number> };
    assert.deepEqual(decorated.availabilityBlockers, { paused: 1, cli: 1, permission: 1, model: 1, connection: 1, work: 1 });
    assert.equal(decorated.summary.available, 1, '実作業まで合格したAgentだけを可用に数えます');
  } finally {
    for (let index = 0; index < names.length; index++) { if (previous[index] === undefined) delete process.env[names[index]]; else process.env[names[index]] = previous[index]; }
  }
});
