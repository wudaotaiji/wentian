import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { readKnowledgeResource } from './knowledge-resource.js';
import { renderKnowledgePage, extractKnowledgeFile } from './knowledge-extraction.js';
import { ProjectKnowledgeStore } from './project-knowledge.js';
import { KnowledgeCollectionJobs } from './knowledge-collection-jobs.js';

const execute=promisify(execFile);
test('配布サンプルで実HTTP収集・JS描画・Cookieログイン・版更新・認証復旧を確認する',{timeout:60000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-demo-package-')),directory=path.join(root,'sample'),script=path.resolve('scripts/knowledge-demo.py');
 const python=process.env.WENTIAN_DEMO_PYTHON||'python';
 const run=(action:string)=>execute(python,[script,action,'--directory',directory],{env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 const variables=['WENTIAN_KNOWLEDGE_SOURCES_FILE','WENTIAN_KNOWLEDGE_PROXY'] as const,previous=variables.map(key=>process.env[key]);
 let child:ReturnType<typeof spawn>|undefined,browser;
 try{
  await run('prepare');await run('verify');
  child=spawn(python,[script,'serve','--directory',directory,'--port','0'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  let state:any;for(let n=0;n<100;n++){state=JSON.parse(await readFile(path.join(directory,'state.json'),'utf8'));if(state.origin)break;await new Promise(resolve=>setTimeout(resolve,50))}
  assert.ok(state.origin,'配信サーバーが起動する');
  process.env.WENTIAN_KNOWLEDGE_SOURCES_FILE=path.join(directory,'sources.json');process.env.WENTIAN_KNOWLEDGE_PROXY='';
  const profiles=JSON.parse(await readFile(path.join(directory,'sources.json'),'utf8')),publicProfile=profiles[0],headerProfile=profiles[1],cookieProfile=profiles[2];
  const read=(suffix:string,profile=publicProfile)=>readKnowledgeResource(state.origin+suffix,AbortSignal.timeout(10000),profile);
  assert.match((await read('/policy')).bytes.toString(),/12,000/);
  await assert.rejects(read('/private/policy'),/認証/);
  assert.match((await read('/private/policy',headerProfile)).bytes.toString(),/12,000/);
  await assert.rejects(read('/files/..%2Fsources.json'),/正常/);
  const dynamic=await renderKnowledgePage(state.origin+'/js',{profile:publicProfile,signal:AbortSignal.timeout(20000)});assert.match(dynamic.content,/受講者4人/);
  browser=await chromium.launch({headless:true,...(process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE?{executablePath:process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE}:{})});
  const context=await browser.newContext(),page=await context.newPage();await page.goto(state.origin+'/login');await page.getByRole('button',{name:'サンプルとしてログイン'}).click();await context.storageState({path:cookieProfile.storageStatePath});
  const privateDynamic=await renderKnowledgePage(state.origin+'/private/js',{profile:cookieProfile,signal:AbortSignal.timeout(20000)});assert.match(privateDynamic.content,/受講者4人/);
  const pdf=await extractKnowledgeFile(await read('/files/07-policy-table.pdf'),AbortSignal.timeout(10000));assert.match(pdf.content,/12,000/);assert.match(pdf.content,/96,000/);
  const scan=await extractKnowledgeFile(await read('/files/09-scan-checklist.pdf'),AbortSignal.timeout(10000),async()=> '申請日：2026年11月2日。予約状況：未予約。');assert.match(scan.content,/未予約/);
  const wav=await read('/files/10-meeting-ja.wav');assert.equal(wav.bytes.subarray(0,4).toString(),'RIFF');assert.equal(wav.bytes.subarray(8,12).toString(),'WAVE');
  const store=new ProjectKnowledgeStore({root:path.join(root,'knowledge')});
  const jobs=await KnowledgeCollectionJobs.open(path.join(root,'jobs'),store,async()=>true);
  try{
   const job=jobs.create('demo-knowledge','fixture',{url:state.origin+'/private/policy',mode:'sync',intervalMs:1000,profileId:'demo-header',render:false,followLinks:false,maxPages:1});await jobs.tick();assert.equal(jobs.list('demo-knowledge')[0].documents,1);
   await run('revision2');await jobs.tick(Date.now()+5000);const docs=await store.list('demo-knowledge');assert.equal(docs[0].revision,2);assert.match((await store.get('demo-knowledge',docs[0].documentId)).content,/15,000/);
   await run('expire');await jobs.tick(Date.now()+10000);assert.equal(jobs.list('demo-knowledge')[0].status,'paused');
   await run('activate');jobs.action('demo-knowledge',job.id,'resume');await jobs.tick(Date.now()+15000);assert.equal(jobs.list('demo-knowledge')[0].status,'queued');assert.equal(jobs.list('demo-knowledge')[0].lastError,undefined);
   await assert.rejects(read('/private/policy',headerProfile),/認証/);
   const latestProfiles=JSON.parse(await readFile(path.join(directory,'sources.json'),'utf8'));assert.match((await read('/private/policy',latestProfiles[1])).bytes.toString(),/15,000/);
  }finally{await jobs.close()}
  const tooLate=await execute(python,[script,'prepare','--directory',directory],{env:{...process.env,PYTHONIOENCODING:'utf-8'}}).then(()=>false,()=>true);assert.equal(tooLate,true,'既存のサンプル領域を上書きしない');
 }finally{await browser?.close();if(child){const closed=new Promise(resolve=>child!.once('exit',resolve));child.kill();await closed}variables.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index]});await rm(root,{recursive:true,force:true})}
});
