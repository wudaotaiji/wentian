import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {maintainAgentConnection,maintainAgentConnections,connectionCandidateKey,agentConnectionPolicyHash,type ConnectionMaintenanceDependencies} from './agent-connection-maintenance.js';
import {readAgentConnections,type AgentConnection} from './agent-connection-policy.js';
import {manualModelPreference,saveModelPreference,setManualModelSelection} from './agent-model-selection.js';
import {workIdentity,type AgentWorkEvidence} from './agent-work-policy.js';
import type {ExternalAgentStatus} from './external-agents.js';

/** 利用者の設定・CLI・モデルサーバーへ接続せず、一時台帳と模擬応答だけで検査します。 */
async function fixture(t:any){
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-auto-model-'));
 const names=['WENTIAN_AGENT_MODEL_PREFERENCES','WENTIAN_AGENT_CONNECTION_CACHE','WENTIAN_AGENT_WORK_CACHE'];const previous=names.map(name=>process.env[name]);
 names.forEach((name,index)=>process.env[name]=path.join(root,index+'.json'));
 t.after(async()=>{names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index]});await rm(root,{recursive:true,force:true})});
 const agent:ExternalAgentStatus={id:'goose',name:'goose',state:'needs_recheck',stateLabel:'未確認',note:'',liveState:'healthy',version:'fixture',freshWithin24Hours:true};
 const deps:ConnectionMaintenanceDependencies={admit:async()=>{},configure:async()=>({fingerprint:'fixture',changedFiles:[]}),rollback:async()=>{},discover:async()=>[],discoverLocal:async()=>[],native:async()=>[],localBases:()=>[],run:async()=>`WENTIAN_CONNECTION_OK_${agent.id.toUpperCase()}`,now:Date.now};
 return{root,agent,deps};
}

test('旧設定の存在しないモデルへ固定せず、ネイティブの実在候補をプロバイダー付きで検証する',async t=>{
 const {agent,deps}=await fixture(t);saveModelPreference(agent.id,{source:'other',mode:'native',model:'retired-model',selectedAt:''});assert.equal(manualModelPreference(agent.id),undefined);
 deps.native=async()=>[{model:'installed-model',provider:'configured-provider'}];deps.discoverLocal=async()=>{throw Error('サーバー停止')};deps.localBases=()=>['http://127.0.0.1:1234/v1'];
 const applied:string[]=[];deps.configure=async(_id,_mode,model,apply,choice)=>{if(apply){applied.push(model);assert.equal(choice?.provider,'configured-provider')}return{fingerprint:'fixture',changedFiles:[]}};
 const result=await maintainAgentConnection(agent,undefined,deps);assert.equal(result.status,'verified');assert.equal(result.mode,'native');assert.equal(result.provider,'configured-provider');assert.deepEqual(applied,['installed-model']);
});

test('固定を有効にするだけで現在選択済みのモデルと接続先を空欄へ戻さない',async t=>{
 const {agent}=await fixture(t);const current={mode:'native',model:'current',provider:'configured',baseUrl:'http://127.0.0.1:1234/v1'};
 await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE!,JSON.stringify({agents:{[agent.id]:current}}));
 setManualModelSelection(agent.id,true);const selected=manualModelPreference(agent.id)!;
 assert.equal(selected.model,current.model);assert.equal(selected.provider,current.provider);assert.equal(selected.baseUrl,current.baseUrl);
});

test('一候補の設定失敗で停止せず次へ進み、過去に失敗した先頭候補だけへ固着しない',async t=>{
 const {agent,deps}=await fixture(t);agent.id='opencode';
 const models=Array.from({length:5},(_,index)=>`opencode/candidate-${index}-free`);deps.discover=async()=>models;
 let now=Date.now();deps.now=()=>now;const applied:string[]=[];
 deps.configure=async(_id,_mode,model,apply)=>{if(apply){applied.push(model);if(model===models[0])throw Error('設定失敗')}return{fingerprint:'fixture',changedFiles:[]}};
 deps.run=async command=>command.args.includes(models[4])?'WENTIAN_CONNECTION_OK_OPENCODE':'失敗';
 const first=await maintainAgentConnection(agent,undefined,deps);assert.equal(first.status,'failed');assert.equal(applied.length,4);
 now+=61000;const second=await maintainAgentConnection(agent,first,deps);assert.equal(second.status,'verified');assert.equal(second.model,models[4]);assert.equal(applied.at(-1),models[4]);
});

