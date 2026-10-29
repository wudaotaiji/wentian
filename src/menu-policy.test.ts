import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Window } from 'happy-dom';
import { registerMenuPolicy,defaultMenuPolicy,MenuPolicyStore,validateMenuPolicy } from './menu-policy.js';
import { menuPolicyClient } from './menu-policy-client.js';
import { menuSettingsHtml } from './menu-settings-ui.js';
import { menuItems } from './menu-policy.js';

test('旧アカウントの表示設定をユーザー統合入口へ移行し、再起動時の重複を除く',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'menu-account-')),file=path.join(root,'menu.json');
 try{const legacy=defaultMenuPolicy();legacy.admin.push('/account');legacy.viewer=legacy.viewer.map(id=>id==='users'?'/account':id);await writeFile(file,JSON.stringify(legacy));const store=new MenuPolicyStore(file);await store.load();assert.ok(store.get().viewer.includes('users'));assert.equal(store.get().admin.filter(id=>id==='users').length,1);assert.equal(store.get().admin.includes('/account'),false);}
 finally{await rm(root,{recursive:true,force:true})}
});

test('3権限のメニュー設定は管理者だけが変更でき、再起動後も保持する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'menu-policy-')),app=Fastify();
 await registerMenuPolicy(app,root,req=>req.headers.cookie?{id:'test',role:req.headers.cookie==='admin'?'admin':'viewer'} as any:undefined,(req,reply)=>{if(req.headers.cookie==='admin')return{};reply.code(403).send({error:{message:'管理者専用'}});return undefined;});
 try{
  assert.equal((await app.inject('/api/navigation/policy')).statusCode,403);
  assert.equal((await app.inject({url:'/api/navigation/menu',headers:{cookie:'viewer'}})).json().visible.includes('users'),true);
  const policy=defaultMenuPolicy();policy.viewer.push('chat');
  assert.equal((await app.inject({method:'PUT',url:'/api/navigation/policy',headers:{cookie:'viewer'},payload:policy})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:'/api/navigation/policy',headers:{cookie:'admin',origin:'https://foreign.test'},payload:policy})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:'/api/navigation/policy',headers:{cookie:'admin'},payload:policy})).statusCode,200);
  const store=new MenuPolicyStore(path.join(root,'.wentian','menu-policy.json'));await store.load();assert.ok(store.get().viewer.includes('chat'));
  assert.throws(()=>validateMenuPolicy({...policy,viewer:['unknown']}));assert.throws(()=>validateMenuPolicy({...policy,admin:[]}));
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('同じ画面の左メニューは権限更新で表示を切り替え、空の分類を隠す',async()=>{
 const window=new Window({url:'http://localhost/'});let visible=['home'];window.document.write('<html><head></head><body><aside class="nav-rail"><nav><a data-view="home" href="/#home">ホーム</a><details><summary>管理</summary><a data-view="users" href="/#users">ユーザー管理</a></details><a href="/study">書斎</a></nav></aside></body></html>');
 window.fetch=(async()=>new window.Response(JSON.stringify({visible}))) as any;
 try{window.eval(menuPolicyClient.slice(8,-9));for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));assert.equal((window.document.querySelector('[data-view=users]') as any).dataset.menuHidden,'true');assert.equal((window.document.querySelector('details') as any).dataset.menuEmpty,'true');visible=['home','users','/study'];window.document.dispatchEvent(new window.Event('wentian-role'));for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));assert.equal((window.document.querySelector('[data-view=users]') as any).dataset.menuHidden,'false');assert.equal((window.document.querySelector('details') as any).dataset.menuEmpty,'false');}finally{await window.happyDOM.close();}
});

test('管理者の設定画面で3権限のチェック表を保存し、管理経路の項目は外せない',async()=>{
 const window=new Window({url:'http://localhost/menu-settings'}),policy=defaultMenuPolicy();let saved:any;
 window.fetch=(async(input:any,options:any={})=>{
  if(options.method==='PUT')saved=JSON.parse(options.body);
  const data=String(input)==='/api/control-center/me'?{user:{id:'admin',role:'admin',displayName:'管理者'}}:String(input)==='/api/navigation/menu'?{visible:policy.admin}:{policy,items:menuItems};
  return new window.Response(JSON.stringify(data));
 }) as any;
 try{
  window.document.write(menuSettingsHtml.replace(/<script>[\s\S]*?<\/script>/g,''));for(const script of menuSettingsHtml.matchAll(/<script>([\s\S]*?)<\/script>/g))window.eval(script[1]);
  for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));
  assert.equal(window.document.querySelectorAll('#menuPolicyRows input').length,menuItems.length*3);
  assert.equal((window.document.querySelector('input[data-role=admin][data-menu="/menu-settings"]') as any).disabled,true);
  (window.document.querySelector('input[data-role=viewer][data-menu=chat]') as any).checked=true;
  window.document.getElementById('menuPolicyForm')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));assert.ok(saved.viewer.includes('chat'));assert.ok(saved.admin.includes('/menu-settings'));
 }finally{await window.happyDOM.close();}
});


test('ログイン中に初回メニュー取得が完了しても新権限を再取得し再読込み不要で表示する',async()=>{
 const window=new Window({url:'http://localhost/'});window.document.write('<html><head></head><body><aside class="nav-rail"><nav><a data-view="home">ホーム</a><details><summary>管理</summary><a data-view="agents">Agent</a></details></nav></aside></body></html>');
 let finishInitial:(value:any)=>void;let calls=0;
 window.fetch=(async()=>{calls++;if(calls===1)return new Promise(resolve=>{finishInitial=resolve;});return new window.Response(JSON.stringify({visible:['home','agents']}));}) as any;
 try{window.eval(menuPolicyClient.slice(8,-9));window.document.dispatchEvent(new window.Event('wentian-user-session-changed'));finishInitial!(new window.Response(JSON.stringify({visible:['home']})));for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal((window.document.querySelector('[data-view=agents]') as any).hidden,false);assert.equal((window.document.querySelector('details') as any).dataset.menuEmpty,'false');}finally{await window.happyDOM.close();}
});
