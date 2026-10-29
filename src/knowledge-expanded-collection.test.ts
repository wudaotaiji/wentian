import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { KnowledgeCollectionJobs } from './knowledge-collection-jobs.js';
import { ProjectKnowledgeStore } from './project-knowledge.js';
import { collectProjectUrls } from './knowledge-url-collector.js';
import { knowledgeTarget, knowledgeProfiles, readKnowledgeResource, type KnowledgeResource, type KnowledgeSourceProfile } from './knowledge-resource.js';
import { extractKnowledgeFile, extractKnowledgeImage, profileCookie, renderKnowledgePage } from './knowledge-extraction.js';
import { registerProjectKnowledgeRoutes } from './project-knowledge-routes.js';

async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'wentian-expanded-knowledge-'));return{root,store:new ProjectKnowledgeStore({root:path.join(root,'knowledge')}),close:()=>rm(root,{recursive:true,force:true})}}
/** 最小PDFを一時メモリー内で生成し、利用者の資料を試験へ持ち込みません。 */
function pdfFixture(text:boolean){
  const stream=text?'BT /F1 12 Tf 30 100 Td (PDF_TEXT_FIXTURE) Tj ET':'0.5 g 20 20 50 50 re f';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let source='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,index)=>{offsets.push(Buffer.byteLength(source));source+=`${index+1} 0 obj\n${obj}\nendobj\n`});const start=Buffer.byteLength(source);source+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;return Buffer.from(source);
}
function resource(bytes:Buffer,contentType:string,url='https://fixture.invalid/source'):KnowledgeResource{return{url,bytes,contentType,status:200,headers:{}}}

test('認証プロファイルは接続元とプロジェクトを固定し、DNSの内部IP・Cookieの範囲も検査する',async()=>{
  const f=await fixture();
  try{
    const file=path.join(f.root,'sources.json'),state=path.join(f.root,'session.json');
    await writeFile(state,JSON.stringify({cookies:[{name:'session',value:'fixture-only',domain:'fixture.invalid',path:'/docs',expires:Date.now()/1000+1000,secure:true},{name:'other',value:'not-forwarded',domain:'other.invalid',path:'/',expires:-1}]}));
    const profile:KnowledgeSourceProfile={id:'source-a',projects:['alpha'],origins:['https://fixture.invalid'],storageStatePath:state};
    await writeFile(file,JSON.stringify([profile]));assert.equal((await knowledgeProfiles(file))[0].id,'source-a');
    const resolve=(async()=>[{address:'127.0.0.1',family:4}]) as any;
    await assert.rejects(knowledgeTarget('https://fixture.invalid/docs',profile,resolve),/内部/);
    assert.equal((await knowledgeTarget('https://fixture.invalid/docs',{...profile,allowPrivate:true},resolve)).address.address,'127.0.0.1');
    await assert.rejects(knowledgeTarget('https://other.invalid/docs',profile,resolve),/接続元/);
    assert.equal((await profileCookie('https://fixture.invalid/docs/page',profile)).cookie,'session=fixture-only');
    assert.deepEqual(await profileCookie('https://fixture.invalid/docs-other',profile),{});
    assert.deepEqual(await profileCookie('http://fixture.invalid/docs/page',profile),{});
  }finally{await f.close()}
});

test('PDF本文とスキャンPDFの描画・OCR、画像を同じ収集本文へ変換する',async()=>{
  const signal=new AbortController().signal,old=process.env.WENTIAN_KNOWLEDGE_VISION_MODEL;delete process.env.WENTIAN_KNOWLEDGE_VISION_MODEL;
  try{
    const text=await extractKnowledgeFile(resource(pdfFixture(true),'application/pdf'),signal);
    assert.match(text.content,/PDF_TEXT_FIXTURE/);
    assert.ok(text.warnings?.length);
    let images=0;
    const scan=await extractKnowledgeFile(resource(pdfFixture(false),'application/pdf'),signal,async bytes=>{images++;assert.equal(bytes.subarray(1,4).toString(),'PNG');return'スキャン画像から読めた本文'});
    assert.match(scan.content,/スキャン画像/);assert.equal(images,1);
    const image=await extractKnowledgeFile(resource(Buffer.from('image-fixture'),'image/png'),signal,async()=> '画像内の資料本文');
    assert.equal(image.content,'画像内の資料本文');
  }finally{if(old===undefined)delete process.env.WENTIAN_KNOWLEDGE_VISION_MODEL;else process.env.WENTIAN_KNOWLEDGE_VISION_MODEL=old}
});

