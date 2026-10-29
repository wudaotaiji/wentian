import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maintainAgentsWithAI, readAIMaintenanceReports, sanitizeMaintenanceEvidence } from './agent-ai-maintenance.js';
import { validateMaintenanceDecision, planMaintenance, type MaintenancePlannerInput, type MaintenanceAction } from './maintenance-ai-planner.js';
import type { ExternalAgentStatus } from './external-agents.js';
import { agentConnectionPolicyHash } from './agent-connection-maintenance.js';
import { workIdentity } from './agent-work-policy.js';
import { setAgentExclusion } from './agent-exclusion-policy.js';
import { writeAgentDeploymentStatus, writeMaintenanceDeploymentStatus } from './maintenance-deployment-status.js';

const message = { ja: '証跡に基づく判断', en: 'Evidence based decision', zh: '根据证据判断' };
const decision = (input: MaintenancePlannerInput, action: MaintenanceAction) => ({ version: 1 as const, action, diagnosis: message, nextStep: message, evidence: [input.observations.at(-1)!.id], confidence: 0.95 });
const agent = (): ExternalAgentStatus => ({ id: 'kilo', name: 'Kilo', cli: 'kilo', liveState: 'healthy', state: 'needs_recheck', stateLabel: '未確認', note: '', version: '1', freshWithin24Hours: true });
async function setup(t: any) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-ai-maintenance-'));
  const values = { WENTIAN_AI_MAINTENANCE_ROOT: path.join(root, 'reports'), WENTIAN_AGENT_CONNECTION_CACHE: path.join(root, 'connections.json'), WENTIAN_AGENT_WORK_CACHE: path.join(root, 'work.json'), WENTIAN_AGENT_MODEL_PREFERENCES: path.join(root, 'models.json'), WENTIAN_DEFAULT_MAINTENANCE_ACCESS: 'true' };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return root;
}

test('実装の不具合をAIが選んだソースで調査してから具体的な結果を記録する', async t => {
  await setup(t); let step = 0; const requested: unknown[] = [];
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => {
      if (step++ === 0) return { ...decision(input, 'inspect_source'), source: { operation: 'search' as const, query: 'unknownAdapter' } };
      assert.equal(input.observations.at(-1)?.kind, 'inspect_source');
      assert.match(JSON.stringify(input.observations.at(-1)?.facts), /unknownAdapter/);
      return decision(input, 'report_defect');
    },
    source: async input => { requested.push(input); return { matches: [{ path: 'src/example.ts', line: 2, text: 'unknownAdapter' }] }; },
  });
  assert.deepEqual(requested, [{ operation: 'search', query: 'unknownAdapter' }]);
  const report = (await readAIMaintenanceReports())[0];
  assert.equal(report.status, 'implementation_required');
  assert.ok(report.evidence.some(item => item.kind === 'inspect_source'));
});

test('実際に読んだソースだけ修正候補を作り、隔離検証しても適用済みにしない', async t => {
  await setup(t); let step = 0; let staged = 0; let verified = 0;
  const id = '00000000-0000-4000-8000-000000000001';
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => {
      if (step++ === 0) return { ...decision(input, 'inspect_source'), source: { operation: 'read' as const, path: 'src/example.ts', startLine: 1 } };
      if (step === 2) return { ...decision(input, 'stage_source_edit'), edit: { path: 'src/example.ts', expected: 'before', replacement: 'after' } };
      if (step === 3) return { ...decision(input, 'verify_source_edit'), verification: { candidateId: id, test: 'src/example.test.ts' } };
      assert.ok(!input.allowedActions.includes('deploy_source_edit')); return decision(input, 'report_defect');
    },
    source: async () => ({ operation: 'read', path: 'src/example.ts', lines: [{ line: 1, text: 'before' }] }),
    stageSource: async () => { staged++; return { status: 'unverified', candidateId: id }; },
    verifySource: async () => { verified++; return { status: 'candidate_verified' }; },
  });
  assert.equal(staged, 1); assert.equal(verified, 1);
  const report = (await readAIMaintenanceReports())[0];
  assert.equal(report.status, 'implementation_required');
  assert.equal(report.decision?.action, 'report_defect');
  assert.equal(report.decision?.edit, undefined);
});

