import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMaintenanceModelReady, MaintenanceModelDeferred } from './maintenance-model-admission.js';
import { maintainAgentConnection, maintainAgentConnections, connectionStatusUpdate } from './agent-connection-maintenance.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runHostedAgent } from './hosted-model-agent.js';
import { parseProviderFile } from './config.js';
import { ExecutionDenied } from './execution-governance.js';

const connection={mode:'native' as const,model:'installed-model',baseUrl:'http://127.0.0.1:1234/v1'};
test('Gateway経由の遠隔モデルをGateway自身のローカルモデルと誤認しない',async()=>{
  const providers=()=>parseProviderFile([{id:'remote-test',baseUrl:'https://inference.example/v1',scope:'remote'}]);
  await assertMaintenanceModelReady('claude',{mode:'local',source:'wentian',model:'remote-test/model',baseUrl:'http://127.0.0.1:8787/v1'},undefined,async()=>assert.fail('遠隔モデルのロード確認は不要です'),providers);
});
test('Gatewayの管理画面で登録した有効プロバイダーをGETだけで解決する',async()=>{
  const value={mode:'local' as const,source:'wentian' as const,model:'remote-test/model',baseUrl:'http://127.0.0.1:8787/v1'};
  for (const enabled of [true,false]) {
    const run=assertMaintenanceModelReady('claude',value,undefined,(async(url,init)=>{
      assert.equal(String(url),'http://127.0.0.1:8787/v1/providers');
      assert.equal(init?.method || 'GET','GET');
      return Response.json({providers:parseProviderFile([{id:'remote-test',baseUrl:'https://inference.example/v1',enabled}])});
    }) as typeof fetch);
    if(enabled) await run; else await assert.rejects(run,MaintenanceModelDeferred);
  }
});
test('Gateway経由のローカルモデルは実接続先とプロバイダー内モデルIDで確認する',async()=>{
  const providers=()=>parseProviderFile([{id:'local-test',baseUrl:'http://127.0.0.1:1234/v1',scope:'local'}]);
  const value={mode:'local' as const,source:'wentian' as const,model:'local-test/model',baseUrl:'http://127.0.0.1:8787/v1'};
  await assertMaintenanceModelReady('claude',value,undefined,(async(url)=>{
    assert.equal(String(url),'http://127.0.0.1:1234/api/v1/models');
    return Response.json({models:[{key:'model',loaded_instances:[{id:'active'}]}]});
  }) as typeof fetch,providers);
  await assert.rejects(assertMaintenanceModelReady('claude',value,undefined,(async()=>Response.json({models:[]})) as typeof fetch,providers),MaintenanceModelDeferred);
  await assert.rejects(assertMaintenanceModelReady('claude',value,undefined,async()=>assert.fail('未登録の接続先へ問い合わせません'),()=>[]),MaintenanceModelDeferred);
});
test('未ロード・形式不明・到達不能ではGET確認だけで推論を許可しない',async()=>{
  for(const payload of [{models:[{key:'installed-model',loaded_instances:[]}]},{data:[{id:'installed-model'}]},undefined]){
    const requests:Array<{path:string;method:string}>=[];
    await assert.rejects(assertMaintenanceModelReady('lmstudio',connection,undefined,(async(url,init)=>{
      requests.push({path:new URL(String(url)).pathname,method:init?.method||'GET'});
      if(!payload)throw Error('接続不可');return Response.json(payload);
    }) as typeof fetch),MaintenanceModelDeferred);
    assert.deepEqual(requests,[{path:'/api/v1/models',method:'GET'}]);
  }
});
test('モデルが導入済みでもロード済みの別モデルへ合格を流用しない',async()=>{
  const request=(async()=>Response.json({models:[{key:'different',loaded_instances:[{id:'active'}]}]})) as typeof fetch;
  await assert.rejects(assertMaintenanceModelReady('lmstudio',connection,undefined,request),MaintenanceModelDeferred);
});
test('LM Studioのロード済みインスタンスとOllamaの実行中モデルだけを許可する',async()=>{
  await assertMaintenanceModelReady('lmstudio',connection,undefined,(async()=>Response.json({models:[{key:connection.model,loaded_instances:[{id:'active'}]}]})) as typeof fetch);
  await assertMaintenanceModelReady('ollama',{...connection,baseUrl:'http://127.0.0.1:11434'},undefined,(async(url)=>{
    assert.equal(new URL(String(url)).pathname,'/api/ps');
    return Response.json({models:[{name:connection.model}]});
  }) as typeof fetch);
});
test('未ロード時は設定適用・CLI推論を行わず保留理由を表示する',async()=>{
  const agent={id:'lmstudio',name:'LM Studio',state:'needs_recheck' as const,stateLabel:'未確認',note:'',freshWithin24Hours:true,liveState:'healthy' as const,version:'fixture'};
  let applied=0,executed=0;
  const result=await maintainAgentConnection(agent,undefined,{
    configure:async(_agent,_mode,_model,apply)=>{if(apply)applied++;return{fingerprint:'fixture',changedFiles:[]};},
    discover:async()=>[],native:async()=>[{model:connection.model}],localBases:()=>[],
    run:async()=>{executed++;throw Error('未ロード時は推論禁止');},
    admit:async(id,value,signal)=>assertMaintenanceModelReady(id,value,signal,(async()=>Response.json({models:[]})) as typeof fetch),
  });
  assert.equal(applied,0);assert.equal(executed,0);
  assert.equal(result.status,'pending');assert.equal(result.maintenanceDeferred,true);
  assert.equal(result.maintenanceDeferredKind,'model');
  assert.equal(result.attempts?.length,0,'未実行の推論を失敗履歴へ記録しません');
  assert.equal(connectionStatusUpdate(agent,result).stateLabel,'ローカルモデル未ロード・保守保留');
});
test('接続確認後にモデルが退避されたら作業検証を起動しない',async()=>{
  let work=0;
  const agent={id:'lmstudio',name:'LM Studio',state:'needs_recheck' as const,stateLabel:'未確認',note:'',freshWithin24Hours:true,liveState:'healthy' as const,version:'fixture'};
  const result=await maintainAgentConnections([agent],undefined,undefined,{
    autoInstall:false,resources:async()=>({cpu:10,memory:10,disk:10,network:10}),
    connect:async()=>({...connection,status:'verified',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:'fixture',policyHash:'fixture'}),
    admit:async()=>{throw new MaintenanceModelDeferred();},
    work:async()=>{work++;assert.fail('モデル退避後の作業起動は禁止');},
  });
  assert.equal(work,0);assert.equal(result[0].connection?.status,'pending');
  assert.equal(result[0].connection?.maintenanceDeferredKind,'model');
  assert.equal(result[0].stateLabel,'ローカルモデル未ロード・保守保留');
});
test('作業検証の実行許可不足をモデル未ロードと混同せず表示する',async()=>{
  let work=0;
  const agent={id:'lmstudio',name:'LM Studio',state:'needs_recheck' as const,stateLabel:'未確認',note:'',freshWithin24Hours:true,liveState:'healthy' as const,version:'fixture'};
  const result=await maintainAgentConnections([agent],undefined,undefined,{
    autoInstall:false,resources:async()=>({cpu:10,memory:10,disk:10,network:10}),
    connect:async()=>({...connection,status:'verified',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:'fixture',policyHash:'fixture'}),
    admit:async()=>{},
    work:async()=>{work++;throw new ExecutionDenied();},
  });
  assert.equal(work,1);assert.equal(result[0].connection?.status,'pending');
  assert.equal(result[0].connection?.maintenanceDeferredKind,'permission');
  assert.equal(result[0].stateLabel,'実行許可待ち・保守保留');
});
test('保守用のHostedランナー自身も未ロード時は推論POSTを送らない',async()=>{
  const workspace=await mkdtemp(path.join(os.tmpdir(),'wentian-no-cold-load-'));
  const previousFlag=process.env.WENTIAN_MAINTENANCE_LOADED_ONLY,previousFetch=globalThis.fetch;
  process.env.WENTIAN_MAINTENANCE_LOADED_ONLY='true';
  const methods:string[]=[];
  globalThis.fetch=(async(_url,init)=>{methods.push(init?.method||'GET');return Response.json({models:[]});}) as typeof fetch;
  try{
    await assert.rejects(runHostedAgent({agent:'lmstudio',model:connection.model,baseUrl:connection.baseUrl,workspace,role:'conversation',objective:'隔離試験'}),MaintenanceModelDeferred);
    assert.deepEqual(methods,['GET']);
  }finally{
    globalThis.fetch=previousFetch;
    if(previousFlag===undefined)delete process.env.WENTIAN_MAINTENANCE_LOADED_ONLY;else process.env.WENTIAN_MAINTENANCE_LOADED_ONLY=previousFlag;
  }
});
test('確認中に中断されたら推論を許可しない',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(assertMaintenanceModelReady('lmstudio',connection,controller.signal,async()=>assert.fail('中断後の取得禁止')));
});