test('Visionの構造化判断が未確認なら保存可能な本文として採用しない',async()=>{
  const names=['WENTIAN_KNOWLEDGE_VISION_MODEL','WENTIAN_KNOWLEDGE_VISION_BASE_URL'] as const;const old=names.map(n=>process.env[n]);
  process.env[names[0]]='fixture-model';process.env[names[1]]='https://fixture.invalid/v1';
  try{
    const request=(confirmed:boolean)=> (async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({confirmed,text:'読み取った情報'})},finish_reason:'stop'}]}))) as typeof fetch;
    await assert.rejects(extractKnowledgeImage(Buffer.from('fixture'),'image/png',new AbortController().signal,request(false)),/確認/);
    assert.equal(await extractKnowledgeImage(Buffer.from('fixture'),'image/png',new AbortController().signal,request(true)),'読み取った情報');
  }finally{names.forEach((n,index)=>{if(old[index]===undefined)delete process.env[n];else process.env[n]=old[index]})}
});

test('音声URLの内容を設定済み文字起こしAPIへ渡し、本文を抽出する',async()=>{
  const keys=['WENTIAN_KNOWLEDGE_TRANSCRIPTION_MODE','WENTIAN_KNOWLEDGE_TRANSCRIPTION_MODEL','WENTIAN_KNOWLEDGE_TRANSCRIPTION_BASE_URL'] as const;
  const old=keys.map(key=>process.env[key]),originalFetch=globalThis.fetch;
  delete process.env[keys[0]];process.env[keys[1]]='fixture-asr';process.env[keys[2]]='https://asr.invalid/v1';
  globalThis.fetch=(async(url,init)=>{assert.equal(String(url),'https://asr.invalid/v1/audio/transcriptions');const form=init?.body as FormData;assert.equal(form.get('model'),'fixture-asr');assert.equal(await(form.get('file') as Blob).text(),'RIFF0000WAVEfixture-audio');return new Response(JSON.stringify({text:'音声から抽出した資料本文'}))}) as typeof fetch;
  try{const result=await extractKnowledgeFile(resource(Buffer.from('RIFF0000WAVEfixture-audio'),'audio/wav','https://fixture.invalid/audio.wav'),new AbortController().signal);assert.equal(result.content,'音声から抽出した資料本文');await assert.rejects(extractKnowledgeFile(resource(Buffer.from('#EXTM3U\nfile:/private/audio.wav'),'audio/wav'),new AbortController().signal),/実形式/)}
  finally{globalThis.fetch=originalFetch;keys.forEach((key,index)=>{if(old[index]===undefined)delete process.env[key];else process.env[key]=old[index]})}
});

test('10万文字を超える資料を省略せず分割し、短縮時は旧収集パートを原子的に除去する',async()=>{
  const f=await fixture();
  try{
    const content='全'.repeat(210000);
    const first=await collectProjectUrls(f.store,'alpha',{url:'https://fixture.invalid/doc'},async()=>true,async url=>({url,extracted:{title:'長い資料',content,links:[]}}));
    assert.equal(first.documents.length,3);
    const texts=await Promise.all(first.documents.map(d=>f.store.get('alpha',d.documentId)));assert.equal(texts.map(d=>d.content).join(''),content);
    const next=await collectProjectUrls(f.store,'alpha',{url:'https://fixture.invalid/doc'},async()=>true,async url=>({url,extracted:{title:'長い資料',content:'短くした資料',links:[]}}));
    assert.equal(next.documents.length,1);assert.equal((await f.store.list('alpha')).length,1);
  }finally{await f.close()}
});

