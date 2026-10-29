import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { AgentGroupStore } from './agent-group.js';
import { GroupKnowledge } from './group-knowledge.js';
import { ProjectKnowledgeStore } from './project-knowledge.js';
import { registerWorkbench } from './workbench.js';

async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'wentian-group-knowledge-')),groups=new AgentGroupStore(root),store=new ProjectKnowledgeStore({root:path.join(root,'knowledge')});let revoked=false;const binding=new GroupKnowledge(root,store,async(project,user)=>!revoked&&project==='alpha'&&['owner','reader'].includes(user),async(_project,model)=>model==='fixture/model');const group=await groups.create('私的資料の検討',[{name:'検証者',role:'資料の確認',model:'fixture/model'}]);return{root,groups,store,binding,group,revoke:()=>{revoked=true},close:()=>rm(root,{recursive:true,force:true})}}

test('知識庫グループは公開・他プロジェクトへの再接続・権限失効後の閲覧を拒否する',async()=>{
 const f=await fixture();try{
  await f.binding.bind(f.group.id,'alpha','owner');assert.equal(await f.binding.accessible(f.group.id,'reader'),true);assert.equal(await f.binding.accessible(f.group.id,'outsider'),false);
  await assert.rejects(f.groups.publish(f.group.id,true),/公開できません/);
  await assert.rejects(f.groups.publish(f.group.id,true,undefined,undefined,'page'),/公開できません/);
  f.revoke();assert.equal(await f.binding.accessible(f.group.id,'reader'),false);
  const respond=f.binding.wrap(async()=>{throw Error('通常応答は使いません')},async()=>JSON.stringify({queries:['資料']}));
  await assert.rejects(respond(f.group.members[0],[],{groupId:f.group.id} as any),/失効/);
 }finally{await f.close()}
});

test('公開済みグループ・許可されないAIモデル・所属外の人間参加者へ資料を渡さない',async()=>{
 const f=await fixture();try{
  await f.groups.publish(f.group.id,true);await assert.rejects(f.binding.bind(f.group.id,'alpha','owner'),/公開グループ/);
  await f.groups.publish(f.group.id,false);
  await f.groups.participate(f.group.id,{id:'outsider',name:'所属外'},'join');await assert.rejects(f.binding.bind(f.group.id,'alpha','owner'),/参加者全員/);
  await f.groups.participate(f.group.id,{id:'outsider',name:'所属外'},'leave');
  await f.groups.member(f.group.id,'update','検証者',{...f.group.members[0],model:'other/model'});await assert.rejects(f.binding.bind(f.group.id,'alpha','owner'),/明示モデル/);
 }finally{await f.close()}
});

test('グループの成果審査へ別AIの意味検証の不足を追加する',async()=>{
 const f=await fixture();try{
  await f.store.register('alpha',{title:'規程',url:'https://example.invalid/rules',content:'付与は20日。'});await f.binding.bind(f.group.id,'alpha','owner');
  const respond=f.binding.wrap(async()=>{throw Error('通常応答は使いません')},async(_binding,_model,messages)=>{
   const last=JSON.parse(messages.at(-1)!.content);
   if(last.bodyHash)return JSON.stringify({bodyHash:last.bodyHash,supported:false,issues:['30日という数値は規程から導けない。']});
   if(last.projectEvidence)return JSON.stringify({issues:[]});return JSON.stringify({queries:['付与']});
  });
  const result=await respond(f.group.members[0],[{role:'user',content:JSON.stringify({draft:'付与は30日。'})}],{groupId:f.group.id,outcomePhase:'review'} as any);
  assert.match(typeof result==='string'?result:result.content,/30日という数値/);
 }finally{await f.close()}
});

test('通常メンバーのグループAPIでも知識庫所属を再確認し一覧と履歴を隠す',async()=>{
 const f=await fixture(),app=Fastify();try{
  await f.binding.bind(f.group.id,'alpha','owner');
  registerWorkbench(app,{workspace:f.root,authorize:()=>true,models:async()=>[],providerSaved:()=>{},testModel:async()=>'',groupIdentity:req=>({id:String(req.headers['x-user']),name:'利用者',admin:false}),groupKnowledgeAccess:(req,id)=>f.binding.accessible(id,String(req.headers['x-user']))});
  assert.equal((await app.inject({url:'/api/workbench/groups/'+f.group.id,headers:{'x-user':'outsider'}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/workbench/groups/'+f.group.id,headers:{'x-user':'reader'}})).statusCode,200);
  assert.deepEqual((await app.inject({url:'/api/workbench/groups',headers:{'x-user':'outsider'}})).json().groups,[]);
 }finally{await app.close();await f.close()}
});