test('対象アダプターの検証済み候補だけ独立監督へ引継ぎ、即時成功にしない', async t => {
  await setup(t); let step = 0, deployed = 0;
  const id = '00000000-0000-4000-8000-000000000001', file = 'src/agent-native-models.ts';
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => {
      switch (step++) {
        case 0: return { ...decision(input, 'inspect_source'), source: { operation: 'read' as const, path: file } };
        case 1: return { ...decision(input, 'stage_source_edit'), edit: { path: file, expected: 'before', replacement: 'after' } };
        case 2: return { ...decision(input, 'verify_source_edit'), verification: { candidateId: id, test: 'src/example.test.ts' } };
        default: assert.ok(input.allowedActions.includes('deploy_source_edit')); return { ...decision(input, 'deploy_source_edit'), deployment: { candidateId: id } };
      }
    },
    source: async () => ({ operation: 'read', path: file, lines: [{ line: 1, text: 'before' }] }),
    stageSource: async () => ({ status: 'unverified', candidateId: id }),
    verifySource: async () => ({ status: 'candidate_verified', candidateId: id, source: file }),
    deploySource: async () => { deployed++; return { status: 'deployment_started', candidateId: id }; },
  });
  assert.equal(deployed, 1); assert.equal((await readAIMaintenanceReports())[0].status, 'implementation_required');
});

test('AI判断中に既定保守を禁止した場合はソース調査を実行しない', async t => {
  await setup(t); let called = false;
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => {
      process.env.WENTIAN_DEFAULT_MAINTENANCE_ACCESS = 'false';
      return { ...decision(input, 'inspect_source'), source: { operation: 'search' as const, query: 'example' } };
    },
    source: async () => { called = true; return {}; },
  });
  assert.equal(called, false); assert.equal((await readAIMaintenanceReports())[0].status, 'unconfirmed');
});

test('共有アダプターの配備後は古い成功を使わず接続と作業を強制再検証する', async t => {
  const root = await setup(t), cutoff = Date.now() - 500;
  await writeMaintenanceDeploymentStatus({ status: 'deployed', at: new Date(cutoff).toISOString(), candidateId: 'fixture' });
  const value = agent(), old = new Date(cutoff - 1000).toISOString();
  const connection = { mode: 'free' as const, model: 'kilo/kilo-auto/free', status: 'verified' as const, checkedAt: old, expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: 'x', policyHash: agentConnectionPolicyHash('kilo'), cliVersion: '1' };
  const work = { revision: 1 as const, identity: workIdentity(connection, '1'), status: 'passed' as const, checkedAt: old, expiresAt: new Date(Date.now() + 60000).toISOString(), retryAt: old, capabilities: { reading: true, coding: true, testing: true, verification: true }, evidenceDirectory: root, reason: '' };
  value.connection = connection; value.workEvidence = work;
  let step = 0; const flags: Array<{ connection?: boolean; work?: boolean }> = [];
  await maintainAgentsWithAI([value], undefined, undefined, {}, {
    planner: async input => { if (step === 0) assert.ok(!input.allowedActions.includes('complete')); return decision(input, (['inspect_evidence', 'connect', 'verify_work', 'complete'] as const)[step++]); },
    diagnostics: async () => ({}),
    maintain: async (agents, _update, _signal, options) => {
      flags.push({ connection: options?.forceConnection, work: options?.forceWork });
      const freshConnection = { ...connection, checkedAt: new Date().toISOString() };
      await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE!, JSON.stringify({ agents: { kilo: freshConnection } }));
      if (options?.verifyWork) await writeFile(process.env.WENTIAN_AGENT_WORK_CACHE!, JSON.stringify({ agents: { kilo: { ...work, checkedAt: new Date().toISOString() } } }));
      return agents.map(item => ({ ...item, connection: freshConnection }));
    },
  });
  assert.equal(flags[0].connection, true); assert.equal(flags[1].work, true);
  assert.equal((await readAIMaintenanceReports())[0].status, 'verified');
});