test('継続収集がバッチを越えて進み、停止・再起動・定期同期・権限取り消しを処理する',async()=>{
  const f=await fixture();let permitted=true;const read=async(url:string)=>({url,body:'<p>本文</p><a href="/next">次の資料</a>',contentType:'text/html'});
  let jobs=await KnowledgeCollectionJobs.open(path.join(f.root,'jobs'),f.store,async()=>permitted,read);
  try{
    const job=jobs.create('alpha','owner',{url:'https://fixture.invalid/start',followLinks:true,maxPages:1,mode:'continuous',intervalMs:1000});
    await jobs.tick(Date.now()+10);assert.equal(jobs.list('alpha')[0].pendingCount,1);
    jobs.action('alpha',job.id,'pause');assert.equal(jobs.list('alpha')[0].status,'paused');
    await jobs.close();jobs=await KnowledgeCollectionJobs.open(path.join(f.root,'jobs'),f.store,async()=>permitted,read);
    assert.equal(jobs.list('alpha')[0].status,'paused');jobs.action('alpha',job.id,'resume');await jobs.tick(Date.now()+10000);
    assert.equal((await f.store.list('alpha')).length,2);assert.equal(jobs.list('alpha')[0].status,'queued');
    permitted=false;await jobs.tick(Date.now()+20000);assert.equal(jobs.list('alpha')[0].status,'failed');
    jobs.action('alpha',job.id,'delete');assert.equal(jobs.list('alpha').length,0);
    permitted=true;const sync=jobs.create('alpha','owner',{url:'https://fixture.invalid/start',followLinks:false,maxPages:1,mode:'sync',intervalMs:1000});
    await jobs.tick(Date.now()+30000);await jobs.tick(Date.now()+40000);assert.equal(jobs.list('alpha')[0].runs,2);jobs.action('alpha',sync.id,'pause');
  }finally{await jobs.close();await f.close()}
});

test('Gateway終了による中断は利用者の一時停止と区別し、再起動で自動再開する',async()=>{
  const f=await fixture();let notify!:()=>void;
  const entered=new Promise<void>(resolve=>{notify=resolve});
  let jobs=await KnowledgeCollectionJobs.open(path.join(f.root,'jobs'),f.store,async()=>true,async(_url,signal)=>{notify();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('試験用中断')),{once:true});if(signal.aborted)reject(new Error('試験用中断'))});throw new Error('終了確認用')});
  try{
    jobs.create('alpha','owner',{url:'https://fixture.invalid/page',followLinks:false,mode:'once',intervalMs:1000});
    const running=jobs.tick(Date.now()+10);await entered;await jobs.close();await running;
    jobs=await KnowledgeCollectionJobs.open(path.join(f.root,'jobs'),f.store,async()=>true,async url=>({url,body:'<p>再開後に取得した本文</p>'}));
    assert.equal(jobs.list('alpha')[0].status,'queued');assert.equal(jobs.list('alpha')[0].pendingCount,1);
    await jobs.tick(Date.now()+1000);assert.equal(jobs.list('alpha')[0].status,'completed');assert.equal((await f.store.list('alpha')).length,1);
  }finally{await jobs.close();await f.close()}
});

