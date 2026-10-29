import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, connectionProbeCommand, connectionStatusUpdate, discoverLocalModels, maintenancePythonCommand, maintainAgentConnection, maintainAgentConnections, type ConnectionMaintenanceDependencies } from './agent-connection-maintenance.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectionAllowsExecution, isFreeAgentModel } from './agent-connection-policy.js';
import { workIdentity } from './agent-work-policy.js';
import { ExecutionDenied } from './execution-governance.js';
import type { ExternalAgentStatus } from './external-agents.js';

const agent = (id = 'opencode'): ExternalAgentStatus => ({ id, name: id, state: 'available', stateLabel: '', note: '', freshWithin24Hours: true, liveState: 'healthy', version: 'test' });

test('保守保留の原因を許可不足とモデル未ロードで区別し、旧記録は断定しない', () => {
  const connection = {mode:'native' as const,model:'test',status:'pending' as const,checkedAt:'',expiresAt:'',fingerprint:'',policyHash:'',maintenanceDeferred:true};
  assert.equal(connectionStatusUpdate(agent(), {...connection,maintenanceDeferredKind:'permission'}).stateLabel, '実行許可待ち・保守保留');
  assert.equal(connectionStatusUpdate(agent(), {...connection,maintenanceDeferredKind:'model'}).stateLabel, 'ローカルモデル未ロード・保守保留');
  assert.equal(connectionStatusUpdate(agent(), connection).stateLabel, '保守保留');
});

test('接続検査の実行許可不足は許可待ちとして記録し、モデル未ロードと断定しない', async () => {
  const { deps } = fixture();
  deps.run = async () => { throw new ExecutionDenied(); };
  const result = await maintainAgentConnection(agent(), undefined, deps);
  assert.equal(result.status, 'pending');
  assert.equal(result.maintenanceDeferred, true);
  assert.equal(result.maintenanceDeferredKind, 'permission');
  assert.equal(connectionStatusUpdate(agent(), result).stateLabel, '実行許可待ち・保守保留');
});

test('Gooseの接続検査は保守で選んだプロバイダーとモデルを明示する', () => {
  const entry = {mode:'local' as const,model:'installed-model',status:'pending' as const,checkedAt:'',expiresAt:'',fingerprint:'',policyHash:''};
  const command=connectionProbeCommand('goose',entry,'C:/workspace','WENTIAN_CONNECTION_OK_GOOSE');
  assert.equal(command.args[command.args.indexOf('--provider')+1],'wentian-local');
  assert.equal(command.args[command.args.indexOf('--model')+1],'installed-model');
  assert.ok(command.args.includes('--no-profile'));
  assert.ok(!command.args.includes('--with-builtin'));
});

test('ローカルモデル一覧から会話モデルだけを選び、設定済みモデルを優先する',async()=>{
  const saved=globalThis.fetch;
  globalThis.fetch=(async()=>Response.json({data:[{id:'alternative'},{id:'preferred'},{id:'text-embedding-model'},{id:'vector',type:'embedding'},{id:'preferred'}]})) as typeof fetch;
  try{
    assert.deepEqual(await discoverLocalModels('http://127.0.0.1:1234/v1','preferred'),['preferred','alternative']);
    assert.deepEqual(await discoverLocalModels('http://127.0.0.1:1234/v1','retired-model'),['alternative','preferred']);
    await assert.rejects(discoverLocalModels('https://outside.example.com/v1','preferred'),/設定が不正/);
  }finally{globalThis.fetch=saved;}
});

test('ローカル一覧の不正・空一覧を成功とせず、モデルを推測して設定しない',async()=>{
  const saved=globalThis.fetch;
  try{
    globalThis.fetch=(async()=>Response.json({data:[{id:'text-embedding-model'}]})) as typeof fetch;
    await assert.rejects(discoverLocalModels('http://localhost:11434/v1','missing'),/会話用モデル/);
    globalThis.fetch=(async()=>Response.json({models:[]})) as typeof fetch;
    await assert.rejects(discoverLocalModels('http://localhost:11434/v1','missing'),/形式が不正/);
  }finally{globalThis.fetch=saved;}
});