test('独立監督の配備失敗を次のAI判断へ具体的な証跡として渡す', async t => {
  await setup(t);
  await writeAgentDeploymentStatus('kilo', { status: 'unconfirmed', candidateId: 'fixture', at: new Date().toISOString(), reason: '対象ソースに未コミット変更があります。' });
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => { assert.ok(input.observations.some(item => item.kind === 'previous_deployment' && JSON.stringify(item.facts).includes('未コミット'))); return decision(input, 'report_defect'); },
  });
  assert.equal((await readAIMaintenanceReports())[0].status, 'implementation_required');
});

test('未知の診断文も固定キーワードへ分類せずAIの調査→接続→実作業検証→実証判断を実行する', async t => {
  const root = await setup(t); const actions: string[] = []; let step = 0;
  const expected: MaintenanceAction[] = ['inspect_evidence', 'connect', 'verify_work', 'complete'];
  const results = await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => { const action = expected[step++]; assert.ok(input.allowedActions.includes(action)); return decision(input, action); },
    diagnostics: async () => ({ error: '未知の構成 XYZ。timeout 401 は引用であり障害分類ではない。' }),
    maintain: async (agents, _update, _signal, options) => {
      actions.push(options!.verifyWork ? 'verify_work' : 'connect');
      const connection = { mode: 'free' as const, model: 'kilo/kilo-auto/free', status: 'verified' as const, checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: 'verified', policyHash: agentConnectionPolicyHash('kilo'), cliVersion: '1' };
      await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE!, JSON.stringify({ agents: { kilo: connection } }));
      if (options!.verifyWork) {
        const work = { revision: 1, identity: workIdentity(connection, '1'), status: 'passed', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), retryAt: new Date().toISOString(), capabilities: { reading: true, coding: true, testing: true, verification: true }, evidenceDirectory: root, reason: '実ファイル検証成功' };
        await writeFile(process.env.WENTIAN_AGENT_WORK_CACHE!, JSON.stringify({ agents: { kilo: work } }));
      }
      return agents.map(value => ({ ...value, connection }));
    },
  });
  assert.equal(results[0].state, 'available'); assert.deepEqual(actions, ['connect', 'verify_work']);
  const reports = await readAIMaintenanceReports(); assert.equal(reports[0].status, 'verified');
  assert.equal(reports[0].evidence.length, 4); assert.equal((reports[0] as any).observations, undefined);
  const saved = JSON.parse(await readFile(path.join(root, 'reports/kilo.json'), 'utf8')); assert.match(JSON.stringify(saved.observations), /XYZ/);
});

test('AIが未検証を成功扱いしても拒否し、接続・作業は実行しない', async t => {
  await setup(t); let called = false;
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, { planner: async input => decision(input, 'complete'), maintain: async () => { called = true; return []; } });
  assert.equal(called, false); assert.equal((await readAIMaintenanceReports())[0].status, 'unconfirmed');
});

test('AI停止・不正JSON・架空の根拠では固定修復へフォールバックしない', async t => {
  await setup(t);
  for (const invalid of ['timeout', 'missing-evidence', 'unknown-action']) {
    let called = false;
    await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
      planner: async input => {
        if (invalid === 'timeout') throw new Error('AI接続失敗');
        const plan = decision(input, 'connect');
        return invalid === 'missing-evidence' ? { ...plan, evidence: ['fabricated'] } : { ...plan, action: 'execute_shell' as any };
      }, maintain: async () => { called = true; return []; },
    });
    assert.equal(called, false); assert.equal((await readAIMaintenanceReports())[0].status, 'unconfirmed');
  }
});

