import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { CloudRepository } from './personal-cloud/repository.js';
import { PersonalCloudService, signedPayload } from './personal-cloud/service.js';
import { validateSpec, rankNodes } from './personal-cloud/scheduler.js';
import { ContainerRuntime, waitHealthy } from './personal-cloud/runtime.js';
import { AppProxy } from './personal-cloud/proxy.js';
import { validateControlUrl, enrollNode, NodeAgent } from './personal-cloud/agent.js';
import { registerPersonalCloud } from './personal-cloud/routes.js';
import Fastify from 'fastify';
import WebSocket from 'ws';
import { AccessVerifier } from './personal-cloud/access.js';
import type { Capabilities } from './personal-cloud/types.js';

const spec={name:'検証アプリ',image:'example/app:1',containerPort:3000,healthPath:'/health',cpuCores:1,memoryBytes:536870912,engine:'docker' as const,gpuMemoryBytes:0,environment:{}};
const caps:Capabilities={os:'win32',arch:'x64',cpuCores:4,memoryBytes:4*1024**3,freeMemoryBytes:3*1024**3,observedAt:new Date().toISOString(),runtimes:[{engine:'docker',ready:true}],gpus:[],ai:[]};
function fixture(){const repository=new CloudRepository(':memory:'),service=new PersonalCloudService(repository),keys=generateKeyPairSync('ed25519');const c=service.issueCode('owner','検証PC');const {nodeId}=service.enroll(c.code,keys.publicKey.export({format:'pem',type:'spki'}).toString());service.approve('owner',nodeId);service.heartbeat(nodeId,caps);return {repository,service,nodeId,keys};}

test('登録コードは1回限り・承認待ち・所有者別で、署名の改変と再送を拒否する',()=>{
 const f=fixture();try{
  const code=f.service.issueCode('owner','別PC');const node=f.service.enroll(code.code,f.keys.publicKey.export({type:'spki',format:'pem'}).toString());
  assert.throws(()=>f.service.enroll(code.code,f.keys.publicKey.export({type:'spki',format:'pem'}).toString()),/無効/);
  assert.equal(f.service.snapshot('owner').nodes.find(n=>n.id===node.nodeId)!.approved,false);
  assert.equal(f.service.snapshot('other').nodes.length,0);assert.throws(()=>f.service.approve('other',f.nodeId),/存在/);
  const route='/api/personal-cloud/agent/heartbeat',timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex'),payload=caps;
  const signature=sign(null,Buffer.from(signedPayload(route,timestamp,nonce,payload)),f.keys.privateKey).toString('base64');
  assert.throws(()=>f.service.authenticate(route,{nodeId:f.nodeId,timestamp,nonce,signature,payload:{...payload,cpuCores:99}}),/署名/);
  f.service.authenticate(route,{nodeId:f.nodeId,timestamp,nonce,signature,payload});assert.throws(()=>f.service.authenticate(route,{nodeId:f.nodeId,timestamp,nonce,signature,payload}),/再利用/);
  f.service.revoke('owner',f.nodeId);assert.throws(()=>f.service.authenticate(route,{nodeId:f.nodeId,timestamp,nonce:randomBytes(16).toString('hex'),signature,payload}),/失効/);
 }finally{f.repository.close()}
});

test('CPU・RAMの予約と接続状態で配置し、同じ配備要求は同じジョブを返す',()=>{
 const f=fixture();try{
  const first=f.service.createApp('owner',{nodeId:f.nodeId,spec},'test-create-1');assert.equal(f.service.createApp('owner',{nodeId:f.nodeId,spec},'test-create-1').id,first.id);
  assert.throws(()=>f.service.createApp('owner',{nodeId:f.nodeId,spec:{...spec,name:'別の要求'}},'test-create-1'),/異なる/);
  assert.throws(()=>f.service.createApp('owner',{spec:{...spec,memoryBytes:4*1024**3}},'test-create-2'),/配置可能/);
  const candidates=rankNodes(f.repository.read().nodes,[],validateSpec(spec),'owner',Date.now()+100000);assert.equal(candidates[0].eligible,false);
  assert.throws(()=>validateSpec({...spec,volumes:['C:/']}),/未対応/);assert.equal(f.service.placement('owner',{...spec,gpuMemoryBytes:1024})[0].eligible,false);
  assert.throws(()=>validateSpec({...spec,environment:{API_TOKEN:'秘密'}}),/秘密/);
 }finally{f.repository.close()}
});

