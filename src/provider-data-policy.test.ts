import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchWithClientAbort } from './proxy.js';
import { providerAuditPath,providerPolicyPath,providerDataSummary,providerOrigin,providerTargetDigest,setProviderDataBlocked } from './provider-data-policy.js';
import Fastify from 'fastify';
import { registerExecutionGovernance } from './execution-governance-routes.js';

// 実際のHTTP・SSEもループバックだけを使用し、本番のProviderや認証を変更しません。
const root=await mkdtemp(path.join(os.tmpdir(),'wentian-provider-data-'));
process.env.WENTIAN_PROVIDER_DATA_POLICY_FILE=path.join(root,'policy.json');process.env.WENTIAN_PROVIDER_DATA_AUDIT_FILE=path.join(root,'audit.jsonl');
let requests=0;
const server=createServer((req,res)=>{requests++;if(req.url==='/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');const timer=setInterval(()=>res.write('data: next\n\n'),50);res.on('close',()=>clearInterval(timer));}else{res.setHeader('content-type','application/json');res.end('{"ok":true}');}});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`,provider={id:'fixture',baseUrl,scope:'local' as const};
const transfer={provider:provider.id,model:'fixture-model',scope:'local' as const,action:'/v1/chat/completions'};
after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});

test('実HTTPの本文を保存せず、停止後はネットワーク起動前に拒否する',async()=>{
  const response=await fetchWithClientAbort(baseUrl,{method:'POST',body:'private business body'},{transfer});assert.deepEqual(await response.json(),{ok:true});
  const audit=await readFile(providerAuditPath(),'utf8');assert.equal(audit.includes('private business body'),false);assert.match(audit,/bodyDigest/);
  const count=requests;await setProviderDataBlocked(provider,true,providerTargetDigest(provider),'admin');
  await assert.rejects(fetchWithClientAbort(baseUrl,{method:'POST',body:'never send'},{transfer}),/停止/);assert.equal(requests,count);
  await assert.rejects(setProviderDataBlocked({...provider,baseUrl:baseUrl+'/changed'},false,providerTargetDigest(provider),'admin'),/入力/);
});

test('SSEヘッダー受信後も取消が上流へ伝播し、活動記録を終了する',async()=>{
  await setProviderDataBlocked(provider,false,providerTargetDigest(provider),'admin');
  const response=await fetchWithClientAbort(baseUrl+'/stream',{method:'POST',body:'stream request'},{transfer,timeoutMs:3000}),reader=response.body!.getReader();
  assert.ok((await reader.read()).value?.byteLength);
  await setProviderDataBlocked(provider,true,providerTargetDigest(provider),'admin');
  await assert.rejects(reader.read());
  assert.equal((providerDataSummary([provider]) as any).providers[0].active,0);
});

test('破損台帳を許可扱いにせず、URL認証情報・クエリも公開しない',async()=>{
  await writeFile(providerPolicyPath(),'invalid');const count=requests;
  await assert.rejects(fetchWithClientAbort(baseUrl,{method:'POST',body:'never send'},{transfer}),/停止/);assert.equal(requests,count);
  assert.equal(providerOrigin('https://user:secret@example.invalid/v1?token=hidden'),'https://example.invalid');
  await writeFile(providerPolicyPath(),JSON.stringify({version:1,blocked:{}}));
});

test('管理APIは認証・Origin・接続先スナップショットを検査する',async()=>{
  const app=Fastify();registerExecutionGovernance(app,{workspace:root,providers:()=>[provider],authorize:req=>req.headers.authorization==='admin',identity:req=>req.headers.authorization==='admin'?'admin':undefined});
  try{
    const url='/api/execution-permissions/providers/fixture';
    assert.equal((await app.inject({method:'POST',url,payload:{blocked:true,targetDigest:providerTargetDigest(provider)}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url,headers:{authorization:'admin',origin:'https://evil.invalid'},payload:{blocked:true,targetDigest:providerTargetDigest(provider)}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url,headers:{authorization:'admin'},payload:{blocked:true,targetDigest:'stale'}})).statusCode,400);
    assert.equal((await app.inject({method:'POST',url,headers:{authorization:'admin'},payload:{blocked:true,targetDigest:providerTargetDigest(provider)}})).statusCode,200);
  }finally{await app.close();}
});