test('実ブラウザーが認証済みの模擬サイトのJavaScriptを描画し、IP固定の通信経路で取得する',async()=>{
  const executable=process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE;
  // 通常はPlaywright同梱Chromium。検証環境だけ明示された実行ファイルに切替可能です。
  const old=process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE;
  let chosen=executable;
  if(!chosen){const {chromium}=await import('playwright');try{await access(chromium.executablePath());chosen=chromium.executablePath()}catch{}}
  if(!chosen&&process.platform==='win32')for(const candidate of ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe']){try{await access(candidate);chosen=candidate;break}catch{}}
  if(chosen)process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE=chosen;
  let reads=0;
  const server=createServer((req,res)=>{
    if(req.headers.authorization!=='Bearer fixture-only'){res.writeHead(401);res.end();return}
    reads++;res.setHeader('content-type',req.url==='/data'||req.url==='/json'?'application/json':'text/html');
    res.end(req.url==='/json'?JSON.stringify({markup:'<main>情報</main>',count:2}):req.url==='/data'?JSON.stringify({text:'JavaScriptで取得した認証資料'}):'<title>描画資料</title><div id="content"></div><script>fetch("/data").then(r=>r.json()).then(d=>document.getElementById("content").textContent=d.text)</script>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+(server.address() as any).port;
  try{
    const result=await renderKnowledgePage(origin+'/app',{signal:AbortSignal.timeout(60000),profile:{id:'test',projects:['alpha'],origins:[origin],allowPrivate:true,headers:{authorization:'Bearer fixture-only'},selector:'#content'}});
    assert.equal(result.content,'JavaScriptで取得した認証資料');assert.ok(reads>=2);assert.deepEqual(result.warnings,[]);
    const f=await fixture(),previous=process.env.WENTIAN_KNOWLEDGE_SOURCES_FILE;
    try{
      const file=path.join(f.root,'sources.json');await writeFile(file,JSON.stringify([{id:'test',projects:['alpha'],origins:[origin],allowPrivate:true,headers:{authorization:'Bearer fixture-only'},selector:'#content'}]));process.env.WENTIAN_KNOWLEDGE_SOURCES_FILE=file;
      const collected=await collectProjectUrls(f.store,'alpha',{url:origin+'/app',render:true,profileId:'test'},async()=>true);
      assert.equal(collected.complete,true);assert.equal((await f.store.get('alpha',collected.documents[0].documentId)).content,'JavaScriptで取得した認証資料');
      assert.doesNotMatch(JSON.stringify(collected),/fixture-only/);
      const json=await collectProjectUrls(f.store,'alpha',{url:origin+'/json',render:true,profileId:'test'},async()=>true);
      assert.equal(json.complete,true);assert.equal(JSON.parse((await f.store.get('alpha',json.documents[0].documentId)).content).markup,'<main>情報</main>');
      await assert.rejects(collectProjectUrls(f.store,'other',{url:origin+'/app',render:true,profileId:'test'},async()=>true),/接続設定/);
    }finally{if(previous===undefined)delete process.env.WENTIAN_KNOWLEDGE_SOURCES_FILE;else process.env.WENTIAN_KNOWLEDGE_SOURCES_FILE=previous;await f.close()}
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));if(old===undefined)delete process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE;else process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE=old}
});

test('収集ジョブAPIと接続一覧は認可済みのプロジェクトだけに操作を許可する',async()=>{
  const f=await fixture(),app=Fastify();
  try{
    registerProjectKnowledgeRoutes(app,(req,_reply,project)=>req.headers['x-user']==='owner'&&project==='alpha',{root:path.join(f.root,'knowledge'),collectionIdentity:()=> 'owner',authorizeJob:async()=>true,readPage:async url=>({url,body:'<p>ジョブの本文</p>'})});
    assert.equal((await app.inject({url:'/v1/project-knowledge/alpha/collection-jobs'})).statusCode,403);
    const payload={url:'https://fixture.invalid/page',followLinks:false,maxPages:1,mode:'sync',intervalMs:60000};
    const created=await app.inject({method:'POST',url:'/v1/project-knowledge/alpha/collection-jobs',headers:{'x-user':'owner'},payload});assert.equal(created.statusCode,201);
    const id=created.json().id;
    const list=await app.inject({url:'/v1/project-knowledge/alpha/collection-jobs',headers:{'x-user':'owner'}});assert.equal(list.json().jobs.length,1);assert.equal(list.json().jobs[0].pending,undefined);
    assert.equal((await app.inject({method:'POST',url:`/v1/project-knowledge/alpha/collection-jobs/${id}/pause`,headers:{'x-user':'owner'},payload:{}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:`/v1/project-knowledge/other/collection-jobs/${id}/resume`,headers:{'x-user':'owner'},payload:{}})).statusCode,403);
  }finally{await app.close();await f.close()}
});
