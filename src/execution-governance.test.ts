import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { beginGovernedExecution, executionDisclosure, executionPolicyPath, executionAuditPath, grantExecution, revokeExecution, executionSummary, configureDefaultExecution } from './execution-governance.js';
import { registerExecutionGovernance } from './execution-governance-routes.js';
import { runExternalCommand } from './external-orchestrator.js';
import { connectionStorePath } from './agent-connection-policy.js';

// 本番の台帳・CLI・認証情報を使用せず、実プロセスの停止だけNodeで検証します。
const root=await mkdtemp(path.join(os.tmpdir(),'wentian-execution-policy-'));
process.env.WENTIAN_EXECUTION_POLICY_FILE=path.join(root,'policy.json');
process.env.WENTIAN_EXECUTION_AUDIT_FILE=path.join(root,'audit.jsonl');
const command={args:['exec','--sandbox','read-only','secret-request-never-log']};
after(()=>rm(root,{recursive:true,force:true}));

test('既定許可では登録済みAgentが追加条件なしでどこでも実行できる',async()=>{
  const run=await beginGovernedExecution(command,{agent:'codex',cwd:root});await run.complete(true);
  const yolo=await beginGovernedExecution({args:['--yolo']},{agent:'codex',cwd:root});await yolo.complete(true);
  const outside=await beginGovernedExecution(command,{agent:'codex',cwd:os.tmpdir()});await outside.complete(true);
  assert.equal((await readFile(executionAuditPath(),'utf8')).includes('secret-request-never-log'),false);
});

test('既定許可が無効な場合、作業場所外・ホスト実行を起動前に拒否する',async()=>{
  await configureDefaultExecution({maintenance:false},'admin');
  await assert.rejects(beginGovernedExecution(command,{agent:'codex',cwd:root}),/実行許可/);
  await grantExecution({agent:'codex',root,shareContext:true,allowHostAccount:false,hours:1},'admin');
  const run=await beginGovernedExecution(command,{agent:'codex',cwd:root});await run.complete(true);
  await assert.rejects(beginGovernedExecution({args:['--yolo']},{agent:'codex',cwd:root}),/実行許可/);
  await assert.rejects(beginGovernedExecution(command,{agent:'codex',cwd:os.tmpdir()}),/実行許可/);
  await configureDefaultExecution({maintenance:true},'admin');
});

test('取消は実行中のSignalを中断し、次の起動も拒否する',async()=>{
  const run=await beginGovernedExecution(command,{agent:'codex',cwd:root});
  await revokeExecution('codex','admin');assert.equal(run.signal?.aborted,true);await run.complete(false);
  await assert.rejects(beginGovernedExecution(command,{agent:'codex',cwd:root}),/実行許可/);
});