for(const manual of[false,true])test(`${manual?'手動固定は変更せず':'自動選択は別モデルへ移って'}接続後の実作業・受入まで検証する`,async t=>{
 const {agent}=await fixture(t);if(manual)saveModelPreference(agent.id,{manual:true,source:'other',mode:'native',model:'first',selectedAt:''});
 let connections=0;const checked:string[]=[],available:string[]=[];
 const result=await maintainAgentConnections([agent],async update=>{if(update.state==='available')available.push(update.connection!.model)},undefined,{autoInstall:false,admit:async()=>{},resources:async()=>({cpu:10,memory:10,network:10,disk:10}),
  connect:async(_agent,previous,deps)=>{
   const model=++connections===1?'first':'second';if(connections===2){assert.ok(deps?.skipCandidates?.includes(connectionCandidateKey(previous!)));assert.equal(previous!.attempts!.at(-1)!.phase,'work')}
   return{model,mode:'native',status:'verified',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:model,policyHash:'fixture',cliVersion:agent.version};
  },
  work:async value=>{
   checked.push(value.connection!.model);const passed=value.connection!.model==='second';
   const evidence:AgentWorkEvidence={revision:1,identity:workIdentity(value.connection!,agent.version),status:passed?'passed':'failed',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),retryAt:new Date(Date.now()+60000).toISOString(),capabilities:passed?{reading:true,coding:true,testing:true,verification:true}:{},evidenceDirectory:'isolated',reason:'隔離試験の検収結果'};
   await writeFile(process.env.WENTIAN_AGENT_WORK_CACHE!,JSON.stringify({version:1,agents:{[agent.id]:evidence}}));return evidence;
  }});
 assert.equal(connections,manual?1:2);assert.deepEqual(checked,manual?['first']:['first','second']);assert.deepEqual(available,manual?[]:['second']);assert.equal(result[0].state,manual?'needs_recheck':'available');
 assert.equal(readAgentConnections()[agent.id].model,manual?'first':'second');
});

test('プロバイダーまたは接続先の変更は同じモデル名でも作業合格を引き継がない',()=>{
 const connection:AgentConnection={mode:'native',model:'same',provider:'a',baseUrl:'http://127.0.0.1:1234/v1',status:'verified',checkedAt:'',expiresAt:'',fingerprint:'same',policyHash:'same'};
 assert.notEqual(workIdentity(connection),workIdentity({...connection,provider:'b'}));assert.notEqual(workIdentity(connection),workIdentity({...connection,baseUrl:'http://127.0.0.1:11434/v1'}));
});

test('旧モデルの設定を読めなくても別の実在候補から復旧する',async t=>{
 const {agent,deps}=await fixture(t);deps.native=async()=>[{model:'configured',provider:'native'}];
 deps.configure=async(_id,_mode,model)=>{if(model==='local-model')throw Error('旧設定が不正');return{fingerprint:'new',changedFiles:[]}};
 const result=await maintainAgentConnection(agent,undefined,deps);assert.equal(result.status,'verified');assert.equal(result.model,'configured');assert.ok(result.discoveryWarning);
});

test('保守中の固定設定変更を古い接続結果で上書きせず、実作業を開始しない',async t=>{
 const {agent}=await fixture(t);let work=0;
 await maintainAgentConnections([agent],undefined,undefined,{autoInstall:false,admit:async()=>{},resources:async()=>({cpu:10,memory:10,network:10,disk:10}),connect:async()=>{
  saveModelPreference(agent.id,{manual:true,source:'other',mode:'native',model:'new-choice',selectedAt:'new'});
  return{mode:'native',model:'old-result',status:'verified',checkedAt:'',expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:'old',policyHash:'old'};
 },work:async()=>{work++;throw Error('古いモデルの実作業を開始してはいけません');}});
 assert.equal(work,0);assert.equal(readAgentConnections()[agent.id],undefined);
});

