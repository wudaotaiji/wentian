import test from 'node:test';
import assert from 'node:assert/strict';
import { Window, HTMLInputElement, HTMLButtonElement, HTMLSelectElement } from 'happy-dom';
import { userManagementScript } from './user-management-ui.js';
import { withAppearance } from './appearance-ui.js';

test('統合画面は全権限に本人設定を示し、他者の管理は管理者だけに表示する',async()=>{
 for(const role of ['viewer','operator','admin']){
  const window=new Window({url:'http://localhost/#users'}),calls:string[]=[];
  window.fetch=(async(url:unknown)=>{const path=String(url);calls.push(path);return new window.Response(JSON.stringify(path.endsWith('/users')?[]:{user:{id:'me',username:'test-user',displayName:'テスト',role}}));}) as any;
  try{window.document.write('<section id="root"></section>');window.eval(userManagementScript);await (window as any).wentianUsers.mountAccount(window.document.getElementById('root'),{id:'me',role});
   assert.ok(window.document.getElementById('profileEdit'));
   assert.equal(Boolean(window.document.getElementById('userAdminPanel')),role==='admin');
   assert.equal(calls.includes('/api/control-center/users'),role==='admin');
   if(role==='admin'){const button=[...window.document.querySelectorAll('button')].find(b=>b.textContent==='自分のアカウント')!;button.click();assert.equal(window.document.getElementById('userProfilePanel')!.hasAttribute('hidden'),false);assert.equal(window.document.getElementById('userAdminPanel')!.hasAttribute('hidden'),true);}
  }finally{await window.happyDOM.close()}
 }
});

test('管理画面で作成・名前変更・リセット・無効化・接続終了・削除を操作する',async()=>{
 const window=new Window({url:'http://localhost/'}),doc=window.document;
 const users:any[]=[{id:'admin',username:'admin',displayName:'管理者',role:'admin',enabled:true,updatedAt:new Date().toISOString(),sessions:1}];const requests:any[]=[];
 window.fetch=(async(url:unknown,options:any={})=>{const address=String(url),body=options.body?JSON.parse(options.body):undefined;requests.push({address,method:options.method,body});let result:any={};if(address.endsWith('/me'))result={user:users[0]};else if(address.endsWith('/audit'))result={entries:[]};else if(options.method==='GET')result=users;else if(options.method==='POST'&&address.endsWith('/users')){result={...body,id:'new',updatedAt:new Date().toISOString()};users.push(result)}else if(options.method==='PATCH'){result=users.find(u=>u.id===address.split('/').at(-1));Object.assign(result,body)}else if(options.method==='DELETE')users.splice(users.findIndex(u=>u.id===address.split('/').at(-1)),1);return new window.Response(JSON.stringify(result),{status:200})}) as any;
 (window as any).confirm=()=>true;doc.write('<section id="root"></section>');window.eval(userManagementScript);await (window as any).wentianUsers.mountAdmin(doc.getElementById('root'));
 const settle=async()=>{for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve))};
 const form=()=>doc.getElementById('userEdit') as any;const fill=(name:string,value:string)=>{form().elements.namedItem(name).value=value};const save=async()=>{form().dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await settle()};
 const action=(text:string)=>Array.from(Array.from(doc.querySelectorAll('#userTable tr')).at(-1)!.querySelectorAll('button')).find((b:any)=>b.textContent===text) as HTMLButtonElement;
 try{
  (doc.getElementById('userNew') as HTMLButtonElement).click();fill('username','new-user');fill('displayName','<img src=x>');fill('password','long-test-password');fill('confirmation','mismatch');await save();assert.match(doc.querySelector('[role=status]')!.textContent!,/一致/);assert.equal(requests.filter(r=>r.method==='POST').length,0);
  fill('confirmation','long-test-password');await save();assert.equal(users.length,2);assert.equal(doc.querySelector('#userTable img'),null);assert.equal((form().elements.namedItem('password') as HTMLInputElement).value,'');
  action('編集').click();fill('username','renamed-user');fill('password','new-long-password');fill('confirmation','new-long-password');await save();assert.equal(users[1].username,'renamed-user');assert.equal(users[1].id,'new');
  action('無効にする').click();await settle();assert.equal(users[1].enabled,false);
  action('接続をすべて終了').click();await settle();assert.ok(requests.some(r=>r.address.endsWith('/new/revoke-sessions')));
  (doc.getElementById('userSearch') as HTMLInputElement).value='nobody';doc.getElementById('userSearch')!.dispatchEvent(new window.Event('input'));assert.equal(doc.querySelectorAll('#userTable tr').length,1);
  (doc.getElementById('userSearch') as HTMLInputElement).value='';doc.getElementById('userSearch')!.dispatchEvent(new window.Event('input'));action('削除').click();await settle();assert.equal(users.length,1);
 }finally{await window.happyDOM.close()}
});

test('本人設定は現在のパスワードを送り、保存後にパスワードを消して再ログインを要求する',async()=>{
 const window=new Window({url:'http://localhost/account'}),doc=window.document;let expired=false,payload:any;
 window.addEventListener('wentian-user-session-expired',()=>{expired=true});window.fetch=(async(_url:unknown,options:any={})=>{if(options.method==='PATCH')payload=JSON.parse(options.body);return new window.Response(JSON.stringify({user:{username:'viewer',displayName:'閲覧者'}}),{status:200})}) as any;
 try{doc.write('<section id="root"></section>');window.eval(userManagementScript);await (window as any).wentianUsers.mountProfile(doc.getElementById('root'));const form=doc.querySelector('form') as any;form.elements.namedItem('currentPassword').value='current-password';form.elements.namedItem('password').value=form.elements.namedItem('confirmation').value='new-long-password';form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(payload.currentPassword,'current-password');assert.equal(payload.role,undefined);assert.equal(expired,true);assert.equal(form.elements.namedItem('password').value,'');}finally{await window.happyDOM.close()}
});

test('ユーザー管理の選択肢と本人設定の項目を中日英で表示する',async()=>{
 for(const lang of ['zh','en','ja']){const window=new Window({url:'http://localhost/'});window.localStorage.setItem('wentian-language',lang);window.fetch=(async(url:unknown)=>new window.Response(JSON.stringify(String(url).endsWith('/me')?{user:{id:'admin'}}:[]))) as any;try{const html=withAppearance('<html><head></head><body><section id="root"></section><script></script></body></html>');window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g,''));for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))window.eval(script[1]);window.eval(userManagementScript);await (window as any).wentianUsers.mountAdmin(window.document.getElementById('root'));(window.document.getElementById('userNew') as HTMLButtonElement).click();assert.equal((window.document.querySelector('select[name=role]') as HTMLSelectElement).options[2].textContent,{zh:'管理员',en:'Administrator',ja:'管理者'}[lang]);}finally{await window.happyDOM.close()}}
});