test('AI応答待ちに一時停止されたAgentでは操作しない', async t => {
  await setup(t); let called = false;
  t.after(async () => setAgentExclusion('kilo', false, '試験後復元'));
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => { await setAgentExclusion('kilo', true, '試験'); return decision(input, 'inspect_cli'); },
    probe: async () => { called = true; throw new Error('呼出し禁止'); },
  });
  assert.equal(called, false);
});

test('許可不足の実証後はAIが承認要求を記録し、自動で許可を書き換えない', async t => {
  await setup(t); let step = 0;
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => decision(input, step++ === 0 ? 'inspect_evidence' : 'request_approval'),
    diagnostics: async () => ({ name: 'ExecutionDenied', scope: '専用接続検証領域', expired: true }),
    maintain: async () => assert.fail('承認待ちでは実行しません'),
  });
  assert.equal((await readAIMaintenanceReports())[0].status, 'needs_approval');
});

test('再試行期限内の作業検証と正常CLI再導入をAIへ許可しない', async t => {
  await setup(t); let step = 0;
  const value = agent();
  value.connection = { mode: 'free', model: 'kilo/kilo-auto/free', status: 'verified', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: 'x', policyHash: 'x' };
  value.workEvidence = { revision: 1, identity: workIdentity(value.connection, '1'), status: 'failed', checkedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), retryAt: new Date(Date.now() + 60000).toISOString(), capabilities: {}, evidenceDirectory: '', reason: '未完了' };
  await maintainAgentsWithAI([value], undefined, undefined, {}, {
    planner: async input => { assert.ok(!input.allowedActions.includes('repair_cli')); assert.ok(!input.allowedActions.includes('verify_work')); return decision(input, step++ ? 'wait' : 'inspect_evidence'); }, diagnostics: async () => ({}),
  });
  assert.equal((await readAIMaintenanceReports())[0].status, 'waiting');
});

test('秘密値を除去しても大きな保存証跡を有効なJSONとして保持する', () => {
  const secret = 'sample-private-key-123456789'; const previous = process.env.WENTIAN_TEST_SECRET;
  process.env.WENTIAN_TEST_SECRET = secret;
  try {
    const text = sanitizeMaintenanceEvidence({ apiKey: 'private-value', diagnostic: `https://user:pass@example.test/path?token=secret ${secret}`, observations: Array.from({ length: 10 }, () => ({ text: 'x'.repeat(5000) })) });
    assert.ok(text.length > 32000); const parsed = JSON.parse(text);
    assert.equal(parsed.apiKey, '[REDACTED]'); assert.doesNotMatch(text, /private-value|user:pass|token=secret|sample-private-key/);
  } finally { if (previous === undefined) delete process.env.WENTIAN_TEST_SECRET; else process.env.WENTIAN_TEST_SECRET = previous; }
});

test('AI判断の検証は三言語・根拠・書込み確度を必須にする', () => {
  const input: MaintenancePlannerInput = { agent: 'kilo', observations: [{ id: 'one', kind: 'current', facts: {} }], allowedActions: ['connect'], history: [], constraints: {} };
  const valid = decision(input, 'connect'); assert.equal(validateMaintenanceDecision(valid, input).action, 'connect');
  assert.throws(() => validateMaintenanceDecision({ ...valid, confidence: 0.5 }, input));
  assert.throws(() => validateMaintenanceDecision({ ...valid, diagnosis: { ja: '日本語のみ' } }, input));
  assert.throws(() => validateMaintenanceDecision({ ...valid, evidence: ['missing'] }, input));
});

