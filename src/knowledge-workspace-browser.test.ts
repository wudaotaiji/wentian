import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { registerProjectCenter } from './project-center.js';
import { registerProjectKnowledgeRoutes } from './project-knowledge-routes.js';

test('実ブラウザーで資料追加→回答→複数資料の提案→再保存→更新同期→再回答を通す（模擬モデル）',{timeout:90000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-knowledge-browser-')),app=Fastify();let browser;
 const errors:string[]=[];let current='年間20日。';
 try{
  registerProjectCenter(app,()=>true);
  app.get('/api/control-center/me',async()=>({user:{id:'fixture',role:'admin'}}));
  app.get('/api/team-access/projects',async()=>({projects:[{id:'alpha',name:'隔離検収'}]}));
  app.get('/api/team-access/projects/alpha/usage',async()=>({project:{id:'alpha',allowedModels:['fixture/model'],members:{fixture:'owner'},canManage:true,spendUsd:0,heldUsd:0,requestLimit:{maxRequests:120,windowMs:3600000}},keys:[]}));
  app.get('/api/workbench/groups',async()=>({groups:[]}));
  const {store}=registerProjectKnowledgeRoutes(app,()=>true,{root,readPage:async()=>({url:'https://example.invalid/rules',extracted:{title:'休暇規程',content:current,links:[]}}),workspace:{complete:()=>async messages=>{
   const last=messages.at(-1)!.content,input=last.startsWith('{')?JSON.parse(last):{};
   if(input.claims)return JSON.stringify({reviews:input.claims.map((c:any)=>({id:c.id,verdict:'supported',reason:'試験資料に一致。'}))});
   if(input.evidence){const evidence=input.evidence.filter((e:any)=>e.title==='休暇規程'||e.title==='給与.txt');return JSON.stringify({title:'隔離検収の成果',claims:evidence.map((hit:any,index:number)=>({id:'c'+index,kind:'fact',text:hit.excerpt,citations:[{chunkId:hit.chunkId,quote:hit.excerpt}]})),unresolved:[]})}
   return JSON.stringify({queries:['休暇規程','給与']});
  }}});
  await app.listen({host:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+(app.server.address() as any).port;
  let executablePath=process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE;
  if(!executablePath){try{await access(chromium.executablePath())}catch{if(process.platform==='win32')executablePath='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';else throw Error('検収ブラウザーが未準備です。')}}
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1080}});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/projects');await page.waitForFunction(()=>Boolean((document.getElementById('knowledgeModel') as HTMLSelectElement)?.value));
  await page.locator('#knowledgeFiles').setInputFiles({name:'給与.txt',mimeType:'text/plain',buffer:Buffer.from('給与の支払いは月末。')});
  await page.locator('#uploadKnowledge').click();await page.waitForFunction(()=>document.getElementById('knowledgeImportResult')!.textContent!.includes('給与.txt'));
  await page.locator('#collectUrl').fill('https://example.invalid/rules');await page.locator('#collectUrls').click();await page.waitForFunction(()=>document.getElementById('collectResult')!.textContent!.includes('休暇規程'));
  await page.locator('#knowledgeQuestion').fill('休暇の日数と給与の条件は？');
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/assistant'));await page.locator('#askKnowledge').click();const response=await responsePromise;assert.equal(response.status(),200,await response.text());await page.waitForFunction(()=>document.getElementById('knowledgeAnswer')!.textContent!.includes('年間20日'));
  await page.locator('#knowledgeMode').selectOption('proposal');await page.locator('#askKnowledge').click();await page.waitForFunction(()=>!(document.getElementById('publishKnowledge') as HTMLButtonElement).disabled);
  assert.match((await page.locator('#knowledgeAnswer').textContent())!,/給与の支払いは月末/);
   await page.locator('#publishKnowledge').click();await page.waitForFunction(()=>document.getElementById('knowledgeStatus')!.textContent!.includes('再保存しました'));
   assert.ok((await store.list('alpha')).some(d=>d.title==='隔離検収の成果'));
   // 保存結果が言語切替後も保持されることを確認します。
   for(const [language,saved] of [['en','Output Saved Back to the Knowledge Base.'],['zh','成果已保存回知识库。'],['ja','成果を知識庫へ再保存しました。']]){
    await page.locator('#language').selectOption(language);
    await page.waitForFunction(expected=>document.documentElement.lang===expected,language);
    assert.equal(await page.locator('#knowledgeStatus').textContent(),saved);
   }
   current='年間25日。';await page.locator('#collectUrls').click();await page.waitForFunction(()=>document.getElementById('collectResult')!.textContent!.includes('改訂 2'));
   await page.locator('#askKnowledge').click();await page.waitForFunction(()=>document.getElementById('knowledgeAnswer')!.textContent!.includes('年間25日'));
   assert.doesNotMatch((await page.locator('#knowledgeAnswer').textContent())!,/年間20日/);
   // 埋め込み未設定の失敗理由も、日本語・英語・中国語で表示できることを確認します。
   await page.locator('#prepareKnowledgeIndex').click();
   await page.waitForFunction(()=>document.getElementById('knowledgeIndexStatus')!.textContent!.includes('埋め込み接続先とモデル'));
   assert.match((await page.locator('#knowledgeIndexStatus').textContent())!,/埋め込み接続先とモデル/);
   // 言語切替で状態と操作だけを翻訳し、資料由来の本文・モデルIDは変えません。
   const revisedAnswer=await page.locator('#knowledgeAnswer').textContent();
   const languageChecks: [string,string,string,string,string,RegExp,RegExp][] = [
    ['ja','プロジェクトと資料','AI根拠検証済み・人間未承認','最新資料で回答・作成','検索索引を作成・再開',/埋め込み接続先とモデル/,/利用者ID/],
    ['en','Projects & Resources','AI Evidence Review Complete; Human Approval Pending','Answer / Create Using Current Documents','Create / Resume Search Index',/No embedding model/,/User ID/],
    ['zh','项目与资料','AI依据核验完成，待人工批准','使用最新资料回答／生成','创建／继续搜索索引',/未配置嵌入模型/,/用户ID/],
   ];
   for(const [language,title,status,button,indexButton,indexError,membership] of languageChecks){
    await page.locator('#language').selectOption(language);
    await page.waitForFunction(expected=>document.documentElement.lang===expected,language);
    assert.equal(await page.locator('#viewTitle').textContent(),title);
    assert.equal(await page.locator('#knowledgeStatus').textContent(),status);
    assert.equal(await page.locator('#askKnowledge').textContent(),button);
    assert.equal(await page.locator('#prepareKnowledgeIndex').textContent(),indexButton);
    assert.match((await page.locator('#knowledgeIndexStatus').textContent())!,indexError);
    assert.match((await page.locator('#membership').textContent())!,membership);
    const limits=await page.locator('#projectLimits').textContent();
    assert.match(limits!,/120/);
    assert.doesNotMatch(limits!,/\{[a-z]+\}/i);
    assert.equal(await page.locator('#knowledgeAnswer').textContent(),revisedAnswer);
    assert.equal(await page.locator('#knowledgeModel').inputValue(),'fixture/model');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    if(process.env.WENTIAN_KNOWLEDGE_TEST_EVIDENCE){const folder=path.resolve(process.env.WENTIAN_KNOWLEDGE_TEST_EVIDENCE);await mkdir(folder,{recursive:true});await page.screenshot({path:path.join(folder,`knowledge-${language}.png`),fullPage:true})}
   }
  await page.locator('#language').selectOption('ja');
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#knowledgeDownloads a').filter({hasText:'DOCX'}).click()]);assert.equal(download.suggestedFilename(),'knowledge-artifact.docx');
  if(process.env.WENTIAN_KNOWLEDGE_TEST_EVIDENCE){const folder=path.resolve(process.env.WENTIAN_KNOWLEDGE_TEST_EVIDENCE);await mkdir(folder,{recursive:true});await page.screenshot({path:path.join(folder,'knowledge-workspace.png'),fullPage:true})}
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await app.close();await rm(root,{recursive:true,force:true})}
});
