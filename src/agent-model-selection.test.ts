import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildModelChoices, readModelPreferences, saveModelPreference,setManualModelSelection } from './agent-model-selection.js';
import { readAgentConnections } from './agent-connection-policy.js';
import { registerAgentRowControls } from './agent-row-controls.js';
import { maintainAgentConnection } from './agent-connection-maintenance.js';

test('同名でも無料モデル・Agentモデル・Wentianモデルを区別し、Agentへの循環委任を候補から除きます', () => {
  const choices = buildModelChoices('kilo', ['kilo/kilo-auto/free', 'vendor/paid', 'vendor/paid', '<script>'], [{ id: 'vendor/paid' }, { id: 'wentian-agent/auto' }]);
  assert.deepEqual(choices.map(value => [value.id, value.mode]), [
    ['free:kilo/kilo-auto/free', 'free'], ['other:vendor/paid', 'native'], ['wentian:vendor/paid', 'local'],
  ]);
});

test('明示選択モデルは自動保守の無料優先選定で上書きされず、CLIへ完全IDで渡されます', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-model-pinned-'));
  const previous = process.env.WENTIAN_AGENT_MODEL_PREFERENCES;
  process.env.WENTIAN_AGENT_MODEL_PREFERENCES = path.join(root, 'preferences.json');
  saveModelPreference('kilo', { manual:true,source: 'other', mode: 'native', model: 'vendor/chosen', selectedAt: new Date().toISOString() });
  const applied: string[] = [];
  try {
    const connected = await maintainAgentConnection({ id: 'kilo', name: 'Kilo', state: 'needs_recheck', stateLabel: '要再確認', note: '', liveState: 'healthy', version: 'test', freshWithin24Hours: true }, undefined, {
      configure: async (_id, mode, model, apply) => { if (apply) applied.push(`${mode}:${model}`); return { fingerprint: 'selected', changedFiles: [] }; },
      discover: async () => { throw new Error('選択済みモデルで自動候補を探してはいけません'); },
      discoverLocal: async () => { throw new Error('選択済みモデルで内部候補を探してはいけません'); },
      run: async command => { assert.equal(command.args[command.args.indexOf('--model') + 1], 'vendor/chosen'); return 'WENTIAN_CONNECTION_OK_KILO'; },
    });
    assert.equal(connected.status, 'verified');
    assert.equal(connected.model, 'vendor/chosen');
    assert.equal(connected.mode, 'native');
    assert.deepEqual(applied, ['native:vendor/chosen']);
  } finally {
    if (previous === undefined) delete process.env.WENTIAN_AGENT_MODEL_PREFERENCES; else process.env.WENTIAN_AGENT_MODEL_PREFERENCES = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('モデル変更は管理者と実在候補に限定し、選択を永続化して旧接続認定を無効にします', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-model-selection-'));
  const previous = process.env.WENTIAN_AGENT_MODEL_PREFERENCES;
  const previousConnections = process.env.WENTIAN_AGENT_CONNECTION_CACHE;
  process.env.WENTIAN_AGENT_MODEL_PREFERENCES = path.join(root, 'preferences.json');
  process.env.WENTIAN_AGENT_CONNECTION_CACHE = path.join(root, 'connections.json');
  let maintenance = 0;
  let agent: any = { id: 'kilo', name: 'Kilo', state: 'available', liveState: 'healthy', freshWithin24Hours: true };
  const app = Fastify();
  registerAgentRowControls(app, {
    snapshot: async () => ({ source: 'fixture', cacheFreshWithin24Hours: true, agents: [agent], summary: { total: 1, available: 1, candidate: 0, needs_recheck: 0, unavailable: 0 } }),
    update: async next => { agent = next; }, authorize: (req, reply) => { if (req.headers['x-admin'] === 'yes') return 'admin'; reply.code(403).send({ error: '管理者限定' }); },
    gatewayUrl: () => 'http://127.0.0.1:8787', maintain: () => { maintenance++; },
    modelChoices: async () => ({ choices: buildModelChoices('kilo', ['kilo/kilo-auto/free'], [{ id: 'ollama/example' }]), warning: undefined }),
  });
  const request = (choice: string, admin = true) => app.inject({ method: 'POST', url: '/v1/manager/external-agents/kilo/models', headers: admin ? { 'x-admin': 'yes' } : {}, payload: { choice } });
  try {
    assert.equal((await request('wentian:ollama/example', false)).statusCode, 403);
    assert.equal((await app.inject({method:'POST',url:'/v1/manager/external-agents/kilo/model-selection',payload:{manual:true}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/v1/manager/external-agents/kilo/model-selection',headers:{'x-admin':'yes'},payload:{manual:'true'}})).statusCode,400);
    assert.equal((await request('wentian:ollama/example')).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/v1/manager/external-agents/kilo/model-selection',headers:{'x-admin':'yes'},payload:{manual:true}})).statusCode,200);
    assert.equal((await request('wentian:missing')).statusCode, 400);
    assert.equal(maintenance, 1);
    const selected = await request('wentian:ollama/example');
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal(readModelPreferences().kilo.model, 'ollama/example');
    assert.equal(readModelPreferences().kilo.baseUrl, 'http://127.0.0.1:8787/v1');
    assert.equal(readAgentConnections().kilo.status, 'pending');
    assert.equal(readAgentConnections().kilo.fingerprint, '');
    assert.equal(agent.state, 'needs_recheck');
    assert.equal(maintenance, 2);
    assert.equal((await app.inject('/v1/manager/external-agents/kilo/models')).json().selected.model, 'ollama/example');
    const automatic=await app.inject({method:'POST',url:'/v1/manager/external-agents/kilo/model-selection',headers:{'x-admin':'yes'},payload:{manual:false}});
    assert.equal(automatic.statusCode,200);assert.equal(automatic.json().agents[0].manualModel,false);
    assert.equal(readModelPreferences().kilo.model,'ollama/example','固定解除後も利用者の接続情報を保持します');
    assert.equal(readAgentConnections().kilo.status,'pending');assert.equal(maintenance,3);
    assert.equal((await request('wentian:ollama/example')).statusCode,409,'固定解除後はAPIからも変更を拒否します');
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.WENTIAN_AGENT_MODEL_PREFERENCES; else process.env.WENTIAN_AGENT_MODEL_PREFERENCES = previous;
    if (previousConnections === undefined) delete process.env.WENTIAN_AGENT_CONNECTION_CACHE; else process.env.WENTIAN_AGENT_CONNECTION_CACHE = previousConnections;
    await rm(root, { recursive: true, force: true });
  }
});

test('Codexと候補なしAgentも明示したモデルIDを保存でき、不正な識別子を拒否する',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-native-selection-'));
  const keys=['WENTIAN_AGENT_MODEL_PREFERENCES','WENTIAN_AGENT_CONNECTION_CACHE'];const previous=keys.map(key=>process.env[key]);
  keys.forEach((key,index)=>process.env[key]=path.join(root,index+'.json'));
  const app=Fastify();let maintained='';
  const agents=['codex','goose'].map(id=>({id,name:id,state:'needs_recheck' as const,stateLabel:'未確認',note:'',liveState:'healthy' as const,freshWithin24Hours:true}));
  registerAgentRowControls(app,{
    snapshot:async()=>({source:'fixture',cacheFreshWithin24Hours:true,agents,summary:{total:2,available:0,candidate:0,needs_recheck:2,unavailable:0}}),
    update:async()=>{},authorize:()=> 'fixture',models:async()=>{throw new Error('内部モデル取得失敗');},
    modelChoices:async()=>({choices:[],warning:undefined}),maintain:id=>{maintained=id;},
  });
  try{
    setManualModelSelection('codex',true);setManualModelSelection('goose',true);
    const request=(id:string,payload:object)=>app.inject({method:'POST',url:`/v1/manager/external-agents/${id}/models`,payload});
    assert.equal((await request('codex',{nativeModel:'example-model',provider:'custom'})).statusCode,200);
    assert.equal(readModelPreferences().codex.provider,'custom');assert.equal(maintained,'codex');
    assert.equal((await request('goose',{nativeModel:'example-model',provider:'custom'})).statusCode,200);
    assert.equal((await request('codex',{nativeModel:'model; command'})).statusCode,400);
    assert.equal((await request('codex',{nativeModel:'model',provider:'../../secret'})).statusCode,400);
    assert.equal((await app.inject('/v1/manager/external-agents/goose/models')).statusCode,200,'内部モデルの取得失敗でAgent候補APIを停止しません');
  }finally{await app.close();keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});}
});
