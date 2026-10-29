import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { withAppearance } from './appearance-ui.js';
import { workflowCenterHtml } from './workflow-center.js';
import { plannerTrainingPage } from './planner-training-ui.js';
import { managerDashboardHtml } from './dashboard.js';

// 全APIをブラウザー内の固定応答へ置換し、実際の学習・削除・導入は実行しません。
for(const [name,source] of Object.entries({workflows:workflowCenterHtml,training:plannerTrainingPage(),management:managerDashboardHtml})){
 test(`${name}の動的UIを日英中で切り替え、値と利用者データを保持する`,async()=>{
  const window=new Window({url:'http://localhost/'});
  let residencyEnabled=true;
  window.setInterval=(()=>0) as any;
  window.fetch=(async(url:unknown)=>{
   const address=String(url).split('?')[0];let body:any={};
   if(address.endsWith('/me'))body={user:{displayName:'利用者の名前',role:'admin'}};
   if(address.includes('planner-training'))body={model:'model-test',python:'python-test',examples:30,running:false,fallback:true,runs:[{id:'run-test',status:'succeeded',steps:10,progress:{step:10,loss:0.12,elapsedSeconds:5},curve:[],report:{correct:10,evaluated:10,accuracy:1,unsafeWrites:0}}]};
   if(address.endsWith('/workflows'))body={workflows:[{id:'workflow-test',status:'draft',maxConcurrency:2,updatedAt:'2026-10-22',nodes:[{id:'node-test',status:'pending',attempts:0,dependencies:[],allowedWritePaths:[],changes:[]}],history:[]}]};
   if(address.endsWith('/status'))body={needsSetup:false,memory:{},providers:[]};
   if(address.endsWith('/external-agents'))body={summary:{},agents:[]};
   if(address.endsWith('/residency'))body={enabled:residencyEnabled,managedModels:['model-test'],active:{'model-test':1}};
   if(address.endsWith('/control-plane'))body={observedAt:'2026-10-22',features:[],evidence:{tests:[],benchmark:{samples:[]}},verifications:[],limits:{maxAttempts:3,maxRuntimeMs:60000,maxTokens:1000}};
   if(address.endsWith('/models'))body={data:[{id:'model-test',metadata:{resourceScope:'local'}},{id:'model-unmanaged',metadata:{resourceScope:'local'}}]};
   if(address.includes('agent-marketplace'))body={candidates:[{id:'agent-test',name:'候補',repository:'owner/sample',liveState:'healthy',compatibility:'windows',note:'OpenAI公式CLI',installed:false,installSupported:true}],uninstalledAgents:[]};
   if(address.endsWith('/trash'))body={items:[{id:'trash-test',title:'利用者のサイト名',page:'site-test',at:'2026-10-22'}]};
   if(address.endsWith('/templates'))body={templates:[]};
   return new window.Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  }) as any;
  try{
   const html=withAppearance(source);
   window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g,''));
   for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))window.eval(match[1]);
   for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));
   const doc=window.document;
   for(const locale of ['en','zh','ja','en']){
    const language=doc.getElementById('language') as any;language.value=locale;language.dispatchEvent(new window.Event('change',{bubbles:true}));
    for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));
    if(name==='management'){
     residencyEnabled=locale!=='zh';doc.dispatchEvent(new window.Event('wentian-control-refresh'));for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));
     assert.ok(doc.getElementById('preloadModel'),'モデル常駐欄を実際に描画する');
     // ナビゲーションが生成する説明も、実際に切り替えた画面で検査します。
     (doc.querySelector('.nav-rail [data-view="site-trash"]') as any).click();for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));
    }
    const roots=name==='management'?[doc.getElementById('marketplace')!.closest('.panel')!,doc.getElementById('siteTrashPanel')!,doc.getElementById('lifeResult')!.closest('.nav-view')!,doc.getElementById('viewLead')!]:[doc.querySelector('main')!];
    const remaining=new Set<string>();
    for(const root of roots){const walker=doc.createTreeWalker(root,4);let node;while((node=walker.nextNode())){
     if(node.parentElement!.closest('script,style,pre:not([data-ui-message]),code,textarea,[data-no-translate],#marketplace td:nth-child(2) strong'))continue;
     const value=node.textContent!.trim();
     if((locale==='en'?/[\u3040-\u30ff\u3400-\u9fff]/:/[\u3040-\u30ff]/).test(value)&&locale!=='ja')remaining.add(value);
    }}
    assert.deepEqual([...remaining],[],`${locale}の未翻訳UI`);
    if(name==='training')assert.equal((doc.getElementById('device') as any).value,'auto');
    if(name==='workflows')assert.equal((doc.getElementById('workflowFilter') as any).value,'');
    if(name==='management')assert.equal(doc.querySelector('#marketplace td:nth-child(2) strong')!.textContent,'候補');
    if(name==='management'){
     assert.match(doc.getElementById('siteTrashList')!.textContent!,/利用者のサイト名/);
     let confirmation='';(window as any).confirm=(text:string)=>{confirmation=text;return false;};
     (doc.querySelector('#siteTrashList button') as any).click();
     assert.ok(confirmation.includes('利用者のサイト名'));
     if(locale==='en')assert.ok(confirmation.includes('Permanently delete'));
     if(locale==='zh')assert.ok(confirmation.includes('永久删除'));
    }
   }
  }finally{await window.happyDOM.close();}
 });
}