test('AI判断HTTPは設定モデルと認証を使い外部Agentへの再帰を禁止する', async t => {
  const previous = process.env.WENTIAN_API_KEY; process.env.WENTIAN_API_KEY = 'test-key';
  t.after(() => { if (previous === undefined) delete process.env.WENTIAN_API_KEY; else process.env.WENTIAN_API_KEY = previous; });
  const input: MaintenancePlannerInput = { agent: 'kilo', observations: [{ id: 'one', kind: 'current', facts: {} }], allowedActions: ['wait'], history: [], constraints: {} };
  const result = await planMaintenance(input, undefined, (async (_url, options) => {
    assert.equal((options!.headers as any).authorization, 'Bearer test-key'); assert.equal((options!.headers as any)['x-wentian-decision-kind'], 'maintenance');
    const body = JSON.parse(options!.body as string); assert.equal(body.response_format.type, 'json_object'); assert.equal(body.wentian_adaptive, false);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision(input, 'wait')) } }] }));
  }) as typeof fetch);
  assert.equal(result.action, 'wait');
});

test('実モデルのコード枠付きJSONだけを許容し、説明文混入と複数JSONは拒否する', async () => {
  const input: MaintenancePlannerInput = { agent: 'kilo', observations: [{ id: 'one', kind: 'current', facts: {} }], allowedActions: ['wait'], history: [], constraints: {} };
  const json = JSON.stringify(decision(input, 'wait'));
  const request = (content: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))) as typeof fetch;
  assert.equal((await planMaintenance(input, undefined, request('```json\n' + json + '\n```'))).action, 'wait');
  await assert.rejects(planMaintenance(input, undefined, request('説明文\n' + json)));
  await assert.rejects(planMaintenance(input, undefined, request(json + '\n' + json)));
});

test('AIが実在候補を選択し、候補IDやモデルを捏造した場合は拒否する', async t => {
  await setup(t); let chosen = ''; let step = 0;
  await maintainAgentsWithAI([agent()], undefined, undefined, {}, {
    planner: async input => {
      if (input.allowedActions.includes('select_candidate')) return { ...decision(input, 'select_candidate'), candidate: '1' };
      return decision(input, (['inspect_evidence','connect','wait'] as MaintenanceAction[])[step++]);
    }, diagnostics: async () => ({}),
    maintain: async (agents, _update, _signal, options) => {
      const candidates = [{ mode: 'free' as const, model: 'one' }, { mode: 'local' as const, model: 'two' }];
      chosen = (await options!.selectCandidates!(candidates, { priorAttempts: [] }))[0].model;
      return agents;
    },
  });
  assert.equal(chosen, 'two');
  const input: MaintenancePlannerInput = { agent: 'kilo', observations: [{ id: 'one', kind: 'current', facts: {} }], allowedActions: ['select_candidate'], history: [], constraints: { candidateIds: ['0'] } };
  assert.throws(() => validateMaintenanceDecision({ ...decision(input, 'select_candidate'), candidate: 'invented' }, input));
});

test('起動失敗CLIの修復はAI判断後のカタログ再導入に限定し、直後に可用へ昇格しない', async t => {
  await setup(t); const previous = process.env.WENTIAN_AGENT_AUTO_INSTALL; process.env.WENTIAN_AGENT_AUTO_INSTALL = 'true';
  t.after(() => { if (previous === undefined) delete process.env.WENTIAN_AGENT_AUTO_INSTALL; else process.env.WENTIAN_AGENT_AUTO_INSTALL = previous; });
  let step = 0, repaired = false;
  const results = await maintainAgentsWithAI([{ ...agent(), liveState: 'probe_failed' }], undefined, undefined, { autoInstall: true }, {
    planner: async input => decision(input, (['inspect_evidence', 'repair_cli', 'wait'] as MaintenanceAction[])[step++]),
    diagnostics: async () => ({ error: 'CLI配布ファイルが欠落しています。' }),
    install: async (value, _update, _signal, options) => { assert.equal(options!.repair, true); repaired = true; return { ...value, liveState: 'healthy' }; },
  });
  assert.equal(repaired, true); assert.notEqual(results[0].state, 'available');
  assert.equal((await readAIMaintenanceReports())[0].status, 'waiting');
});