test('未ロードの優先モデルより実際にロード済みのモデルを先に確認する',async()=>{
  const saved=globalThis.fetch;
  globalThis.fetch=(async(input)=>Response.json(String(input).includes('/api/v1/')
    ? {models:[{key:'preferred',loaded_instances:[]},{key:'loaded',loaded_instances:[{id:'active'}]}]}
    : {data:[{id:'preferred'},{id:'loaded'}]})) as typeof fetch;
  try{assert.deepEqual(await discoverLocalModels('http://127.0.0.1:1234/v1','preferred'),['loaded','preferred']);}
  finally{globalThis.fetch=saved;}
});

test('旧モデルが提供されないときは実際の候補へ設定を更新し、実応答後に復帰する',async()=>{
  const {deps,applied}=fixture('goose',undefined);
  deps.discoverLocal=async()=>['installed-model'];
  const result=await maintainAgentConnection(agent('goose'),undefined,deps);
  assert.equal(result.status,'verified');assert.equal(result.model,'installed-model');
  assert.deepEqual(applied,['local:installed-model']);
});

test('Windowsの保守Pythonは実行エイリアスを避け、ランチャーと明示指定を区別する', () => {
  assert.deepEqual(maintenancePythonCommand('win32', '', '/wentian-no-python-environment'), { executable: 'py', args: ['-3'] });
  assert.deepEqual(maintenancePythonCommand('linux', '', '/wentian-no-python-environment'), { executable: 'python3', args: [] });
  assert.deepEqual(maintenancePythonCommand('win32', 'C:\\Python\\python.exe'), { executable: 'C:\\Python\\python.exe', args: [] });
  assert.deepEqual(maintenancePythonCommand('win32', 'C:\\Launcher\\py.exe'), { executable: 'C:\\Launcher\\py.exe', args: ['-3'] });
});

test('プロジェクト専用のPythonを優先し、明示指定はさらに優先する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-maintenance-python-'));
  const executable = path.join(root, '.venv', 'Scripts', 'python.exe');
  await mkdir(path.dirname(executable), { recursive: true }); await writeFile(executable, 'fixture');
  assert.deepEqual(maintenancePythonCommand('win32', '', root), { executable, args: [] });
  assert.deepEqual(maintenancePythonCommand('win32', 'custom-python.exe', root), { executable: 'custom-python.exe', args: [] });
});
test('システムPythonに依存せずGateway管理環境を保守に再利用する',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wentian-managed-python-'));
  const executable=path.join(root,'.wentian','planner-engine','Scripts','python.exe');
  await mkdir(path.dirname(executable),{recursive:true});await writeFile(executable,'fixture');
  assert.deepEqual(maintenancePythonCommand('win32','',root),{executable,args:[]});
  assert.equal(maintenancePythonCommand('win32','explicit-python.exe',root).executable,'explicit-python.exe');
});

test('Agentごとに接続直後に作業検証を行い他Agentを待たない', { timeout: 5000 }, async () => {
  const previousCache = process.env.WENTIAN_AGENT_CONNECTION_CACHE;
  const directory = await mkdtemp(path.join(tmpdir(), 'wentian-maintenance-order-'));
  process.env.WENTIAN_AGENT_CONNECTION_CACHE = path.join(directory, 'connections.json');
  const events: string[] = [];
  const candidates = [agent('kilo'), agent('opencode')];
  let finishFirstWork!: () => void;
  const firstWork = new Promise<void>(resolve => { finishFirstWork = resolve; });
  try { await maintainAgentConnections(candidates, async updated => { events.push(`表示:${updated.id}`); }, undefined, {
    admit:async()=>{}, resources: async () => ({ cpu: 10, memory: 10, network: 10, disk: 10 }),
    connect: async candidate => { if (candidate.id === 'opencode') await firstWork; events.push(`接続:${candidate.id}`); return { mode: 'free', model: 'fixture-free', status: 'verified', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: 'test', policyHash: 'test' }; },
    work: async candidate => { events.push(`作業:${candidate.id}`); if (candidate.id === 'kilo') finishFirstWork(); return { revision: 1, identity: 'test', checkedAt: '', expiresAt: '', retryAt: '', status: 'failed', capabilities: {}, evidenceDirectory: '', reason: 'fixture', failures: 1 }; },
  });
  assert.ok(events.indexOf('作業:kilo') < events.indexOf('接続:opencode'));
  for (const id of ['kilo', 'opencode']) assert.ok(events.indexOf(`接続:${id}`) < events.indexOf(`作業:${id}`));
  } finally { if (previousCache === undefined) delete process.env.WENTIAN_AGENT_CONNECTION_CACHE; else process.env.WENTIAN_AGENT_CONNECTION_CACHE = previousCache; }
});

