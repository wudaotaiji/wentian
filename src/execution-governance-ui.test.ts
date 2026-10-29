import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { executionCenterHtml } from './execution-governance-ui.js';

for(const language of ['ja','en','zh'])test(`${language}で既定の保守・一度だけのプロジェクト設定・取消を区別し、追加確認なしで選択範囲だけを保存する`,async()=>{
 const window=new Window({url:'http://localhost/execution-permissions?agent=opencode'}),requests:any[]=[];
 window.localStorage.setItem('wentian-language',language);
 let access:any={maintenanceDefault:true,maintenanceConfigured:true,maintenanceEnvironmentBlocked:false,revokedAgents:['opencode'],projects:[],targetsDigest:'fixture-target'};
 const data=()=>({workspace:'C:/项目/作業',access,maintenanceWorkspaces:{connection:'C:/fixture/connection',work:'C:/fixture/work'},grants:[],agents:['opencode','kilo'].map(agent=>({agent,connectionDigest:'snapshot',model:'model',destination:'provider-managed',active:0,metrics:{started:0,failed:0,denied:0,durationMs:0}})),recent:[],providerData:{providers:[],recent:[]}});
 window.fetch=(async(url:any,options:any={})=>{
  if(options.method&&options.method!=='GET'){
   const body=options.body?JSON.parse(options.body):undefined;requests.push({url:String(url),method:options.method,body});
   if(String(url).endsWith('/projects'))access={...access,projects:[{id:'fixture-project',root:body.root}]};
   if(String(url).endsWith('/defaults'))access={...access,...(body.agent?{revokedAgents:[]}:{maintenanceConfigured:body.maintenance,maintenanceDefault:body.maintenance})};
  }
  return new window.Response(JSON.stringify(data()));
 }) as any;
 (window as any).confirm=()=>assert.fail('通常の範囲保存に重複する確認ダイアログを追加しません。');
 try{
  window.document.write(executionCenterHtml.replace(/<script>[\s\S]*?<\/script>/g,''));
  const scripts=[...executionCenterHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  window.eval(scripts.find(s=>s.includes('const entries=')&&s.includes('window.wentianUi'))!);window.eval(scripts.find(s=>s.includes('executionDestination')&&s.includes('let initialized'))!);await window.happyDOM.waitUntilComplete();
  assert.equal(requests.length,0);assert.equal((window.document.getElementById('executionAgent') as any).value,'opencode');assert.equal((window.document.getElementById('projectExecutionRoot') as any).value,'C:/项目/作業');
  assert.equal((window.document.getElementById('executionAdvanced') as any).open,false);assert.equal((window.document.getElementById('maintenanceDefaultAccess') as any).checked,true);
  assert.match(window.document.getElementById('defaultAccessStatus')!.textContent!,language==='ja'?/期限なし/:language==='en'?/no expiry/:/无到期时间/);
  (window.document.getElementById('grantProjectExecution') as any).click();await window.happyDOM.waitUntilComplete();
  assert.deepEqual(requests[0],{url:'/api/execution-permissions/projects',method:'POST',body:{root:'C:/项目/作業',shareContext:true,allowHostAccount:true,expectedTargetsDigest:'fixture-target'}});
  assert.match(window.document.getElementById('projectExecutionGrants')!.textContent!,language==='ja'?/取消まで有効/:language==='en'?/until revoked/:/直至撤销/);
  (window.document.getElementById('executionRestoreDefaults') as any).click();await window.happyDOM.waitUntilComplete();assert.deepEqual(requests[1].body,{agent:'opencode',restore:true});
  assert.equal((window.document.getElementById('executionRestoreDefaults') as any).disabled,true);
  (window.document.getElementById('maintenanceDefaultAccess') as any).checked=false;(window.document.getElementById('saveDefaultAccess') as any).click();await window.happyDOM.waitUntilComplete();assert.deepEqual(requests[2].body,{maintenance:false});
  window.localStorage.setItem('wentian-language','en');window.document.dispatchEvent(new window.Event('wentian-language-changed'));await window.happyDOM.waitUntilComplete();assert.equal((window.document.getElementById('projectExecutionRoot') as any).value,'C:/项目/作業');
 }finally{await window.happyDOM.close();}
});

test('日英中の動的表示・拒否理由を翻訳し、取消した確認から許可を送信しない',async()=>{
  const window=new Window({url:'http://localhost/execution-permissions'}),requests:string[]=[];
  const scripts=[...executionCenterHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  try{
    window.document.write(executionCenterHtml.replace(/<script>[\s\S]*?<\/script>/g,''));
    window.fetch=(async(url:any,options:any)=>{requests.push(`${options?.method||'GET'} ${url}`);return new window.Response(JSON.stringify({workspace:'C:/作業/项目',maintenanceWorkspaces:{connection:'C:/test/connection',work:'C:/test/work'},grants:[],agents:[{agent:'codex',connectionDigest:'snapshot',model:'my-model',destination:'provider-managed',active:0,metrics:{started:0,failed:0,denied:1,durationMs:0}}],recent:[{agent:'codex',boundary:'sandbox-read',destination:'provider-managed',model:'my-model',inputBytes:100,event:'denied'}],providerData:{providers:[{id:'fixture',origin:'https://example.invalid',scope:'remote',configured:true,blocked:true,targetDigest:'snapshot'}],recent:[{provider:'fixture',origin:'https://example.invalid',model:'my-model',event:'started',inputBytes:100}]}}),{status:200});}) as any;
    window.eval(scripts.find(s=>s.includes('const entries=')&&s.includes('window.wentianUi'))!);
    window.eval(scripts.find(s=>s.includes('executionDestination')&&s.includes('let initialized'))!);
    await window.happyDOM.waitUntilComplete();
    for(const [language,expected]of [['ja','読取り専用サンドボックス'],['en','Read-only sandbox'],['zh','只读沙箱']]){
      window.localStorage.setItem('wentian-language',language);window.document.dispatchEvent(new window.Event('wentian-language-changed'));(window as any).wentianUi.apply();await window.happyDOM.waitUntilComplete();
      assert.ok(window.document.getElementById('executionRecent')!.textContent!.includes(expected));
      assert.equal((window.document.getElementById('executionRoot') as any).value,'C:/作業/项目');
      assert.ok(window.document.getElementById('dataTarget')!.textContent!.includes('https://example.invalid'));
      (window.document.getElementById('executionShare') as any).checked=true;(window as any).confirm=()=>false;
      (window.document.getElementById('executionGrant') as any).click();await window.happyDOM.waitUntilComplete();
      assert.equal(window.document.getElementById('executionResult')!.textContent,'');
      (window.document.getElementById('dataResume') as any).click();await window.happyDOM.waitUntilComplete();
      assert.equal(window.document.getElementById('executionResult')!.textContent,'');
    }
    // 保守の範囲選択だけでは許可を送信せず、同意チェックも持ち越しません。
    const scope=window.document.getElementById('executionScope') as any;
    for(const [value,root] of [['connection','C:/test/connection'],['work','C:/test/work']]) {
      (window.document.getElementById('executionShare') as any).checked=true;
      (window.document.getElementById('executionHost') as any).checked=true;
      scope.value=value;scope.dispatchEvent(new window.Event('change'));
      assert.equal((window.document.getElementById('executionRoot') as any).value,root);
      assert.equal((window.document.getElementById('executionShare') as any).checked,false);
      assert.equal((window.document.getElementById('executionHost') as any).checked,false);
    }
    assert.equal(requests.some(r=>r.startsWith('POST')),false);
  }finally{await window.happyDOM.close();}
});
