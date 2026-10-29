import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerWorkbench } from './workbench.js';
import { AgentGroupStore, namedMembers } from './agent-group.js';
import { registerSiteAdmin, PublicSiteStore, defaultPublicSite } from './public-site.js';
import { PublicGuestSessions, publicGuestProfile, type PublicGuestPost } from './public-guest.js';

test('ゲストは情報入力だけで公開群へ投稿でき、識別子偽装・別ページ・禁止・管理操作を拒否する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-guest-')),app=Fastify();let handler:PublicGuestPost|undefined;let replies=0;
 const authorize=(_req:any,reply:any)=>{reply.code(401).send({error:{message:'管理者認証が必要です。'}});return false;};
 registerWorkbench(app,{workspace:root,authorize,models:async()=>[],providerSaved:()=>{},testModel:async()=>'',registerPublicPost:post=>{handler=post;},groupRespond:async()=>{replies++;return 'ゲストの質問への返答です。';}});
 registerSiteAdmin(app,{workspace:root,authorize,gatewayOrigin:()=> 'http://localhost',design:async()=> '{}',guestPost:async(...args)=>{assert.ok(handler);await handler(...args);}});
 try{
  const groups=new AgentGroupStore(root),group=await groups.create('公開相談',namedMembers(['AI']));
  await groups.configureAutonomy(group.id,{enabled:false,workflow:'free'});
  await new PublicSiteStore(root,'companyprofile').save({...defaultPublicSite});await new PublicSiteStore(root,'other').save({...defaultPublicSite});
  await groups.publish(group.id,true,'紹介','online','companyprofile');await groups.publish(group.id,true,'紹介','online','other');
  const url='/api/site/rooms/'+group.id,profile={nickname:'訪問者<visitor@example.com>'};
  let res=await app.inject({method:'POST',url:url+'/join?page=companyprofile',payload:profile});assert.equal(res.statusCode,200,res.body);
  const cookie=String(res.headers['set-cookie']).split(';')[0];assert.match(String(res.headers['set-cookie']),/HttpOnly/);assert.match(String(res.headers['set-cookie']),/SameSite=Lax/);
  res=await app.inject({method:'POST',url:url+'/messages?page=companyprofile',headers:{cookie},payload:{...profile,userId:'admin',content:'質問です。'}});
  assert.equal(res.statusCode,200,res.body);assert.deepEqual(res.json(),{ok:true,guest:true});
  let saved=await groups.load(group.id);const human=saved.members.find(m=>m.kind==='human')!;assert.match(human.userId!,/^guest-/);assert.notEqual(human.userId,'admin');assert.equal(human.email,'visitor@example.com');
  const publicData=(await app.inject('/api/site?page=companyprofile')).body;assert.doesNotMatch(publicData,/visitor@example.com|guest-[a-f0-9-]{36}|ipAddress/);
  for(let i=0;i<100;i++){saved=await groups.load(group.id);if(replies&&saved.humanReply?.status==='completed')break;await new Promise(r=>setTimeout(r,10));}assert.equal(replies,1);
  assert.equal((await app.inject({method:'POST',url:url+'/messages?page=other',headers:{cookie},payload:{...profile,content:'拒否'}})).statusCode,401);
  const forged=cookie.slice(0,-8)+'forged00';assert.equal((await app.inject({method:'POST',url:url+'/messages?page=companyprofile',headers:{cookie:forged},payload:{...profile,content:'拒否'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:url+'/messages?page=companyprofile',headers:{cookie,'sec-fetch-site':'cross-site'},payload:{...profile,content:'拒否'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/workbench/groups/'+group.id+'/join',headers:{cookie},payload:{}})).statusCode,401);
  await groups.publish(group.id,true,undefined,'online','companyprofile','login');
  const restricted=(await app.inject('/api/site?page=companyprofile')).json().rooms[0];assert.equal(restricted.participationAuth,'login');
  for(const action of ['join','messages'])assert.equal((await app.inject({method:'POST',url:url+'/'+action+'?page=companyprofile',headers:{cookie},payload:{...profile,content:'ログイン必須'}})).statusCode,401);
  await groups.publish(group.id,true,'説明更新',undefined,'companyprofile');assert.equal((await groups.load(group.id)).publication!.pages!.companyprofile.participationAuth,'login');
  const html=(await app.inject('/sites/companyprofile/')).body;assert.match(html,/name="username"/);assert.match(html,/ログインが必要/);
  await groups.publish(group.id,true,undefined,'offline','companyprofile');
  for(const action of ['join','messages'])assert.equal((await app.inject({method:'POST',url:url+'/'+action+'?page=companyprofile',headers:{cookie},payload:{...profile,content:'拒否'}})).statusCode,403);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('情報の形式と投稿頻度を制限し、訪問者Cookieをアカウント認証に使わない',async()=>{
 for(const input of ['', '名前だけ', '名前<bad>', '<a@example.com>'])assert.throws(()=>publicGuestProfile(input));
 assert.equal(publicGuestProfile('訪問者<visitor@example.com>').name,'訪問者');
 const sessions=new PublicGuestSessions('unused');
 for(let i=0;i<12;i++)assert.equal(sessions.accept('127.0.0.1','one'),true);
 assert.equal(sessions.accept('127.0.0.1','one'),false);assert.equal(sessions.accept('127.0.0.1','other'),true);
});