test('統一設定で自動導入と実作業検証を無効にしても接続確認は継続する', async () => {
  const previousCache=process.env.WENTIAN_AGENT_CONNECTION_CACHE;
  const directory=await mkdtemp(path.join(tmpdir(),'wentian-maintenance-options-'));
  process.env.WENTIAN_AGENT_CONNECTION_CACHE=path.join(directory,'connections.json');
  let connections=0;
  try {
    await maintainAgentConnections([agent('kilo')],undefined,undefined,{
      admit:async()=>{}, resources: async () => ({ cpu: 10, memory: 10, network: 10, disk: 10 }),
      autoInstall:false,verifyWork:false,
      install:async()=>{throw new Error('自動導入を起動してはいけません。');},
      work:async()=>{throw new Error('実作業検証を起動してはいけません。');},
      connect:async()=>{connections++;return {mode:'free',model:'fixture',status:'verified',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:'fixture',policyHash:'fixture'};},
    });
    assert.equal(connections,1);
  } finally {if(previousCache===undefined)delete process.env.WENTIAN_AGENT_CONNECTION_CACHE;else process.env.WENTIAN_AGENT_CONNECTION_CACHE=previousCache;}
});

test('未導入・起動失敗・接続失敗を分け、次回確認予定を表示する', async () => {
  const { deps } = fixture();
  const missing = { ...agent(), liveState: 'not_installed' as const };
  const connection = await maintainAgentConnection(missing, undefined, deps);
  assert.equal(connectionStatusUpdate(missing, connection).stateLabel, 'CLI未導入');
  assert.equal(connectionStatusUpdate(missing, connection).state, 'unavailable');
  assert.equal(connectionStatusUpdate({ ...agent(), liveState: 'probe_failed' }, connection).stateLabel, 'CLI起動失敗');
  const failed = connectionStatusUpdate(agent(), connection);
  assert.equal(failed.stateLabel, '接続確認失敗・再試行待ち');
  assert.match(failed.note, /次回確認予定/);
});

test('成功記録の期限切れは接続失敗と区別する', () => {
  const expired = connectionStatusUpdate(agent(), { mode: 'free', model: 'fixture', status: 'verified', checkedAt: '', expiresAt: '2000-01-01T00:00:00Z', fingerprint: '', policyHash: '' });
  assert.equal(expired.state, 'needs_recheck');
  assert.equal(expired.stateLabel, '接続確認期限切れ・再確認待ち');
  assert.match(expired.note, /前回の接続確認は成功/);
});

test('実作業の失敗・対応待ち・期限切れを未検証と区別し、合格だけを利用可能にする', () => {
  const connected = { mode: 'local' as const, model: 'test-model', status: 'verified' as const, checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), fingerprint: 'fingerprint', policyHash: 'policy', cliVersion: 'test' };
  const evidence = (status: 'passed' | 'failed', options: { attention?: boolean; retryAt?: string; expiresAt?: string } = {}) => ({
    revision: 1 as const, identity: workIdentity(connected, 'test'), checkedAt: new Date().toISOString(),
    expiresAt: options.expiresAt || new Date(Date.now() + 60_000).toISOString(), retryAt: options.retryAt || new Date(Date.now() + 60_000).toISOString(),
    status, capabilities: status === 'passed' ? { reading: true } : {}, evidenceDirectory: 'fixture', reason: 'fixture',
    failures: status === 'failed' ? 3 : 0, attentionRequired: options.attention || false,
  });
  const success = connectionStatusUpdate(agent(), connected, evidence('passed'));
  assert.equal(success.state, 'available'); assert.equal(success.stateLabel, '実作業検証済み');
  const retry = connectionStatusUpdate(agent(), connected, evidence('failed', { retryAt: new Date(Date.now() + 60_000).toISOString() }));
  assert.equal(retry.state, 'needs_recheck'); assert.equal(retry.stateLabel, '実作業検証失敗・再試行待ち');
  const attention = connectionStatusUpdate(agent(), connected, evidence('failed', { attention: true }));
  assert.equal(attention.state, 'unavailable'); assert.equal(attention.stateLabel, '実作業検証・利用者対応待ち');
  const expired = connectionStatusUpdate(agent(), connected, evidence('passed', { expiresAt: new Date(Date.now() - 60_000).toISOString() }));
  assert.equal(expired.state, 'needs_recheck'); assert.equal(expired.stateLabel, '実作業検証期限切れ・再確認待ち');
});