test('ジョブ実行権・結果・競合を検査し、削除要求を別所有者へ公開しない',()=>{
 const f=fixture();try{
  const created=f.service.createApp('owner',{spec},'test-create-1');const claimed=f.service.claim(f.nodeId).job!;
  assert.equal(claimed.id,created.id);assert.equal(f.service.claim(f.nodeId).job,null);
  assert.throws(()=>f.service.finish(f.nodeId,created.id,'違う実行権',{state:'ready'}),/一致/);
  f.service.finish(f.nodeId,created.id,claimed.lease!,{state:'ready',localUrl:'http://127.0.0.1:3001'});
  assert.throws(()=>f.service.action('other',created.appId,'stop',{revision:1},'test-stop-01'),/存在/);
  const stopping=f.service.action('owner',created.appId,'stop',{revision:1},'test-stop-01');assert.equal(stopping.action,'stop');
  assert.throws(()=>f.service.action('owner',created.appId,'start',{revision:1},'test-start-1'),/更新/);
  assert.equal(f.service.snapshot('owner').apps[0].desiredState,'stopped');assert.equal(f.service.snapshot('other').jobs.length,0);
 }finally{f.repository.close()}
});

test('管理APIは未認証・他オリジン・チームキーを拒否し、ノードは署名なしで実行できない',async()=>{
 const app=Fastify();registerPersonalCloud(app,{file:':memory:',authorize:(req,reply)=>{if(req.headers.authorization==='Bearer test-admin')return 'owner';reply.code(401).send({error:{message:'ログインが必要です。'}});return undefined;}});
 try{
  assert.equal((await app.inject('/api/personal-cloud')).statusCode,401);
  assert.equal((await app.inject({url:'/api/personal-cloud',headers:{authorization:'Bearer test-admin'}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/personal-cloud/codes',headers:{authorization:'Bearer test-admin',origin:'https://other.example'},payload:{name:'PC'}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/personal-cloud',headers:{authorization:'Bearer test-admin','x-team-virtual-key':'test'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/personal-cloud/agent/claim',payload:{}})).statusCode,401);
 }finally{await app.close()}
});

test('コンテナ操作は引数を分離し、ダイジェスト・ループバック・資源上限を指定する',async()=>{
 const calls:Array<{command:string;args:string[]}>=[];let exists=false;
 const digest='example/app@sha256:'+'a'.repeat(64);
 const runtime=new ContainerRuntime('docker',async(command,args)=>{calls.push({command,args});if(args[0]==='ps')return exists?'wentian-job_test':'';if(args[0]==='pull')return '';if(args[0]==='image')return JSON.stringify([{Os:'linux',Architecture:process.arch==='arm64'?'arm64':'amd64',RepoDigests:[digest]}]);if(args[0]==='run'){exists=true;return 'container'}if(args[0]==='inspect')return JSON.stringify([{Config:{Labels:{'io.wentian.app':'app_test'}},State:{Running:true},Image:'sha256:'+'a'.repeat(64),NetworkSettings:{Ports:{'3000/tcp':[{HostIp:'127.0.0.1',HostPort:'45678'}]}}}]);return '';});
 const deployed=await runtime.deploy('app_test','job_test',spec);assert.equal(deployed.port,45678);const args=calls.find(c=>c.args[0]==='run')!.args;
 assert.ok(args.includes('127.0.0.1::3000'));assert.ok(args.includes('--memory'));assert.ok(args.includes('--cpus'));assert.ok(args.includes('no-new-privileges'));assert.equal(args.at(-1),digest);
 await runtime.deploy('app_test','job_test',spec);assert.equal(calls.filter(c=>c.args[0]==='run').length,1);
});

test('正常性確認は連続成功を要求し、失敗をready扱いにしない',async()=>{
 let count=0;await waitHealthy(12345,'/health',{intervalMs:1,timeoutMs:100,fetcher:(async()=>new Response('',{status:++count===2?500:200})) as typeof fetch});assert.equal(count,5);
 await assert.rejects(waitHealthy(12345,'/health',{intervalMs:1,timeoutMs:10,fetcher:(async()=>new Response('',{status:500})) as typeof fetch}),/連続/);
});

test('アプリプロキシは停止状態と未知Hostを拒否し、管理ポートへ転送しない',async()=>{
 const proxy=new AppProxy();try{await proxy.listen();assert.throws(()=>proxy.switch(8787),/不正/);const response=await fetch('http://127.0.0.1:'+proxy.port);assert.equal(response.status,503);const {request}=await import('node:http');const status=await new Promise<number>(resolve=>{const r=request({hostname:'127.0.0.1',port:proxy.port,headers:{host:'unknown.example'}},res=>{res.resume();resolve(res.statusCode!)});r.end()});assert.equal(status,404);}finally{await proxy.close()}
 assert.throws(()=>validateControlUrl('http://remote.example'),/HTTPS/);assert.equal(validateControlUrl('https://cloud.example/'),'https://cloud.example');
});

test('WSS生存報告は署名を要求し、失効後の既存接続も閉じる',async()=>{
 const app=Fastify();const service=registerPersonalCloud(app,{file:':memory:',authorize:()=> 'owner'});
 const keys=generateKeyPairSync('ed25519'),code=service.issueCode('owner','WSS検証PC');const {nodeId}=service.enroll(code.code,keys.publicKey.export({type:'spki',format:'pem'}).toString());service.approve('owner',nodeId);
 let socket:WebSocket|undefined;
 try{
  await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as import('node:net').AddressInfo).port;
  socket=new WebSocket('ws://127.0.0.1:'+port+'/api/personal-cloud/agent/connect');await new Promise<void>((resolve,reject)=>{socket!.once('open',resolve);socket!.once('error',reject)});
  const send=()=>{const route='/api/personal-cloud/agent/connect',timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex'),payload=caps;socket!.send(JSON.stringify({nodeId,timestamp,nonce,payload,signature:sign(null,Buffer.from(signedPayload(route,timestamp,nonce,payload)),keys.privateKey).toString('base64')}));};
  const response=new Promise<any>(resolve=>socket!.once('message',data=>resolve(JSON.parse(data.toString()))));send();assert.equal((await response).approved,true);
  assert.equal(service.snapshot('owner').nodes[0].status,'online');service.revoke('owner',nodeId);
  const closed=new Promise<number>(resolve=>socket!.once('close',resolve));send();assert.equal(await closed,1008);
 }finally{socket?.terminate();await app.close()}
});

test('Cloudflare Accessは署名・発行者・対象・期限の一致を要求する',async()=>{
 const keys=generateKeyPairSync('rsa',{modulusLength:2048});const publicKey={...keys.publicKey.export({format:'jwk'}),kid:'test-key'};
 const savedFetch=globalThis.fetch;globalThis.fetch=(async()=>Response.json({keys:[publicKey]})) as typeof fetch;
 try{
  const verifier=new AccessVerifier('test.cloudflareaccess.com','app-audience');
  const token=(extra:Record<string,unknown>={})=>{const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url'),body=Buffer.from(JSON.stringify({iss:'https://test.cloudflareaccess.com',aud:['app-audience'],exp:Date.now()/1000+60,...extra})).toString('base64url'),signature=sign('RSA-SHA256',Buffer.from(header+'.'+body),keys.privateKey).toString('base64url');return header+'.'+body+'.'+signature;};
  assert.equal(await verifier.authorize(token()),true);assert.equal(await verifier.authorize(token({aud:['other-app']})),false);assert.equal(await verifier.authorize(token({exp:1})),false);assert.equal(await verifier.authorize(token({iss:'https://other.example'})),false);assert.equal(await verifier.authorize(token()+'bad'),false);
 }finally{globalThis.fetch=savedFetch}
});

test('同じ端末台帳でのAgent二重起動を拒否し、停止後は再開できる',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-node-lock-'));const app=Fastify();const service=registerPersonalCloud(app,{file:':memory:',authorize:()=> 'owner'});let first:NodeAgent|undefined,second:NodeAgent|undefined;
 try{
  await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as import('node:net').AddressInfo).port;
  await enrollNode(root,'http://127.0.0.1:'+port,service.issueCode('owner','ロック検証PC').code);
  first=new NodeAgent(root);await first.initialize();second=new NodeAgent(root);await assert.rejects(second.initialize(),/既に実行中/);await second.close();second=undefined;
  await first.close();first=undefined;second=new NodeAgent(root);await second.initialize();
 }finally{await first?.close();await second?.close();await app.close();await rm(root,{recursive:true,force:true})}
});

test('検証済みGPUだけを割り当て、予約済みVRAMを別アプリへ重複割当しない',()=>{
 const f=fixture();try{
  f.service.heartbeat(f.nodeId,{...caps,gpus:[{name:'検証GPU',index:0,freeBytes:8*1024**3,totalBytes:8*1024**3,verified:true,engines:['docker']}]});
  const first=f.service.createApp('owner',{spec:{...spec,gpuMemoryBytes:6*1024**3}},'gpu-reservation-1');assert.equal(first.gpuIndex,0);
  assert.throws(()=>f.service.createApp('owner',{spec:{...spec,gpuMemoryBytes:4*1024**3}},'gpu-reservation-2'),/GPU/);
  assert.equal(f.service.placement('owner',{...spec,engine:'podman',gpuMemoryBytes:1024})[0].eligible,false);
 }finally{f.repository.close()}
});

test('停止アプリの起動待ちも予約し、同時配備によるCPU過剰割当を防ぐ',()=>{
 const f=fixture();try{
  const first=f.service.createApp('owner',{spec:{...spec,cpuCores:3}},'start-budget-create');
  const claim=f.service.claim(f.nodeId).job!;f.service.finish(f.nodeId,claim.id,claim.lease!,{state:'ready',deploymentId:first.id});
  let current=f.service.snapshot('owner').apps[0];f.service.action('owner',first.appId,'stop',{revision:current.revision},'start-budget-stop');
  const stop=f.service.claim(f.nodeId).job!;f.service.finish(f.nodeId,stop.id,stop.lease!,{state:'stopped'});
  current=f.service.snapshot('owner').apps[0];f.service.action('owner',first.appId,'start',{revision:current.revision},'start-budget-start');
  assert.throws(()=>f.service.createApp('owner',{spec:{...spec,cpuCores:2}},'start-budget-other'),/CPU/);
 }finally{f.repository.close()}
});
