import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { MAINTENANCE_EXECUTION } from './maintenance-execution.js';
import { maintenanceWorkspaces } from './maintenance-workspaces.js';
import { beginGovernedExecution, configureDefaultExecution, createProjectExecutionScope, executionAccessSummary, executionTargetsDigest, grantProjectExecution, initializeExecutionAccess, readExecutionGrants, revokeExecution, revokeProjectExecution } from './execution-governance.js';
import { setAgentExclusion } from './agent-exclusion-policy.js';
import { runExternalCommand } from './external-orchestrator.js';
import { registerExecutionGovernance } from './execution-governance-routes.js';

// 許可の保存・実プロセス・リンクの試験をすべて専用一時領域へ分離し、利用者の設定と外部モデルは変更しません。
async function setup(t:any){
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-default-access-'));
  const env={WENTIAN_EXECUTION_POLICY_FILE:path.join(root,'policy.json'),WENTIAN_EXECUTION_AUDIT_FILE:path.join(root,'audit.jsonl'),WENTIAN_DEFAULT_MAINTENANCE_ACCESS:'true',WENTIAN_CONNECTION_WORKSPACE_ROOT:path.join(root,'connection'),WENTIAN_AGENT_WORK_CACHE:path.join(root,'work/capabilities.json'),WENTIAN_AGENT_CONNECTION_CACHE:path.join(root,'connections.json'),WENTIAN_AGENT_EXCLUSIONS_FILE:path.join(root,'exclusions.json'),WENTIAN_AGENT_REGISTRATIONS_FILE:path.join(root,'registrations.json'),WENTIAN_MAINTENANCE_CONTROLS_FILE:path.join(root,'controls.json')};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  for(const directory of [...Object.values(maintenanceWorkspaces()),path.join(root,'project'),path.join(root,'copy'),path.join(root,'outside')])await mkdir(directory,{recursive:true});
  await writeFile(env.WENTIAN_AGENT_CONNECTION_CACHE,JSON.stringify({agents:{opencode:{model:'configured-a',provider:'provider-a',baseUrl:'https://a.invalid/v1',mode:'native'},kilo:{model:'configured-b',provider:'provider-b',baseUrl:'https://b.invalid/v1',mode:'native'}}}));
  return root;
}
const command={args:['run','実行本文は監査へ保存しない']};
const runMaintenance=(cwd:string)=>beginGovernedExecution(command,{agent:'opencode',cwd,maintenanceToken:MAINTENANCE_EXECUTION});

test('新規環境は専用2領域の保守を既定で許可し、Agent別・期限付き許可を作らない',async t=>{
  await setup(t);await initializeExecutionAccess();
  assert.equal(executionAccessSummary().maintenanceDefault,true);assert.deepEqual(readExecutionGrants(),[]);
  for(const cwd of Object.values(maintenanceWorkspaces())){const run=await runMaintenance(cwd);await run.complete(true);}
  const audit=await readFile(process.env.WENTIAN_EXECUTION_AUDIT_FILE!,'utf8');assert.match(audit,/"authorization":"maintenance"/);assert.doesNotMatch(audit,/実行本文/);
});

test('保守フラグの偽装・専用領域外・Temp全体・リンク先を既定許可に含めない',async t=>{
  const root=await setup(t),cwd=maintenanceWorkspaces().connection;
  await assert.rejects(beginGovernedExecution(command,{agent:'opencode',cwd}));
  await assert.rejects(beginGovernedExecution(command,{agent:'opencode',cwd,maintenanceToken:Symbol('Wentian保守専用実行') as any}));
  await assert.rejects(runMaintenance(path.join(root,'outside')));
  const previous=process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT;process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT=os.tmpdir();await assert.rejects(runMaintenance(root));process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT=previous;
  const link=path.join(cwd,'outside-link');await symlink(path.join(root,'outside'),link,process.platform==='win32'?'junction':'dir');await assert.rejects(runMaintenance(link));
});