test('PyYAMLの不足を一般的な接続失敗に埋めず、保守の前提不足として記録する', async () => {
  const { deps } = fixture();
  deps.configure = async () => { throw Object.assign(new Error('Python処理失敗'), { diagnostic: "ModuleNotFoundError: No module named 'yaml'" }); };
  const failed = await maintainAgentConnection(agent(), undefined, deps);
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason || '', /PyYAML/);
  assert.equal(failed.stage, 'settings');
});
// 本試験は依存を置換し、実エージェントの起動・ユーザー設定の変更を行いません。
function fixture(id = 'opencode', models: string[] | undefined = ['opencode/example-free']) {
  const applied: string[] = [];
  const deps: ConnectionMaintenanceDependencies = {
    admit:async()=>{},
    native:async()=>[],localBases:()=>['http://127.0.0.1:1234/v1'],
    now: Date.now,
    configure: async (_agent, mode, model, apply) => { if (apply) applied.push(`${mode}:${model}`); return { fingerprint: 'test', changedFiles: [] }; },
    discover: async () => models,
    discoverLocal: async () => ['local-model'],
    run: async () => `WENTIAN_CONNECTION_OK_${id.toUpperCase()}`,
    rollback: async () => {},
  };
  return { applied, deps };
}

test('無料候補の一覧だけでは成功にならず、実応答後に検証済みとする', async () => {
  const { deps, applied } = fixture();
  const entry = await maintainAgentConnection(agent(), undefined, deps);
  assert.equal(entry.status, 'verified'); assert.equal(entry.mode, 'free');
  assert.deepEqual(applied, ['free:opencode/example-free']);
});
test('無料モデルが提供されない場合はローカルLLMを設定して検証する', async () => {
  const { deps, applied } = fixture('claude', undefined);
  const entry = await maintainAgentConnection(agent('claude'), undefined, deps);
  assert.equal(entry.status, 'verified'); assert.equal(entry.mode, 'local');
  assert.deepEqual(applied, ['local:local-model']);
});
test('無料一覧の取得失敗を記録し、ローカル候補の実応答を確認する', async () => {
  const { deps, applied } = fixture(); deps.discover = async () => { throw new Error('一覧障害'); };
  const entry=await maintainAgentConnection(agent(), undefined, deps);
  assert.equal(entry.status, 'verified');assert.ok(entry.discoveryWarning);
  assert.deepEqual(applied, ['local:local-model']);
});
test('無料候補の応答失敗時は有料モデルを使わずローカル候補も確認する', async () => {
  const { deps, applied } = fixture(); deps.run = async () => '認証エラー';
  const entry = await maintainAgentConnection(agent(), undefined, deps);
  assert.equal(entry.status, 'failed'); assert.equal(entry.attempts?.length, 2);
  assert.deepEqual(applied, ['free:opencode/example-free','local:local-model']);
});
test('応答失敗した候補の設定を復元してから次候補を検証する', async () => {
  const { deps } = fixture('opencode', ['opencode/one-free', 'opencode/two-free']);
  const events: string[] = []; let count = 0;
  deps.configure = async (_agent, _mode, model, apply) => { if (apply) events.push(`設定:${model}`); return { fingerprint: 'test', changedFiles: [], backup: apply ? '退避' : undefined }; };
  deps.rollback = async () => { events.push('復元'); };
  deps.run = async () => ++count === 1 ? '失敗応答' : 'WENTIAN_CONNECTION_OK_OPENCODE';
  const result = await maintainAgentConnection(agent(), undefined, deps);
  assert.equal(result.status, 'verified'); assert.equal(result.model, 'opencode/two-free');
  assert.deepEqual(events, ['設定:opencode/one-free', '復元', '設定:opencode/two-free']);
});
test('確認文字列のコマンドエコーは実応答の成功に数えない', async () => {
  const { deps } = fixture(); deps.run = async () => 'prompt: WENTIAN_CONNECTION_OK_OPENCODEだけを返してください';
  assert.equal((await maintainAgentConnection(agent(), undefined, deps)).status, 'failed');
});
test('設定指紋が同じ有効な成功記録は再利用し、変化した場合は再検証する', async () => {
  const { deps } = fixture(); let discovery = 0;
  deps.discover = async () => { discovery++; return ['opencode/example-free']; };
  const previous = await maintainAgentConnection(agent(), undefined, deps);
  await maintainAgentConnection(agent(), previous, deps); assert.equal(discovery, 1);
  deps.configure = async () => ({ fingerprint: 'changed', changedFiles: ['設定'] });
  await maintainAgentConnection(agent(), previous, deps); assert.equal(discovery, 2);
});

