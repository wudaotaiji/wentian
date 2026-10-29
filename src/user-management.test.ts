import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { ControlCenterAuthStore, parseCookie } from './control-center-auth.js';
import { registerUserManagement } from './user-management.js';
import { recoverUser } from './user-recovery.js';

test('名前変更はIDを保持し、失敗時に状態を汚さず、最後の管理者と競合を保護する', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-users-'));try{
  const store=new ControlCenterAuthStore(path.join(root,'users.json'));await store.initialize({bootstrap:false});
  const a=await store.createUser({username:'admin-one',password:'long-test-password',role:'admin'});
  await assert.rejects(store.createInitialAdmin({username:'extra-admin',password:'long-test-password'}));
  for(const input of [{role:'viewer'},{enabled:false},{password:'short',displayName:'変更しない'},{role:'root'},{enabled:'false'}])await assert.rejects(store.updateUser(a.id,input as any));
  assert.equal(store.findPublicUser(a.id)!.displayName,'admin-one');assert.equal(store.findPublicUser(a.id)!.role,'admin');
  const b=await store.createUser({username:'admin-two',password:'long-test-password',role:'admin'});
  await assert.rejects(store.updateUser(b.id,{username:'ADMIN-ONE'}));
  const outcomes=await Promise.allSettled([store.updateUser(a.id,{enabled:false}),store.updateUser(b.id,{enabled:false})]);assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
  const live=store.listUsers().find(u=>u.enabled)!;const session=await store.login(live.username,'long-test-password');
  await store.updateUser(live.id,{username:'renamed-admin',password:'new-long-password'});assert.equal(store.findPublicUser(live.id)!.username,'renamed-admin');assert.equal(store.authenticate(session!.token),undefined);
  assert.equal(await store.login(live.username,'long-test-password'),undefined);assert.ok(await store.login('renamed-admin','new-long-password'));
  const reloaded=new ControlCenterAuthStore(path.join(root,'users.json'));await reloaded.initialize({bootstrap:false});assert.equal(reloaded.findPublicUser(live.id)!.username,'renamed-admin');
  const saved=await readFile(path.join(root,'users.json'),'utf8');assert.doesNotMatch(saved,/long-test-password|new-long-password/);assert.ok(reloaded.auditLog().length>=4);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('管理APIと本人設定の権限・再認証・失効・外部オリジン拒否を検証する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-users-api-')),app=Fastify();try{
  const store=new ControlCenterAuthStore(path.join(root,'users.json'));await store.initialize({bootstrap:false});
  const admin=await store.createUser({username:'admin',password:'long-test-password',role:'admin'}),viewer=await store.createUser({username:'viewer',password:'long-test-password'});
  const a=(await store.login('admin','long-test-password'))!,v=(await store.login('viewer','long-test-password'))!;
  registerUserManagement(app,store,(req,reply)=>{const user=store.authenticate(parseCookie(req.headers.cookie,'wentian_session'));if(user?.role==='admin')return user;reply.code(user?403:401).send({error:{message:'権限がありません。'}});return undefined});
  const call=(method:any,url:string,token?:string,payload?:unknown,origin?:string)=>app.inject({method,url,headers:{...(token?{cookie:'wentian_session='+token}:{}),...(origin?{origin}:{})},...(payload?{payload:payload as any}:{})});
  assert.equal((await call('GET','/api/control-center/users')).statusCode,401);assert.equal((await call('GET','/api/control-center/users',v.token)).statusCode,403);
  assert.equal((await call('PATCH','/api/control-center/users/'+admin.id,v.token,{role:'viewer'})).statusCode,403);
  assert.equal((await call('POST','/api/control-center/users',a.token,{username:'injected',password:'long-test-password'},'https://evil.example')).statusCode,403);
  let result=await call('GET','/api/control-center/users',a.token);assert.doesNotMatch(result.body,/passwordHash|scrypt|token/);
  assert.equal((await call('PATCH','/api/control-center/profile',v.token,{currentPassword:'long-test-password',role:'admin'})).statusCode,400);
  assert.equal((await call('PATCH','/api/control-center/profile',v.token,{username:'renamed-viewer',currentPassword:'incorrect'})).statusCode,400);
  result=await call('PATCH','/api/control-center/profile',v.token,{username:'renamed-viewer',currentPassword:'long-test-password',password:'new-viewer-password'});assert.equal(result.statusCode,200,result.body);assert.equal(result.json().user.id,viewer.id);assert.equal(result.json().loginRequired,true);assert.equal(store.authenticate(v.token),undefined);
  const newLogin=(await store.login('renamed-viewer','new-viewer-password'))!;assert.ok(newLogin);
  assert.equal((await call('POST','/api/control-center/users/'+viewer.id+'/revoke-sessions',a.token,{})).statusCode,200);assert.equal(store.authenticate(newLogin.token),undefined);
  assert.equal((await call('DELETE','/api/control-center/users/'+admin.id,a.token)).statusCode,400);
  assert.equal((await call('DELETE','/api/control-center/users/'+viewer.id,a.token)).statusCode,204);assert.equal(store.findPublicUser(viewer.id),undefined);
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
});

test('ローカル復旧は停止中の既存管理者だけをID保持で更新する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-recovery-'));try{
  const file=path.join(root,'users.json'),store=new ControlCenterAuthStore(file);await store.initialize({bootstrap:false});
  const admin=await store.createUser({username:'admin',password:'long-test-password',role:'admin'}),viewer=await store.createUser({username:'viewer',password:'long-test-password'});
  await assert.rejects(recoverUser({store:file,userId:admin.id,password:'new-long-password'},async()=>true));
  await assert.rejects(recoverUser({store:file,userId:viewer.id,password:'new-long-password'},async()=>false));
  const recovered=await recoverUser({store:file,userId:admin.id,username:'recovered-admin',password:'new-long-password'},async()=>false);assert.equal(recovered.id,admin.id);
  const reloaded=new ControlCenterAuthStore(file);await reloaded.initialize({bootstrap:false});assert.ok(await reloaded.login('recovered-admin','new-long-password'));assert.ok(reloaded.findPublicUser(viewer.id));
 }finally{await rm(root,{recursive:true,force:true})}
});
