import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Script } from 'node:vm';
import { agentMaintenanceHtml, agentMaintenanceScript } from './agent-maintenance-ui.js';
import { managerDashboardHtml } from './dashboard.js';
import { withAppearance } from './appearance-ui.js';

for(const language of ['ja','en','zh'])test(`${language}でAI判断・承認要求・証跡を表示し、言語切替と未確認状態を維持する`,async()=>{
 const window=new Window({url:'http://localhost/#agents'});window.setInterval=(()=>0) as any;
 window.localStorage.setItem('wentian-language',language);
 const diagnosis={ja:'実行許可の期限が切れています。',en:'The execution grant expired.',zh:'执行许可已过期。'};
 const nextStep={ja:'実行権限画面で専用領域を承認してください。',en:'Approve the dedicated workspace in Execution permissions.',zh:'请在执行权限页面批准专用工作区。'};
 const state={state:'waiting',settings:{enabled:true,intervalMs:300000,retryIntervalMs:30000},targets:[],excludedAgents:[]};
 const report={agent:'kilo',status:'needs_approval',updatedAt:'2026-10-29T05:00:00Z',decision:{diagnosis,nextStep,evidence:['cycle:1']}};
 window.fetch=(async(url:any)=>new window.Response(JSON.stringify(String(url).endsWith('/me')?{user:{role:'admin'}}:String(url).endsWith('/maintenance/ai')?{reports:[report,{agent:'cline',status:'unconfirmed',plannerError:'非公開の診断'}]}:String(url).endsWith('/maintenance-controls')?{connection:{allowed:true},media:{allowed:true}}:state))) as any;
 const settle=async()=>{for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
 try{
  const html=withAppearance(`<html><head></head><body>${agentMaintenanceHtml}<script></script></body></html>`);
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g,''));
  const appearance=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match=>match[1].includes('window.wentianUi={t,apply,language}'))!;
  window.eval(appearance[1]);window.eval(agentMaintenanceScript);await settle();
  const text=window.document.getElementById('maintenanceAiReports')!.textContent!;
  assert.ok(text.includes(diagnosis[language as keyof typeof diagnosis]));assert.ok(text.includes(nextStep[language as keyof typeof nextStep]));assert.match(text,/cycle:1/);assert.doesNotMatch(text,/非公開/);
  assert.match(text,language==='ja'?/承認が必要/:language==='en'?/Approval required/:/需要批准/);
  assert.match(text,language==='ja'?/AI判断は未確認/:language==='en'?/AI decision unconfirmed/:/AI判断未确认/);
  window.localStorage.setItem('wentian-language','en');window.document.dispatchEvent(new window.Event('wentian-language-changed'));await settle();
  assert.ok(window.document.getElementById('maintenanceAiReports')!.textContent!.includes(diagnosis.en));
  assert.equal(window.document.getElementById('maintenanceAiReports')!.querySelectorAll('article').length,2);
 }finally{await window.happyDOM.close();}
});

for(const language of ['ja','en','zh'])test(`${language}で計測失敗理由・計測時刻と警告中の保守保留を区別して表示する`,async()=>{
 const window=new Window({url:'http://localhost/#agents'});window.setInterval=(()=>0) as any;window.localStorage.setItem('wentian-language',language);
 const state:any={state:'error',resourcePaused:true,lastError:'資源使用率を確認できないため保守を一時停止します。',settings:{enabled:true,intervalMs:60000,retryIntervalMs:60000},targets:[],excludedAgents:[],resources:{state:'unknown',checkedAt:'2026-10-24T00:00:00Z',reason:'資源計測が30秒の待機上限を超えました。'}};
 window.fetch=(async(url:any)=>new window.Response(JSON.stringify(String(url).endsWith('/me')?{user:{role:'admin'}}:String(url).endsWith('/maintenance-controls')?{connection:{allowed:true},media:{allowed:true}}:state))) as any;
 const settle=async()=>{for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve))};
 try{
  const html=withAppearance(`<html><head></head><body>${agentMaintenanceHtml}<script></script></body></html>`);window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g,''));
  const appearance=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match=>match[1].includes('window.wentianUi={t,apply,language}'))!;
  window.eval(appearance[1]);window.eval(agentMaintenanceScript);await settle();
  assert.match(window.document.getElementById('maintenanceResourceReason')!.textContent!,/30/);assert.match(window.document.getElementById('maintenanceResourceMeasured')!.textContent!,/2026/);
  state.resources={state:'warning',checkedAt:'2026-10-24T00:00:10Z',usage:{cpu:10,memory:82,disk:0,network:0,diskCapacity:61}};
  window.document.dispatchEvent(new window.Event('wentian-control-refresh'));await settle();
  assert.equal(window.document.getElementById('maintenanceStatus')!.getAttribute('data-level'),'paused');assert.match(window.document.getElementById('maintenanceError')!.textContent!,language==='en'?/recovered/:language==='zh'?/已恢复/:/回復/);
  assert.match(window.document.querySelector('.maintenance-resource-note')!.textContent!,/90%/);assert.doesNotMatch(window.document.querySelector('.maintenance-resource-note')!.textContent!,/低于80|below 80|80%未満/);
  assert.equal(window.document.querySelector('[data-resource="memory"] .maintenance-resource-value')!.textContent,'82.0%');
  assert.doesNotMatch(window.document.getElementById('maintenanceError')!.textContent!,/无法测量|Unable to measure|確認できない/);
 }finally{await window.happyDOM.close()}
});

