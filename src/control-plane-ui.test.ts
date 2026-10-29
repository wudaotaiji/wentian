import test from 'node:test';
import assert from 'node:assert/strict';
import { Window, HTMLButtonElement } from 'happy-dom';
import { managerDashboardHtml } from './dashboard.js';
import { controlPlaneFeatures, readControlPlaneEvidence } from './control-plane-status.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** 認証・画面遷移・管理操作をDOM（Document Object Model）上で通し、JSONの静的文字列だけでは合格させません。 */
test('対応状況から予熱・評価・検証証拠へ移動でき、管理操作は正しいモデルとIDを送る',async()=>{
 const window=new Window({url:'http://127.0.0.1:8787/#improvements'});window.setInterval=(()=>0) as any;
 const calls:Array<{url:string;body:any}>=[];
 window.fetch=(async(url:unknown,init:any={})=>{const address=String(url);let result:any={};
 if(init.method==='POST'){calls.push({url:address,body:JSON.parse(init.body)});result=address.endsWith('/benchmarks')?{data:[{task:'coding',accepted:true,latencyMs:50}]}:{status:'verified'};}
 else if(address.endsWith('/me'))result={user:{role:'admin',displayName:'管理者'}};
 else if(address.endsWith('/control-plane'))result={observedAt:new Date().toISOString(),...controlPlaneFeatures(true),evidence:{tests:[{name:'検証',complete:true,passed:163,failed:0,skipped:0}],benchmark:{samples:[{context:2048,ttftMs:220,loadMs:119,tokensPerSecond:22.5,residentVramBytes:0}]}},verifications:[{id:'task-1',status:'completed',roles:[{role:'builder',model:'model-a',success:true},{role:'verifier',model:'model-b',success:true}]}]};
 else if(address.endsWith('/residency'))result={enabled:true,managedModels:['ollama/test'],active:{'ollama/test':1}};
 else if(address.endsWith('/observations'))result={data:[{requestId:'request-1',model:'ollama/test',success:true,startedAt:new Date().toISOString()}]};
 else if(address.endsWith('/users'))result=[];
 else if(address.endsWith('/models'))result={data:[{id:'ollama/test',metadata:{resourceScope:'local'}}]};
 return new window.Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
 }) as any;
 const settle=async()=>{for(let i=0;i<35;i++)await new Promise<void>(r=>setImmediate(r))};
 try{window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g,''));for(const m of managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g))window.eval(m[1]);await settle();
 assert.match(window.document.getElementById('controlStatus')!.textContent!,/GPU実機検証/);
 assert.match(window.document.getElementById('controlEvidence')!.textContent!,/CPU動作/);
 assert.match(window.document.getElementById('verificationStatus')!.textContent!,/model-b/);
 window.document.querySelector<HTMLButtonElement>('[data-view="lifecycle"]')!.click();await settle();
 assert.equal(window.document.getElementById('residencyStatus')!.closest('.nav-view')!.hasAttribute('hidden'),false);
 window.document.getElementById('preloadForm')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle();
 assert.deepEqual(calls.find(x=>x.url.endsWith('/preload'))?.body,{model:'ollama/test',contextTokens:2048});
 window.document.getElementById('benchmarkForm')!.dispatchEvent(new window.Event('submit',{cancelable:true}));await settle();
 assert.match(window.document.getElementById('benchmarkResults')!.textContent!,/合格/);
 window.document.getElementById('evaluationForm')!.dispatchEvent(new window.Event('submit',{cancelable:true}));await settle();
 assert.deepEqual(calls.find(x=>x.url.endsWith('/evaluations'))?.body,{requestId:'request-1',accepted:true});
 }finally{await window.happyDOM.close()}
});

test('検証証拠は失敗・未完了を成功とせず、稼働設定と実装状態を分ける',async()=>{
 // 過去の実環境記録には依存せず、成功・失敗・未取得を一時資料で検査します。
 const root=await mkdtemp(path.join(tmpdir(),'wentian-public-evidence-'));
 try{
  const folder=path.join(root,'docs/evidence/20261006_control_plane');await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'full-tests-final.log'),'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ duration_ms 10\n');
  await writeFile(path.join(folder,'verify-powershell.log'),'ℹ tests 1\nℹ pass 0\nℹ fail 1\nℹ duration_ms 10\n');
  const evidence=await readControlPlaneEvidence(root);
  assert.equal(evidence.tests[0].failed,0);assert.equal(evidence.tests[0].complete,true);
  assert.equal(evidence.tests[1].failed,1);assert.equal(evidence.tests[2].complete,false);
 }finally{await rm(root,{recursive:true,force:true});}
 const disabled=controlPlaneFeatures(false).features.find(f=>f.id==='residency');assert.equal(disabled?.status,'無効');
 assert.equal(controlPlaneFeatures(true).features.find(f=>f.id==='residency')?.status,'有効');
 assert.equal(controlPlaneFeatures(true).features.find(f=>f.id==='gpu')?.status,'環境制約');
});
