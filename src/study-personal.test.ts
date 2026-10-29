import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { PersonalStudies } from './study/personal.js';
import { registerStudy } from './study/routes.js';
import type { StudyModule } from './study/service.js';
import { JupyterStudyService } from './study/service.js';
import { studyJupyterPlugin, STUDY_JUPYTER_SERVICE } from './study/plugin.js';
import { WentianPluginKernel } from './plugin-kernel.js';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

test('個人書房はIDで分離し、停止・所有者保存を他管理者と混同しない',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'personal-study-'));const states=new Map<string,boolean>();
 const factory=(_workspace:string,key='') : StudyModule=>({status:async()=>({state:states.get(key)?'running':'stopped',notebooks:path.join(root,key)}),start:async()=>{states.set(key,true);return{state:'running',notebooks:path.join(root,key)}},stop:async()=>{states.set(key,false);return{state:'stopped',notebooks:path.join(root,key)}},restart:async()=>({state:'running',notebooks:path.join(root,key)}),target:()=>undefined});
 const manager=new PersonalStudies(factory,root);await manager.load();const app=Fastify();
 registerStudy(app,req=>manager.forUser(String(req.headers['x-owner']||'')),(req,reply)=>{if(req.headers['x-owner'])return true;reply.code(401).send({error:{message:'ログインが必要です。'}});return false;});
 try{
  assert.equal((await app.inject('/api/study/status')).statusCode,401);
  const a={headers:{'x-owner':'admin-a'}},b={headers:{'x-owner':'admin-b'}};
  const ra=(await app.inject({url:'/api/study/status',...a})).json(),rb=(await app.inject({url:'/api/study/status',...b})).json();assert.notEqual(ra.notebooks,rb.notebooks);
  assert.equal((await app.inject({method:'POST',url:'/api/study/start',...a})).json().state,'running');
  assert.equal((await app.inject({url:'/api/study/status',...b})).json().state,'stopped');
  await app.inject({method:'POST',url:'/api/study/stop',...b});assert.equal((await app.inject({url:'/api/study/status',...a})).json().state,'running');
  await manager.bindGroup('group','admin-a');await manager.bindGroup('group','admin-b');assert.equal(await manager.rootForGroup('group'),ra.notebooks);
  const reloaded=new PersonalStudies(factory,root);await reloaded.load();assert.equal(await reloaded.rootForGroup('group'),ra.notebooks);assert.equal(await reloaded.rootForGroup('unassigned'),undefined);
 }finally{await app.close();await manager.stopAll();await rm(root,{recursive:true,force:true});}
});

test('共通Jupyter版を共有しても管理者のノート保存先はユーザー専用配下になる',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'study-plugin-personal-')),kernel=new WentianPluginKernel();
 try{kernel.register(studyJupyterPlugin);await kernel.load([{id:studyJupyterPlugin.id,config:{root:path.join(root,'module'),notebooks:path.join(root,'notebooks')}}]);const factory=kernel.resolve(STUDY_JUPYTER_SERVICE);assert.equal((await factory.create(root,'a').status()).notebooks,path.join(root,'notebooks','users','a'));assert.notEqual((await factory.create(root,'b').status()).notebooks,(await factory.create(root,'a').status()).notebooks);}finally{await rm(root,{recursive:true,force:true});}
});

test('旧共有書房の取り込みは原本・既存ファイルを保持し、他管理者の個人領域を除外する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'study-legacy-')),notebooks=path.join(root,'notebooks');
 const manager=new PersonalStudies((_workspace,owner)=>new JupyterStudyService(path.join(root,'module'),owner?path.join(notebooks,'users',owner):notebooks),root);
 try{await mkdir(path.join(notebooks,'users','other'),{recursive:true});await writeFile(path.join(notebooks,'legacy.md'),'旧共有成果');await writeFile(path.join(notebooks,'users','other','private.md'),'他の管理者の成果');const personal=(await manager.rootForUser('admin'))!;await mkdir(personal,{recursive:true});await writeFile(path.join(personal,'legacy.md'),'本人の既存成果');const result=await manager.importLegacy('admin');assert.equal(result.skipped,1);assert.equal(await readFile(path.join(personal,'legacy.md'),'utf8'),'本人の既存成果');assert.equal(await readFile(path.join(notebooks,'legacy.md'),'utf8'),'旧共有成果');await assert.rejects(access(path.join(personal,'users','other','private.md')));}finally{await manager.stopAll();await rm(root,{recursive:true,force:true});}
});

test('同じ書房URLでもHTTPとWebSocketはログイン管理者のJupyterだけへ中継する',async()=>{
 const backends=await Promise.all(['a','b'].map(async owner=>{
  const server=createServer((_req,res)=>res.end(owner)),ws=new WebSocketServer({server});ws.on('connection',socket=>socket.on('message',()=>socket.send(owner)));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return{server,ws,port:(server.address() as import('node:net').AddressInfo).port,owner};
 }));
 const app=Fastify();registerStudy(app,req=>{const target=backends.find(b=>b.owner===req.headers['x-owner']);return target?{target:()=>({port:target.port,token:'test-'+target.owner}),stop:async()=>({state:'stopped',notebooks:'isolated'})} as StudyModule:undefined;},(req,reply)=>{if(['a','b'].includes(String(req.headers['x-owner'])))return true;reply.code(401).send({});return false;});
 try{
  await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as import('node:net').AddressInfo).port;
  for(const owner of ['a','b']){
   const response=await app.inject({url:'/study/jupyter/api/contents',headers:{'x-owner':owner}});assert.equal(response.body,owner);
   const received=await new Promise<string>((resolve,reject)=>{const socket=new WebSocket('ws://127.0.0.1:'+port+'/study/jupyter/api/kernels/test/channels',{headers:{'x-owner':owner}});socket.once('open',()=>socket.send('確認'));socket.once('message',data=>{resolve(data.toString());socket.close();});socket.once('error',reject);});assert.equal(received,owner);
  }
 }finally{await app.close();for(const b of backends){b.ws.close();await new Promise<void>(resolve=>b.server.close(()=>resolve()));}}
});