test('管理画面の保守操作は同じAPIを使い、次回実行・一時停止・進捗を表示する',async()=>{
  const window=new Window({url:'http://localhost/#agents'});window.setInterval=(()=>0) as any;
  const calls:any[]=[];
  const permissions={connection:{allowed:true,source:'default',environmentAllowed:true,editable:true},media:{allowed:true,source:'default',environmentAllowed:true,editable:true}};
  let state:any={state:'waiting',settings:{enabled:true,intervalMs:60000,retryIntervalMs:30000,autoInstall:false,verifyWork:true},targets:['kilo'],excludedAgents:['goose'],pendingAgents:[],nextRunAt:'2026-10-18T00:00:00Z'};
  window.fetch=(async(url:any,options:any={})=>{
    if(String(url).endsWith('/maintenance-controls'))return new window.Response(JSON.stringify(permissions));
    if(String(url).endsWith('/me'))return new window.Response(JSON.stringify({user:{role:'admin'}}));
    if(options.method==='POST'){const body=JSON.parse(options.body);calls.push(body);if(body.action==='stop')state={...state,state:'stopped',settings:{...state.settings,enabled:false},nextRunAt:undefined};if(body.action==='configure')state={...state,settings:{...state.settings,...body.settings}};}
    return new window.Response(JSON.stringify(state));
  }) as any;
  const settle=async()=>{for(let i=0;i<25;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
  try{
    new Script(agentMaintenanceScript);
    assert.match(managerDashboardHtml,/id="agentMaintenance"/);
    window.document.write(agentMaintenanceHtml);window.eval(agentMaintenanceScript);await settle();
    assert.match(window.document.getElementById('maintenanceTargets')!.textContent!,/goose/);
    assert.match(window.document.getElementById('maintenanceSchedule')!.textContent!,/実際の次回実行/);
    (window.document.querySelector('[data-maintenance-action="stop"]') as any).click();await settle();
    assert.equal(calls[0].action,'stop');assert.match(window.document.getElementById('maintenanceStatus')!.textContent!,/自動保守停止中/);
    assert.equal(window.document.getElementById('maintenanceScheduled')!.textContent,'なし');
    const interval=window.document.getElementById('maintenanceInterval') as any;interval.value='45';interval.dispatchEvent(new window.Event('input',{bubbles:true}));
    window.document.getElementById('maintenanceForm')!.dispatchEvent(new window.Event('submit',{cancelable:true}));await settle();
    assert.equal(calls[1].settings.intervalMs,45000);
    (window.document.querySelector('[data-maintenance-action="run"]') as any).click();await settle();assert.equal(calls[2].action,'run');
  }finally{await window.happyDOM.close();}
});

for(const language of ['ja','en','zh'])test(`${language}で2つの実行許可を確認・保存し、再起動なしの結果を表示する`,async()=>{
 const window=new Window({url:'http://localhost/#agents'});window.setInterval=(()=>0) as any;
 window.localStorage.setItem('wentian-language',language);
 let permissions:any={connection:{allowed:false,source:'environment',environmentAllowed:false,editable:true},media:{allowed:true,source:'default',environmentAllowed:true,editable:true}};
 const state:any={state:'disabled',constraints:{connectionDisabled:true},settings:{enabled:true,intervalMs:60000,retryIntervalMs:30000,autoInstall:false,verifyWork:true},targets:['codex'],excludedAgents:[],pendingAgents:[]};
 const writes:any[]=[];
 window.fetch=(async(url:any,options:any={})=>{
  if(String(url).endsWith('/me'))return new window.Response(JSON.stringify({user:{role:'admin'}}));
  if(String(url).endsWith('/maintenance-controls')){
   if(options.method==='PUT'){
    const patch=JSON.parse(options.body);writes.push(patch);
    permissions={...permissions,connection:{...permissions.connection,allowed:patch.connection,source:'management'},media:{...permissions.media,allowed:patch.media,source:'management'}};
    state.constraints.connectionDisabled=!patch.connection;state.state=patch.connection?'waiting':'disabled';
   }
   return new window.Response(JSON.stringify({...permissions,message:'実行許可を保存し、稼働中の保守へ反映しました。Daemonの再起動は不要です。'}));
  }
  return new window.Response(JSON.stringify(state));
 }) as any;
 const settle=async()=>{for(let i=0;i<35;i++)await new Promise<void>(resolve=>setImmediate(resolve));};
 try{
  const html=withAppearance(`<html><head></head><body>${agentMaintenanceHtml}<script></script></body></html>`);
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g,''));
  const appearance=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match=>match[1].includes('window.wentianUi={t,apply,language}'))!;
  window.eval(appearance[1]);window.eval(agentMaintenanceScript);await settle();
  const input=window.document.getElementById('maintenanceControl-connection') as any;
  assert.equal(input.disabled,false);input.checked=true;input.dispatchEvent(new window.Event('input',{bubbles:true}));
  window.document.getElementById('maintenanceControlsForm')!.dispatchEvent(new window.Event('submit',{cancelable:true}));await settle();
  assert.deepEqual(writes,[{connection:true,media:true}]);
  const text=window.document.getElementById('maintenanceControlsMessage')!.textContent!;
  assert.match(text,language==='en'?/No daemon restart/:language==='zh'?/无需重启/:/再起動は不要/);
  assert.match(window.document.getElementById('maintenanceControl-connection-source')!.textContent!,language==='en'?/Saved in/:language==='zh'?/管理画面保存/:/管理画面/);
  if(language==='en')assert.doesNotMatch(window.document.getElementById('agentMaintenance')!.textContent!,/実行許可|保存設定|起動環境/);
 }finally{await window.happyDOM.close();}
});