test('保守保留へ戻った接続は過去の成功期限に関係なく再検証して復帰する', async () => {
  const { deps } = fixture(); let probes = 0;
  const run = deps.run!;
  deps.run = async (...args) => { probes++; return run(...args); };
  const previous = await maintainAgentConnection(agent(), undefined, deps);
  const deferred = { ...previous, status: 'pending' as const, maintenanceDeferred: true };
  const recovered = await maintainAgentConnection(agent(), deferred, deps);
  assert.equal(probes, 2);
  assert.equal(recovered.status, 'verified');
  assert.equal(recovered.maintenanceDeferred, undefined);
  assert.equal(recovered.maintenanceDeferredKind, undefined);
});
test('停止確認に失敗したプロセスがある場合は次候補の起動を中止する', async () => {
  const { deps, applied } = fixture('opencode', ['opencode/one-free', 'opencode/two-free']);
  deps.run = async () => { throw Object.assign(new Error('停止不明'), { termination: { verifiedStopped: false } }); };
  await assert.rejects(maintainAgentConnection(agent(), undefined, deps)); assert.equal(applied.length, 1);
});
test('接続失敗・期限切れ・未検証の組み込みエージェントを実行候補にしない', () => {
  const failed = { mode: 'free' as const, model: 'opencode/example-free', status: 'failed' as const, checkedAt: '', expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: '', policyHash: '' };
  assert.equal(connectionAllowsExecution({ id: 'opencode', connection: failed }), false);
  assert.equal(connectionAllowsExecution({ id: 'opencode', connection: { ...failed, status: 'verified', expiresAt: '2000-01-01' } }), false);
  assert.equal(connectionAllowsExecution({ id: 'opencode', registration: 'built_in' }), false);
  assert.equal(isFreeAgentModel('opencode', 'opencode/paid-model'), false);
});


test('設定ブリッジも接続検証の専用領域から起動しプロジェクト全体の許可を要求しない',async()=>{
  const previous=process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT;
  const workspace=await mkdtemp(path.join(tmpdir(),'wentian-config-scope-'));
  process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT=workspace;
  let calls=0;
  try {
    await configure('goose','local','fixture/model',false,undefined,undefined,{mode:'local',model:'fixture/model',source:'wentian',baseUrl:'http://fixture.invalid/v1'},async(command,options)=>{
      calls++;assert.equal(options.cwd,workspace);assert.equal(options.role,'connection-config');
      assert.ok(command.args.some(value=>path.isAbsolute(value)&&value.endsWith('maintain-agent-connection.py')));
      return JSON.stringify({fingerprint:'fixture',changedFiles:[]});
    });assert.equal(calls,1);
  }finally{if(previous===undefined)delete process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT;else process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT=previous;}
});


test('モデル一覧に残った提供終了・無効モデルは自動復旧候補へ入れない',async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=(async(url)=>new URL(String(url)).pathname.endsWith('/models')?Response.json({data:[{id:'retired',available:false},{id:'deprecated',deprecated:true},{id:'active'}]}):Response.json({models:[]})) as typeof fetch;
  try {assert.deepEqual(await discoverLocalModels('http://127.0.0.1:8787/v1','retired'),['active']);}
  finally {globalThis.fetch=previous;}
});