test('旧期限付き許可が切れていても既定の保守だけは実行できる',async t=>{
  await setup(t);await writeFile(process.env.WENTIAN_EXECUTION_POLICY_FILE!,JSON.stringify({version:1,grants:[{agent:'opencode',root:maintenanceWorkspaces().connection,shareContext:true,allowHostAccount:true,expiresAt:'2020-01-01T00:00:00Z',revision:'legacy',actor:'fixture',connectionDigest:'old'}]}));
  const run=await runMaintenance(maintenanceWorkspaces().connection);await run.complete(true);
  assert.equal(readExecutionGrants()[0].expiresAt,'2020-01-01T00:00:00Z');
});

test('旧取消履歴を移行して既定許可で復活させず、明示復元まで停止する',async t=>{
  await setup(t);await writeFile(process.env.WENTIAN_EXECUTION_POLICY_FILE!,JSON.stringify({version:1,grants:[]}));
  await writeFile(process.env.WENTIAN_EXECUTION_AUDIT_FILE!,JSON.stringify({event:'revoke',agent:'opencode',actor:'fixture'})+'\n');
  await initializeExecutionAccess();assert.ok(executionAccessSummary().revokedAgents.includes('opencode'));
  await assert.rejects(runMaintenance(maintenanceWorkspaces().connection));
  await configureDefaultExecution({agent:'opencode',restore:true},'fixture');const run=await runMaintenance(maintenanceWorkspaces().connection);await run.complete(true);
});

test('取消と一時停止は別々に保持し、既定許可の実行中にも取消を反映する',async t=>{
  await setup(t);const cwd=maintenanceWorkspaces().connection;
  const run=await runMaintenance(cwd);await revokeExecution('opencode','fixture');assert.equal(run.signal?.aborted,true);await run.complete(false);
  await setAgentExclusion('opencode',true,'fixture');await configureDefaultExecution({agent:'opencode',restore:true},'fixture');await assert.rejects(runMaintenance(cwd));
  await setAgentExclusion('opencode',false,'fixture');const resumed=await runMaintenance(cwd);await resumed.complete(true);
});

test('既定設定・環境禁止・上位保守設定・破損台帳を迂回しない',async t=>{
  await setup(t);const cwd=maintenanceWorkspaces().connection;
  await configureDefaultExecution({maintenance:false},'fixture');await assert.rejects(runMaintenance(cwd));
  await configureDefaultExecution({maintenance:true},'fixture');process.env.WENTIAN_DEFAULT_MAINTENANCE_ACCESS='false';await assert.rejects(runMaintenance(cwd));process.env.WENTIAN_DEFAULT_MAINTENANCE_ACCESS='true';
  await writeFile(process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE!,JSON.stringify({connection:false}));await assert.rejects(runMaintenance(cwd));await writeFile(process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE!,JSON.stringify({connection:true}));
  await writeFile(process.env.WENTIAN_EXECUTION_POLICY_FILE!,'broken');await assert.rejects(runMaintenance(cwd));
});

test('プロジェクト設定は複数Agentで共用しモデル変更では失効せず、接続先変更は拒否する',async t=>{
  const root=await setup(t),cwd=path.join(root,'project');
  await assert.rejects(beginGovernedExecution(command,{agent:'opencode',cwd}));
  const grant=await grantProjectExecution({root:cwd,shareContext:true,allowHostAccount:true,expectedTargetsDigest:executionTargetsDigest()},'fixture');assert.equal((grant as any).expiresAt,undefined);
  for(const agent of ['opencode','kilo']){const run=await beginGovernedExecution(command,{agent,cwd});await run.complete(true);}
  const before=executionTargetsDigest(),connections=JSON.parse(await readFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE!,'utf8'));connections.agents.opencode.model='another-model';await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE!,JSON.stringify(connections));assert.equal(executionTargetsDigest(),before);
  const changedModel=await beginGovernedExecution(command,{agent:'opencode',cwd});await changedModel.complete(true);
  connections.agents.opencode.baseUrl='https://new.invalid/v1';await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE!,JSON.stringify(connections));await assert.rejects(beginGovernedExecution(command,{agent:'opencode',cwd}));
  await assert.rejects(grantProjectExecution({root:cwd,shareContext:true,allowHostAccount:true,expectedTargetsDigest:before},'fixture'));
});