test('破損台帳は許可へ縮退せず、共通ランナーは副作用より前に拒否する',async()=>{
  await writeFile(executionPolicyPath(),'invalid');
  const marker=path.join(root,'must-not-exist');
  await assert.rejects(runExternalCommand({executable:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`]},{cwd:root,agent:'claude',role:'builder',timeoutMs:2000}),/実行許可/);
  await assert.rejects(readFile(marker));await writeFile(executionPolicyPath(),JSON.stringify({version:1,grants:[]}));
});

test('明示許可したNode試験プロセスを取消で停止する',async()=>{
  await grantExecution({agent:'claude',root,shareContext:true,allowHostAccount:true,hours:1},'admin');
  let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
  const run=runExternalCommand({executable:process.execPath,args:['-e',"console.log('fixture-ready');setInterval(()=>{},1000)"]},{cwd:root,agent:'claude',role:'builder',timeoutMs:10000,emit:()=>started()});
  // 拒否の観測を取消前に登録し、未処理Promiseを発生させません。
  const stopped=assert.rejects(run,/取り消|失効|停止/);
  await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('試験プロセスが起動しません。')),6000))]);
  await revokeExecution('claude','admin');await stopped;
  assert.equal((executionSummary() as any).agents.find((r:any)=>r.agent==='claude').active,0);
});

test('送信先URLのユーザー情報・クエリを公開せず、未知実行を沙箱と表示しない',()=>{
  const info=executionDisclosure({args:['--sandbox','read-only'],connection:{model:'model',baseUrl:'https://user:secret@example.invalid/v1?token=hidden'}},{agent:'claude',cwd:root});
  assert.equal(info.destination,'https://example.invalid');assert.equal(info.boundary,'host-account');
});

test('管理APIは未認証・外部Origin・本文のactor偽装を拒否する',async()=>{
  const app=Fastify();registerExecutionGovernance(app,{workspace:root,authorize:req=>req.headers.authorization==='test-admin',identity:req=>req.headers.authorization==='test-admin'?'admin':undefined});
  try{
    assert.equal((await app.inject({url:'/api/execution-permissions'})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/execution-permissions/grants',headers:{authorization:'test-admin',origin:'https://evil.invalid'},payload:{}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/execution-permissions/grants',headers:{authorization:'test-admin'},payload:{agent:'codex',root,shareContext:true,allowHostAccount:false,hours:1,actor:'forged'}})).statusCode,400);
    const snapshot=(await app.inject({url:'/api/execution-permissions',headers:{authorization:'test-admin'}})).json();
    const response=await app.inject({method:'POST',url:'/api/execution-permissions/grants',headers:{authorization:'test-admin'},payload:{agent:'codex',root,shareContext:true,allowHostAccount:false,hours:1,expectedConnectionDigest:snapshot.agents.find((a:any)=>a.agent==='codex').connectionDigest}});assert.equal(response.statusCode,200);
    assert.equal((await app.inject({url:'/execution-permissions',headers:{authorization:'test-admin'}})).statusCode,200);
  }finally{await app.close();}
});

test('モデル・送信先の変更で実行中の許可を失効し、古い確認画面からの許可を拒否する',async()=>{
  const original=process.env.WENTIAN_AGENT_CONNECTION_CACHE;process.env.WENTIAN_AGENT_CONNECTION_CACHE=path.join(root,'connections.json');
  const connection={model:'approved-model',provider:'configured',baseUrl:'https://approved.invalid/v1'};
  try{
    await writeFile(connectionStorePath(),JSON.stringify({agents:{codex:connection}}));
    const snapshot=(executionSummary() as any).agents.find((a:any)=>a.agent==='codex');
    await grantExecution({agent:'codex',root,shareContext:true,allowHostAccount:false,hours:1,expectedConnectionDigest:snapshot.connectionDigest},'admin');
    const execution=await beginGovernedExecution({...command,connection},{agent:'codex',cwd:root});
    const aborted=new Promise<void>((resolve,reject)=>{execution.signal!.addEventListener('abort',()=>resolve(),{once:true});const timeout=setTimeout(()=>reject(new Error('設定変更の中断が届きません。')),2000);timeout.unref();});
    await writeFile(connectionStorePath(),JSON.stringify({agents:{codex:{...connection,baseUrl:'https://changed.invalid/v1'}}}));
    await aborted;assert.equal(execution.signal?.aborted,true);await execution.complete(false);
    await assert.rejects(grantExecution({agent:'codex',root,shareContext:true,allowHostAccount:false,hours:1,expectedConnectionDigest:snapshot.connectionDigest},'admin'),/再確認/);
    await assert.rejects(beginGovernedExecution({...command,connection},{agent:'codex',cwd:root}),/実行許可/);
  }finally{if(original===undefined)delete process.env.WENTIAN_AGENT_CONNECTION_CACHE;else process.env.WENTIAN_AGENT_CONNECTION_CACHE=original;}
});


test('時間超過の停止結果に直前のCLI診断を保持し監査へ本文を保存しない',async()=>{
  await grantExecution({agent:'claude',root,shareContext:true,allowHostAccount:true,hours:1},'admin');
  await assert.rejects(runExternalCommand({executable:process.execPath,args:['-e',"console.error('fixture-upstream-diagnostic');setInterval(()=>{},1000)"]},{cwd:root,agent:'claude',role:'connection-probe',timeoutMs:1500}),(error:unknown)=>{
    const detail=error as Error&{diagnostic?:string;termination?:{verifiedStopped:boolean}};
    assert.match(detail.diagnostic||'',/fixture-upstream-diagnostic/);assert.equal(detail.termination?.verifiedStopped,true);return true;
  });
  assert.doesNotMatch(await readFile(executionAuditPath(),'utf8'),/fixture-upstream-diagnostic/);
});


test('再検証の許可は承認済みの終了期限を延長しない',async()=>{
  const expiresAt=new Date(Date.now()+300000).toISOString();
  const grant=await grantExecution({agent:'kilo',root,shareContext:true,allowHostAccount:true,hours:1,expiresAt},'admin');
  assert.equal(grant.expiresAt,expiresAt);
  await assert.rejects(grantExecution({agent:'kilo',root,shareContext:true,allowHostAccount:true,hours:1,expiresAt:'invalid'},'admin'));
});


test('隔離領域の子ランナーでも元のインストール領域の許可設定を参照する',async t=>{
 const previous=process.env.WENTIAN_INSTALL_ROOT;delete process.env.WENTIAN_INSTALL_ROOT;
 t.after(()=>{if(previous===undefined)delete process.env.WENTIAN_INSTALL_ROOT;else process.env.WENTIAN_INSTALL_ROOT=previous;});
 await grantExecution({agent:'ollama',root,shareContext:true,allowHostAccount:true,hours:1},'admin');
 const output=await runExternalCommand({executable:process.execPath,args:['-e','console.log(process.env.WENTIAN_INSTALL_ROOT)']},{cwd:root,agent:'ollama',role:'hosted-inference',timeoutMs:3000});
 assert.equal(output,process.cwd());
});