test('Ollamaが明示したクラウドモデルはローカル未ロードで保留しない',async()=>{
  for(const agent of ['ollama','kilo']) {
    const requests:string[]=[];
    await assertMaintenanceModelReady(agent,{mode:'native',model:'remote-model',baseUrl:'http://127.0.0.1:11434'},undefined,(async(url,init)=>{
      assert.equal(init?.method||'GET','GET');const route=new URL(String(url)).pathname;requests.push(route);
      return Response.json({models:route==='/api/tags'?[{name:'remote-model',remote_host:'https://provider.example',remote_model:'real-model'}]:[]});
    }) as typeof fetch);
    assert.ok(requests.includes('/api/tags'));
  }
});

test('cloudという名前だけ・不明な遠隔メタデータではコールドロードを許可しない',async()=>{
  for(const metadata of [{},{remote_host:'http://127.0.0.1:1234',remote_model:'model'},{remote_host:'https://user:secret@provider.example',remote_model:'model'},{remote_host:'https://provider.example'}]) {
    await assert.rejects(assertMaintenanceModelReady('ollama',{mode:'native',model:'model:cloud'},undefined,(async(url)=>Response.json({models:new URL(String(url)).pathname==='/api/tags'?[{name:'model:cloud',...metadata}]:[]})) as typeof fetch),MaintenanceModelDeferred);
  }
});