test('期限内の接続でも保守方針・CLI版が変われば再接続する',async t=>{
 const {agent}=await fixture(t);
 const connection:AgentConnection={mode:'native',model:'existing',status:'verified',checkedAt:'',expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:'old',policyHash:'old',cliVersion:'old'};
 await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE!,JSON.stringify({agents:{[agent.id]:connection}}));let calls=0;
 await maintainAgentConnections([agent],undefined,undefined,{autoInstall:false,verifyWork:false,admit:async()=>{},resources:async()=>({cpu:10,memory:10,network:10,disk:10}),connect:async()=>{calls++;return{...connection,policyHash:agentConnectionPolicyHash(agent.id),cliVersion:agent.version}}});
 assert.equal(calls,1);
 await maintainAgentConnections([agent],undefined,undefined,{autoInstall:false,verifyWork:false,admit:async()=>{},resources:async()=>({cpu:10,memory:10,network:10,disk:10}),connect:async()=>{throw Error('有効な接続は再利用します');}});
});

test('設定の並行変更を検出したら候補を切り替えず停止する',async t=>{
 const {agent,deps}=await fixture(t);deps.native=async()=>[{model:'first'},{model:'second'}];let applied=0;
 deps.configure=async(_id,_mode,_model,apply)=>{if(apply){applied++;throw Object.assign(Error('設定競合'),{diagnostic:'設定の並行変更を検出したため停止しました。'})}return{fingerprint:'fixture',changedFiles:[]}};
 const result=await maintainAgentConnection(agent,undefined,deps);assert.equal(result.status,'failed');assert.match(result.reason!,/並行変更/);assert.equal(applied,1);
});

test('候補一覧の取得中に停止された場合は設定適用を開始しない',async t=>{
 const {agent,deps}=await fixture(t);const controller=new AbortController();let applied=0;
 deps.native=async()=>{controller.abort();return[{model:'candidate'}]};deps.configure=async(_id,_mode,_model,apply)=>{if(apply)applied++;return{fingerprint:'fixture',changedFiles:[]}};
 await assert.rejects(maintainAgentConnection(agent,undefined,deps,controller.signal));assert.equal(applied,0);
});

test('接続待ちの時間枠は候補ごとに延長せず、未試行候補を次回へ残す',async t=>{
 const {agent,deps}=await fixture(t);deps.native=async()=>[{model:'first'},{model:'second'}];let now=Date.now(),calls=0;deps.now=()=>now;
 deps.run=async(_command,options)=>{calls++;assert.equal(options.timeoutMs,180000);now+=180001;throw Error('timeout')};
 const result=await maintainAgentConnection(agent,undefined,deps);assert.equal(result.status,'failed');assert.equal(calls,1);assert.equal(result.attempts?.length,1);assert.match(result.reason!,/時間枠/);
});

test('接続失敗中のAgentを先に復旧し、CLI導入の対応待ちも最終結果へ保持する',async t=>{
 const {agent}=await fixture(t),healthy={...agent,id:'codex'},missing={...agent,id:'ollama',liveState:'not_installed' as const};
 const connected:AgentConnection={mode:'native',model:'existing',status:'verified',checkedAt:'',expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:'existing',policyHash:'old'};
 await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE!,JSON.stringify({agents:{codex:connected}}));const order:string[]=[];
 const result=await maintainAgentConnections([healthy,missing,agent],undefined,undefined,{verifyWork:false,admit:async()=>{},resources:async()=>({cpu:10,memory:10,network:10,disk:10}),
 install:async value=>value.id==='ollama'?{...value,installation:{status:'manual_required',attempts:1,checkedAt:'',reason:'未導入の前提条件'},stateLabel:'CLI導入に対応が必要',note:'未導入の前提条件'}:value,
 connect:async value=>{order.push(value.id);return{...connected,cliVersion:value.version,policyHash:agentConnectionPolicyHash(value.id)}}});
 assert.deepEqual(order,['goose','codex']);assert.equal(result.find(value=>value.id==='ollama')?.installation?.status,'manual_required');assert.equal(result.find(value=>value.id==='ollama')?.note,'未導入の前提条件');
});
