import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerWorkbench } from './workbench.js';
import { AgentGroupStore, namedMembers } from './agent-group.js';
import { registerSiteAdmin, PublicSiteStore, defaultPublicSite } from './public-site.js';

test('公開参加の許可と禁止はページごとに保存し、認証済み投稿とAPI拒否まで適用する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-public-join-')),app=Fastify();
 const authorize=(req:any,reply:any)=>{if(req.headers.cookie==='admin')return true;reply.code(401).send({error:{message:'ログインが必要です。'}});return false;};
 registerWorkbench(app,{workspace:root,authorize,groupIdentity:req=>['admin','member'].includes(req.headers.cookie||'')?{id:req.headers.cookie!,name:'参加者',admin:req.headers.cookie==='admin'}:undefined,models:async()=>[],providerSaved:()=>{},testModel:async()=>''});
 registerSiteAdmin(app,{workspace:root,authorize,gatewayOrigin:()=> 'http://localhost',design:async()=> '{}'});
 try{
  const groups=new AgentGroupStore(root),group=await groups.create('公開相談',namedMembers(['AI']));
  await new PublicSiteStore(root,'companyprofile').save({...defaultPublicSite});
  const setting='/api/workbench/groups/'+group.id+'/publication',room='/api/site/rooms/'+group.id;
  let response=await app.inject({method:'POST',url:setting,headers:{cookie:'admin'},payload:{published:true,page:'companyprofile',participation:true,participationAuth:'login',presence:'offline'}});assert.equal(response.statusCode,200,response.body);
  assert.equal((await app.inject('/api/site?page=companyprofile')).json().rooms[0].showComposer,true);
  assert.equal((await app.inject({method:'POST',url:room+'/join?page=companyprofile',payload:{}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:room+'/join?page=companyprofile',headers:{cookie:'member'},payload:{presence:'online'}})).statusCode,200);
  response=await app.inject({method:'POST',url:room+'/messages?page=companyprofile',headers:{cookie:'member'},payload:{nickname:'参加者<member@example.com>',content:'公開ページからの投稿'}});assert.equal(response.statusCode,200,response.body);
  assert.equal((await groups.load(group.id)).messages.at(-1)!.content,'公開ページからの投稿');
  assert.equal((await app.inject({method:'POST',url:room+'/messages?page=other',headers:{cookie:'member'},payload:{content:'拒否'}})).statusCode,403);
  await groups.publish(group.id,true,'説明を更新',undefined,'companyprofile');assert.equal((await groups.load(group.id)).publication!.pages!.companyprofile.showComposer,true);
  await app.inject({method:'POST',url:setting,headers:{cookie:'admin'},payload:{published:true,page:'companyprofile',participation:false}});
  for(const action of ['join','messages'])assert.equal((await app.inject({method:'POST',url:room+'/'+action+'?page=companyprofile',headers:{cookie:'member'},payload:{content:'拒否'}})).statusCode,403);
  assert.equal((await groups.load(group.id)).messages.length,1);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