test('プロジェクトの許可はホストが作ったコピーだけに継承し、任意のTemp指定や兄弟領域へ広げない',async t=>{
  const root=await setup(t),source=path.join(root,'project'),copy=path.join(root,'copy');
  await grantProjectExecution({root:source,shareContext:true,allowHostAccount:true,expectedTargetsDigest:executionTargetsDigest()},'fixture');
  await assert.rejects(beginGovernedExecution(command,{agent:'opencode',cwd:copy,projectScope:{source,directory:copy}}));
  const scope=createProjectExecutionScope(source,copy),run=await beginGovernedExecution(command,{agent:'opencode',cwd:copy,projectScope:scope});await run.complete(true);
  await assert.rejects(beginGovernedExecution(command,{agent:'opencode',cwd:path.join(root,'outside'),projectScope:scope}));
});

test('プロジェクト取消が実行中と次回起動へ反映され、別のプロジェクトを変更しない',async t=>{
  const root=await setup(t),cwd=path.join(root,'project');
  const grant=await grantProjectExecution({root:cwd,shareContext:true,allowHostAccount:true,expectedTargetsDigest:executionTargetsDigest()},'fixture');
  const run=await beginGovernedExecution(command,{agent:'opencode',cwd});await revokeProjectExecution(grant.id,'fixture');
  await new Promise<void>((resolve,reject)=>{if(run.signal?.aborted)return resolve();const timer=setTimeout(()=>reject(new Error('取消が届きません。')),2000);run.signal!.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
  await run.complete(false);await assert.rejects(beginGovernedExecution(command,{agent:'opencode',cwd}));
});

test('既定の保守許可で実プロセスを起動し、専用領域に成果物を保存して監査する',async t=>{
  await setup(t);const cwd=maintenanceWorkspaces().connection;
  const output=await runExternalCommand({executable:process.execPath,args:['-e',"require('fs').writeFileSync('result.json',JSON.stringify({ok:true}));console.log('専用領域の実行を確認しました。')"]},{agent:'opencode',role:'connection-probe',cwd,timeoutMs:5000,maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION});
  assert.match(output,/実行を確認/);assert.equal(JSON.parse(await readFile(path.join(cwd,'result.json'),'utf8')).ok,true);assert.deepEqual(readExecutionGrants(),[]);
});

test('管理APIから一度のプロジェクト許可と既定設定を保存し、認可・Origin・未知項目を検証する',async t=>{
  const root=await setup(t),app=Fastify();let changes=0;
  registerExecutionGovernance(app,{workspace:path.join(root,'project'),authorize:req=>req.headers.authorization==='fixture',identity:req=>req.headers.authorization==='fixture'?'fixture':undefined,onAccessChange:()=>{changes++;}});
  const send=(url:string,payload:Record<string,unknown>,headers:any={authorization:'fixture'},method:any='POST')=>app.inject({method,url,payload,headers});
  try{
    assert.equal((await send('/api/execution-permissions/projects',{},{})).statusCode,403);
    assert.equal((await send('/api/execution-permissions/defaults',{maintenance:false},{authorization:'fixture',origin:'https://outside.invalid'},'PUT')).statusCode,403);
    assert.equal((await send('/api/execution-permissions/defaults',{maintenance:true,actor:'forged'},undefined,'PUT')).statusCode,400);
    assert.equal((await send('/api/execution-permissions/defaults',{maintenance:true},undefined,'PUT')).statusCode,200);
    assert.equal((await send('/api/execution-permissions/projects',{root:path.join(root,'project'),shareContext:true,allowHostAccount:true,expectedTargetsDigest:executionTargetsDigest()})).statusCode,200);assert.equal(changes,2);
    const state=(await app.inject({url:'/api/execution-permissions',headers:{authorization:'fixture'}})).json();assert.equal(state.access.projects.length,1);assert.equal(state.access.maintenanceDefault,true);
  }finally{await app.close();}
});