test('保存設定が有効でも環境で禁止中なら実行不可と表示する',async()=>{
  const window=new Window({url:'http://localhost/#agents'});window.setInterval=(()=>0) as any;
  window.fetch=(async(url:any)=>new window.Response(JSON.stringify(String(url).endsWith('/me')?{user:{role:'admin'}}:String(url).endsWith('/maintenance-controls')?{connection:{allowed:false,source:'environment',environmentAllowed:false,editable:true},media:{allowed:true,source:'default',environmentAllowed:true,editable:true}}:{
    state:'disabled',settings:{enabled:true,intervalMs:60000,retryIntervalMs:30000,autoInstall:false,verifyWork:true},
    constraints:{connectionDisabled:true},targets:['codex'],pendingAgents:[],excludedAgents:[],
  }))) as any;
  try{
    window.document.write(agentMaintenanceHtml);window.eval(agentMaintenanceScript);
    for(let i=0;i<25;i++)await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(window.document.getElementById('maintenanceEnabled')!.textContent,'自動保守：実行許可により無効');
    assert.equal(window.document.getElementById('maintenanceEnabled')!.getAttribute('data-level'),'paused');
    assert.match(window.document.getElementById('maintenanceSavedSetting')!.textContent!,/保存設定：有効.*現在は実行禁止/);
    assert.equal((window.document.querySelector('[data-maintenance-action="start"]') as any).disabled,true);
    assert.equal((window.document.querySelector('[data-maintenance-action="run"]') as any).disabled,true);
  }finally{await window.happyDOM.close();}
});
