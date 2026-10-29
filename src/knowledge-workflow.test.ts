import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import ExcelJS from 'exceljs';
import { unzipSync, strFromU8 } from 'fflate';
import { XMLValidator } from 'fast-xml-parser';
import { ProjectKnowledgeStore } from './project-knowledge.js';
import { createKnowledgeArtifact, KnowledgeArtifacts, type KnowledgeCompletion } from './knowledge-workflow.js';
import { registerProjectKnowledgeRoutes } from './project-knowledge-routes.js';
import { exportKnowledgeOffice } from './knowledge-office.js';
import { KnowledgeCollectionJobs } from './knowledge-collection-jobs.js';
import { KnowledgeSourceError } from './knowledge-resource.js';
import { transcribeDiarizedMeeting, validateSegments } from './meetings/recordings.js';
import { writeFile } from 'node:fs/promises';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-workflow-'));
  const store=new ProjectKnowledgeStore({root});
  const source=await store.register('alpha',{title:'休暇規程',url:'https://example.invalid/policy',content:'年次休暇は20日です。\n年假为20天。'});
  return{root,store,source,close:()=>rm(root,{recursive:true,force:true})};
}
/** 意味判断は模擬AIが返し、製品側は構造・出典・版を検証します。 */
function completion(verdict='supported',claim='年次休暇は20日です。'):KnowledgeCompletion{
  return async messages=>{
    const input=JSON.parse(messages.at(-1)!.content.startsWith('{')?messages.at(-1)!.content:'{}');
    if(input.claims)return JSON.stringify({reviews:input.claims.map((c:any)=>({id:c.id,verdict,reason:verdict==='supported'?'資料の条件と日数に一致。':'引用は20日だが主張は30日で矛盾。'}))});
    if(input.evidence)return JSON.stringify({title:'日本語・中国語の確認',claims:[{id:'c1',kind:'fact',text:claim,citations:[{chunkId:input.evidence[0].chunkId,quote:'年次休暇は20日です。'}]}],unresolved:[]});
    return JSON.stringify({queries:['休暇']});
  };
}
const input={question:'付与日数は？',model:'fixture/model',mode:'answer' as const};

test('回答と検証には検索抜粋で落ちた同一チャンク内の日程も渡す',async()=>{
  const f=await fixture();try{
    const content='研修日程は11月12日から14日です。\n参加者は4人です。\n\n# 国内出張\n\n宿泊費上限は12,000円です。\n交通費は実費です。\n日当は2,000円です。\n上限超過時は予約前の承認が必要です。';
    const source=await f.store.register('alpha',{title:'研修出張規程',url:'https://example.invalid/training',content});
    const hits=await f.store.search('alpha','宿泊費');
    const selected=hits.find(hit=>hit.documentId===source.documentId)!;
    assert.ok(selected);assert.ok(!selected.excerpt.includes('11月12日'),'検索表示の短い抜粋では日程が省かれる条件を再現する。');
    let reviewed=false;
    const complete:KnowledgeCompletion=async messages=>{
      const value=messages.at(-1)!.content;const data=value.startsWith('{')?JSON.parse(value):{};
      if(data.evidence){const hit=data.evidence.find((hit:any)=>hit.documentId===source.documentId);assert.equal(hit.excerpt,content);assert.ok(hit.excerpt.includes('参加者は4人'));}
      if(data.claims){reviewed=true;return JSON.stringify({reviews:[{id:'c1',verdict:'supported',reason:'同じ根拠チャンクの日程に一致。'}]})}
      if(data.evidence)return JSON.stringify({title:'研修日程',claims:[{id:'c1',kind:'fact',text:'研修日程は11月12日から14日です。',citations:[{chunkId:data.evidence[0].chunkId,quote:'研修日程は11月12日から14日です。'}]}],unresolved:[]});
      return JSON.stringify({queries:['宿泊費']});
    };
    const artifact=await createKnowledgeArtifact(f.store,'alpha',{...input,question:'宿泊費と研修日程は？'},complete,AbortSignal.timeout(10000));
    assert.equal(artifact.status,'ai_reviewed');assert.equal(reviewed,true);
  }finally{await f.close()}
});

test('引用一致でも意味の矛盾は未確認とし、暫定保存を明示しない限り拒否する',async()=>{
  const f=await fixture();try{
    const artifact=await createKnowledgeArtifact(f.store,'alpha',input,completion('contradicted','年次休暇は30日です。'),AbortSignal.timeout(10000));
    assert.equal(artifact.status,'unconfirmed');assert.match(artifact.body,/\n## c1/);
    const saved=new KnowledgeArtifacts(f.store);await saved.save(artifact);
    await assert.rejects(saved.publish('alpha',artifact.id,'https://example.invalid/result',false),/未確認/);
    const docs=await saved.publish('alpha',artifact.id,'https://example.invalid/result',true);
    assert.match(docs[0].content,/未確認・暫定成果/);
  }finally{await f.close()}
});

test('検索ヒットの隣接チャンクを補い、表の見出しだけをモデルへ渡さない',async()=>{
 const f=await fixture();try{
  const content=['境界検索語：宿泊費は12,000円です。',...Array(18).fill('説明行'), '## 計算の確認値','4人・2泊の宿泊費は96,000円です。'].join('\n');
  const source=await f.store.register('alpha',{title:'出張費用',url:'https://example.invalid/table',content});
  const hits=await f.store.search('alpha','境界検索語');assert.equal(hits.length,1);assert.ok(!hits[0].excerpt.includes('96,000円'));
  const complete:KnowledgeCompletion=async messages=>{
   const value=messages.at(-1)!.content,data=value.startsWith('{')?JSON.parse(value):{};
   if(data.evidence){assert.ok(data.evidence.length<=32);const chunks=data.evidence.filter((hit:any)=>hit.documentId===source.documentId);assert.equal(chunks.length,2);assert.ok(chunks.some((hit:any)=>hit.excerpt.includes('96,000円')))}
   if(data.claims)return JSON.stringify({reviews:[{id:'c1',verdict:'supported',reason:'隣接する表の数値と一致。'}]});
   if(data.evidence){const hit=data.evidence.find((hit:any)=>hit.excerpt.includes('96,000円'));return JSON.stringify({title:'上限',claims:[{id:'c1',kind:'fact',text:'4人・2泊の宿泊費は96,000円です。',citations:[{chunkId:hit.chunkId,quote:'4人・2泊の宿泊費は96,000円です。'}]}],unresolved:[]})}
   return JSON.stringify({queries:['境界検索語']});
  };
  assert.equal((await createKnowledgeArtifact(f.store,'alpha',input,complete,AbortSignal.timeout(10000))).status,'ai_reviewed');
 }finally{await f.close()}
});

test('未確認事項の影響はAIの構造化判断で区別し、留意事項を消さずに再保存する',async()=>{
 const f=await fixture();try{
  const make=(impact?:string,kind='fact'):KnowledgeCompletion=>async(messages,signal)=>{
   const result=JSON.parse(await completion()(messages,signal));
   if(result.claims){result.claims[0].kind=kind;result.unresolved=['実施前に担当者を確認する。']}
   if(result.reviews&&impact)result.unresolvedReviews=[{index:0,impact,reason:'依頼は日数の説明であり、担当者の確定は日数の根拠を変更しない。'}];
   return JSON.stringify(result);
  };
  const artifact=await createKnowledgeArtifact(f.store,'alpha',input,make('informational'),AbortSignal.timeout(10000));
  assert.equal(artifact.status,'ai_reviewed');assert.deepEqual(artifact.unresolved,['実施前に担当者を確認する。']);assert.match(artifact.body,/留意事項（未解決）/);
  const saved=new KnowledgeArtifacts(f.store);await saved.save(artifact);
  const docs=await saved.publish('alpha',artifact.id,'https://example.invalid/informational',false);assert.match(docs[0].content,/担当者を確認/);
  let clarified=false;
  const clarify:KnowledgeCompletion=async(messages,signal)=>{
   const text=messages.at(-1)!.content,data=text.startsWith('{')?JSON.parse(text):{};
   if(data.reviewFeedback){assert.equal(data.reviewFeedback.unresolvedReviews[0].impact,'blocking');clarified=true}
   return make(clarified?'informational':'blocking')(messages,signal);
  };
  const revised=await createKnowledgeArtifact(f.store,'alpha',input,clarify,AbortSignal.timeout(10000));
  assert.equal(revised.status,'ai_reviewed');assert.equal(revised.unresolved.length,1);assert.equal(revised.revisionHistory![0].unresolvedReviews[0].impact,'blocking');
  for(const judge of [make('blocking'),make(),make('informational','unknown')]){
   const blocked=await createKnowledgeArtifact(f.store,'alpha',input,judge,AbortSignal.timeout(10000));assert.equal(blocked.status,'unconfirmed');await saved.save(blocked);
   await assert.rejects(saved.publish('alpha',blocked.id,'https://example.invalid/blocked',false),/未確認/);
  }
  const invalid:KnowledgeCompletion=async(messages,signal)=>{const result=JSON.parse(await make('informational')(messages,signal));if(result.reviews)result.unresolvedReviews.push(result.unresolvedReviews[0]);return JSON.stringify(result)};
  await assert.rejects(createKnowledgeArtifact(f.store,'alpha',input,invalid,AbortSignal.timeout(10000)),/検証数/);
  const wrongIndex:KnowledgeCompletion=async(messages,signal)=>{const result=JSON.parse(await make('informational')(messages,signal));if(result.reviews)result.unresolvedReviews[0].index=1;return JSON.stringify(result)};
  await assert.rejects(createKnowledgeArtifact(f.store,'alpha',input,wrongIndex,AbortSignal.timeout(10000)),/検証形式/);
  const nullReviews:KnowledgeCompletion=async(messages,signal)=>{const result=JSON.parse(await make('informational')(messages,signal));if(result.reviews)result.unresolvedReviews=null;return JSON.stringify(result)};
  await assert.rejects(createKnowledgeArtifact(f.store,'alpha',input,nullReviews,AbortSignal.timeout(10000)),/検証数/);
 }finally{await f.close()}
});

test('根拠資料の更新後は旧成果を再保存せず、最新資料で再回答する',async()=>{
  const f=await fixture();try{
    const artifact=await createKnowledgeArtifact(f.store,'alpha',input,completion(),AbortSignal.timeout(10000));
    const saved=new KnowledgeArtifacts(f.store);await saved.save(artifact);
    const published=await saved.publish('alpha',artifact.id,'https://example.invalid/saved-result',false);
    await f.store.update('alpha',f.source.documentId,{content:'年次休暇は25日です。'});
    assert.equal(await f.store.evidenceCurrent('alpha',published[0].documentId),false);
    assert.ok(!(await f.store.search('alpha','日本語')).some(hit=>hit.documentId===published[0].documentId),'再保存した旧成果も検索へ混ぜない');
    await assert.rejects(saved.publish('alpha',artifact.id,'https://example.invalid/result',false),/更新/);
    await assert.rejects(createKnowledgeArtifact(f.store,'alpha',input,completion(),AbortSignal.timeout(10000)),/引用/);
  }finally{await f.close()}
});

test('検証で指摘した矛盾をAIへ返して一度だけ修正し、再検証と拒否履歴を残す',async()=>{
 const f=await fixture();try{
  let calls=0,drafts=0;
  const complete:KnowledgeCompletion=async(messages,signal)=>{
   calls++;const text=messages.at(-1)!.content,data=text.startsWith('{')?JSON.parse(text):{};
   if(data.evidence&&!data.claims){drafts++;if(drafts===2){assert.equal(data.reviewFeedback.reviews[0].verdict,'contradicted');assert.equal(data.reviewFeedback.claims[0].text,'年次休暇は30日です。')}}
   return completion(drafts===1?'contradicted':'supported',drafts===1?'年次休暇は30日です。':'年次休暇は20日です。')(messages,signal);
  };
  const artifact=await createKnowledgeArtifact(f.store,'alpha',input,complete,AbortSignal.timeout(10000));
  assert.equal(calls,5);assert.equal(artifact.status,'ai_reviewed');assert.equal(artifact.revisionHistory!.length,1);assert.equal(artifact.revisionHistory![0].reviews[0].verdict,'contradicted');
  assert.equal(artifact.claims[0].text,'年次休暇は20日です。');
  const saved=new KnowledgeArtifacts(f.store);await saved.save(artifact);assert.ok((await saved.publish('alpha',artifact.id,'https://example.invalid/repaired',false)).length);
  const unchanged=await createKnowledgeArtifact(f.store,'alpha',input,completion('contradicted'),AbortSignal.timeout(10000));assert.equal(unchanged.status,'unconfirmed');assert.equal(unchanged.revisionHistory!.length,1);
 }finally{await f.close()}
});

test('資料に明示された未定状態は検証できるが、不明な値や分類欠落を確定しない',async()=>{
 const f=await fixture();try{
  await f.store.update('alpha',f.source.documentId,{content:'年次休暇は20日です。\n担当者は未定です。'});
  const make=(assessment?:string,cited=true):KnowledgeCompletion=>async(messages,signal)=>{
   const result=JSON.parse(await completion()(messages,signal));
   if(result.claims)result.claims=[{id:'c1',kind:'unknown',text:'担当者は未定です。',citations:cited?[{chunkId:result.claims[0].citations[0].chunkId,quote:'担当者は未定です。'}]:[]}];
   if(result.reviews&&assessment)result.reviews[0].unknownAssessment=assessment;
   return JSON.stringify(result);
  };
  const confirmed=await createKnowledgeArtifact(f.store,'alpha',input,make('documented_absence'),AbortSignal.timeout(10000));
  assert.equal(confirmed.status,'ai_reviewed');assert.equal(confirmed.claims[0].kind,'unknown');assert.match(confirmed.body,/担当者は未定/);
  for(const complete of [make(),make('unresolved_value'),make('documented_absence',false)])assert.equal((await createKnowledgeArtifact(f.store,'alpha',input,complete,AbortSignal.timeout(10000))).status,'unconfirmed');
  await assert.rejects(createKnowledgeArtifact(f.store,'alpha',input,make('invalid'),AbortSignal.timeout(10000)),/検証結果の形式/);
 }finally{await f.close()}
});

test('認証切れの定期同期は通知して停止し、認証更新後に未取得URLから再開する',async()=>{
 const f=await fixture();let expired=true;
 const jobs=await KnowledgeCollectionJobs.open(path.join(f.root,'jobs'),f.store,async()=>true,async url=>{if(expired)throw new KnowledgeSourceError('ログイン状態の更新が必要です。','auth_required');return{url,body:'同期後の本文',contentType:'text/plain'}});
 try{
  const job=jobs.create('alpha','owner',{url:'https://example.invalid/private',mode:'sync',intervalMs:60000,followLinks:false,maxPages:1});
  await jobs.tick();let state=jobs.list('alpha')[0];assert.equal(state.status,'paused');assert.match(state.lastError!,/認証が失効/);assert.equal(state.pendingCount,1);
  expired=false;jobs.action('alpha',job.id,'resume');await jobs.tick();state=jobs.list('alpha')[0];assert.equal(state.documents,1);assert.equal(state.lastError,undefined);assert.equal(state.status,'queued');
 }finally{await jobs.close();await f.close()}
});

test('話者分離は対応モデルのラベルを保存し、推測や欠落したラベルを成功にしない',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-diarization-'));
 const names=['WENTIAN_MEETING_DIARIZATION_BASE_URL','WENTIAN_MEETING_DIARIZATION_MODEL'] as const,previous=names.map(name=>process.env[name]);
 try{
  process.env[names[0]]='https://example.invalid/v1';process.env[names[1]]='fixture-diarizer';
  await writeFile(path.join(root,'capture.bin'),'隔離音声');await writeFile(path.join(root,'recording.json'),JSON.stringify({mime:'audio/webm'}));
  const segments=[{start:0,end:3,text:'確認します。',speaker:'A'},{start:2,end:4,text:'お願いします。',speaker:'B'}];
  const result=await transcribeDiarizedMeeting(root,'ja',AbortSignal.timeout(1000),async(url,options)=>{assert.equal(String(url),'https://example.invalid/v1/audio/transcriptions');assert.equal((options!.body as FormData).get('response_format'),'diarized_json');return new Response(JSON.stringify({segments}))});
  assert.deepEqual(result,segments);assert.deepEqual(validateSegments([{start:0,end:1,text:'未確認'}]),[{start:0,end:1,text:'未確認'}]);
  await assert.rejects(transcribeDiarizedMeeting(root,'ja',AbortSignal.timeout(1000),async()=>new Response(JSON.stringify({segments:[{start:0,end:1,text:'話者なし'}]}))),/話者ラベル/);
 }finally{names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index]});await rm(root,{recursive:true,force:true})}
});

test('未取得の引用・重複したAI検証IDを成功にしない',async()=>{
  const f=await fixture();try{
    const invalid:KnowledgeCompletion=async(messages,signal)=>{
      const result=JSON.parse(await completion()(messages,signal));
      if(result.claims)result.claims[0].citations[0].quote='資料に存在しない本文';
      return JSON.stringify(result);
    };
    await assert.rejects(createKnowledgeArtifact(f.store,'alpha',input,invalid,AbortSignal.timeout(10000)),/引用/);
    const malformed:KnowledgeCompletion=async(messages,signal)=>{const result=JSON.parse(await completion()(messages,signal));if(result.claims)result.claims[0].citations=[null];return JSON.stringify(result)};
    await assert.rejects(createKnowledgeArtifact(f.store,'alpha',input,malformed,AbortSignal.timeout(10000)),/引用の構造/);
    const duplicate:KnowledgeCompletion=async(messages,signal)=>{const result=JSON.parse(await completion()(messages,signal));if(result.reviews)result.reviews.push(result.reviews[0]);return JSON.stringify(result)};
    await assert.rejects(createKnowledgeArtifact(f.store,'alpha',input,duplicate,AbortSignal.timeout(10000)),/主張数/);
  }finally{await f.close()}
});

test('改行を誤った引用は差し戻し、AIが原資料どおりに直した後で意味を検証する',async()=>{
 const f=await fixture();try{
  let calls=0;
  const complete:KnowledgeCompletion=async(messages,signal)=>{
   calls++;const text=messages.at(-1)!.content,data=text.startsWith('{')?JSON.parse(text):{};
   const result=JSON.parse(await completion()(messages,signal));
   if(result.claims&&!data.reviewFeedback)result.claims[0].citations[0].quote='年次休暇は20日です。\\n年假为20天。';
   if(data.reviewFeedback)assert.match(data.reviewFeedback.reviews[0].reason,/完全一致/);
   return JSON.stringify(result);
  };
  const artifact=await createKnowledgeArtifact(f.store,'alpha',input,complete,AbortSignal.timeout(10000));
  assert.equal(calls,4);assert.equal(artifact.status,'ai_reviewed');assert.equal(artifact.revisionHistory!.length,1);assert.equal(artifact.claims[0].citations[0].quote,'年次休暇は20日です。');
  let combinedCalls=0,drafts=0;
  const combined:KnowledgeCompletion=async(messages,signal)=>{
   combinedCalls++;const text=messages.at(-1)!.content,data=text.startsWith('{')?JSON.parse(text):{};
   if(data.evidence&&!data.claims)drafts++;
   const result=JSON.parse(await completion(drafts===2?'contradicted':'supported',drafts===2?'年次休暇は30日です。':'年次休暇は20日です。')(messages,signal));
   if(result.claims&&drafts===1)result.claims[0].citations[0].quote='年次休暇は20日です。\\n年假为20天。';
   return JSON.stringify(result);
  };
  const repaired=await createKnowledgeArtifact(f.store,'alpha',input,combined,AbortSignal.timeout(10000));
  assert.equal(combinedCalls,6);assert.equal(repaired.status,'ai_reviewed');assert.equal(repaired.revisionHistory!.length,2);assert.equal(repaired.revisionHistory![1].reviews[0].verdict,'contradicted');
 }finally{await f.close()}
});

test('一般メンバーは回答・出力でき、編集・一括投入・復元は編集者だけに許可する',async()=>{
  const f=await fixture(),app=Fastify();try{
    registerProjectKnowledgeRoutes(app,(req,_reply,project,write)=>project==='alpha'&&(!write||req.headers['x-editor']==='yes'),{store:f.store,workspace:{complete:()=>completion()}});
    const created=await app.inject({method:'POST',url:'/v1/project-knowledge/alpha/assistant',payload:input});assert.equal(created.statusCode,200,created.body);
    const id=created.json().id;
    for(const suffix of [`artifacts/${id}/publish`,'notes','import-files','restore','index/prepare']){
      assert.equal((await app.inject({method:'POST',url:'/v1/project-knowledge/alpha/'+suffix,payload:{}})).statusCode,403,suffix);
    }
    assert.equal((await app.inject({url:'/v1/project-knowledge/alpha/backup'})).statusCode,403);
    assert.equal((await app.inject({url:`/v1/project-knowledge/alpha/artifacts/${id}/export/docx`})).statusCode,200);
    assert.equal((await app.inject({url:`/v1/project-knowledge/beta/artifacts/${id}`})).statusCode,403);
    const published=await app.inject({method:'POST',url:`/v1/project-knowledge/alpha/artifacts/${id}/publish`,headers:{'x-editor':'yes'},payload:{body:'差替えた本文'}});
    assert.equal(published.statusCode,200,published.body);
    assert.match((await f.store.get('alpha',published.json().documents[0].documentId)).content,/年次休暇は20日/);
    assert.doesNotMatch((await f.store.get('alpha',published.json().documents[0].documentId)).content,/差替えた本文/);
  }finally{await app.close();await f.close()}
});

test('一括投入・ノート・本文バックアップ復元を隔離領域で往復し、改ざんと上書きを拒否する',async()=>{
  const f=await fixture(),app=Fastify();try{
    registerProjectKnowledgeRoutes(app,()=>true,{store:f.store});
    const imported=await app.inject({method:'POST',url:'/v1/project-knowledge/alpha/import-files',payload:{files:[{name:'資料.txt',contentType:'text/plain',base64:Buffer.from('資料本文').toString('base64')},{name:'不明.bin',contentType:'application/octet-stream',base64:'AA=='}]}});
    assert.equal(imported.statusCode,200,imported.body);assert.equal(imported.json().complete,false);assert.equal(imported.json().errors.length,1);assert.equal(imported.json().documents.length,1);
    const note=await app.inject({method:'POST',url:'/v1/project-knowledge/alpha/notes',payload:{title:'ノート',content:'編集可能な本文'}});assert.equal(note.statusCode,200,note.body);
    const backup=await f.store.backup('alpha');assert.equal((await f.store.restore('beta',backup)).restored,3);
    await assert.rejects(f.store.restore('beta',backup),/衝突/);
    backup.documents[0].content='変更';await assert.rejects(f.store.restore('gamma',backup),/ハッシュ/);
  }finally{await app.close();await f.close()}
});

test('Office成果は編集可能な本文・引用・数式・標準グラフを実ファイルに保持する',async()=>{
  const f=await fixture();try{
    const artifact=await createKnowledgeArtifact(f.store,'alpha',input,completion(),AbortSignal.timeout(10000));
    for(const format of ['docx','xlsx','pptx'] as const){
      const bytes=await exportKnowledgeOffice(artifact,format),files=unzipSync(bytes);
      for(const [name,data]of Object.entries(files))if(name.endsWith('.xml')||name.endsWith('.rels'))assert.equal(XMLValidator.validate(strFromU8(data)),true,name);
      const all=Object.values(files).map(data=>strFromU8(data)).join('\n');assert.match(all,/年次休暇は20日です/);assert.match(all,/example.invalid/);
      if(format==='docx'){assert.ok(files['word/document.xml']);assert.match(strFromU8(files['word/document.xml']),/<w:tbl>/)}
      if(format==='xlsx'){
        assert.ok(files['xl/charts/chart1.xml']);assert.match(all,/COUNTIF/);assert.match(all,/rIdKnowledgeChart/);
        const book=new ExcelJS.Workbook();await book.xlsx.load(bytes as any);
        assert.equal(book.getWorksheet('Claims')!.getCell('C2').value,'年次休暇は20日です。');
        assert.deepEqual(book.getWorksheet('Summary')!.getCell('B3').value,{formula:'COUNTIF(Claims!D2:D2,"supported")',result:1});
        // 横方向の分断を防ぐ印刷設定が、実際のXLSXへ保存されていることを確認します。
        for(const sheet of book.worksheets){assert.equal(sheet.pageSetup.orientation,'landscape');assert.equal(sheet.pageSetup.fitToWidth,1);assert.equal(sheet.pageSetup.fitToHeight,0);assert.ok(sheet.pageSetup.printArea)}
        assert.equal(book.getWorksheet('Summary')!.pageSetup.printArea,'A1:L20');
      }
      if(format==='pptx'){assert.ok(files['ppt/charts/chart1.xml']);assert.match(all,/<a:t>年次休暇/)}
    }
  }finally{await f.close()}
});

test('索引の進捗は現行版だけを数え、再起動後に既存ベクトルを再利用する',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-index-progress-'));let calls=0;
  const embedder={id:'fixture',embed:async(texts:string[])=>{calls+=texts.length;return texts.map(()=>[1,0])}};
  try{
    const store=new ProjectKnowledgeStore({root,embedder});const doc=await store.register('alpha',{title:'検証',url:'https://example.invalid/index',content:'本文'});
    assert.equal((await store.indexProgress('alpha')).indexed,0);
    assert.equal((await store.prepareIndex('alpha')).complete,true);assert.equal(calls,2);
    await new ProjectKnowledgeStore({root,embedder}).prepareIndex('alpha');assert.equal(calls,3);
    await store.update('alpha',doc.documentId,{title:'題名変更'});assert.equal((await store.indexProgress('alpha')).indexed,0);
    await store.prepareIndex('alpha');assert.equal(calls,5);
    await store.remove('alpha',doc.documentId);assert.equal((await store.indexProgress('alpha')).indexed,0);
  }finally{await rm(root,{recursive:true,force:true})}
});

test('索引生成の途中失敗後は保存済みバッチを再利用する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-index-resume-'));let batches=0,failed=false,generated=0;
 const embedder={id:'fixture',embed:async(texts:string[])=>{if(texts.length>1){batches++;if(batches===2&&!failed){failed=true;throw Error('模擬通信障害')}generated+=texts.length}return texts.map(()=>[1,0])}};
 try{
  const store=new ProjectKnowledgeStore({root,embedder});await store.register('alpha',{title:'索引再開',url:'https://example.invalid/resume',content:'資料\n'.repeat(1000)});
  await assert.rejects(store.prepareIndex('alpha'),/埋め込み/);assert.equal((await store.indexProgress('alpha')).indexed,32);
  const result=await store.prepareIndex('alpha');assert.equal(result.complete,true);assert.equal(generated,result.total,'途中保存した32件を再生成しない');
 }finally{await rm(root,{recursive:true,force:true})}
});

test('従来の1万チャンクを超える索引を分割生成・検索する（模擬埋め込み）',{timeout:120000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-index-scale-'));
 try{
  const store=new ProjectKnowledgeStore({root,embedder:{id:'fixture-scale',embed:async texts=>texts.map(()=>[1,0])}});
  for(let n=0;n<5;n++)await store.register('alpha',{title:'大規模索引'+n,url:'https://example.invalid/scale/'+n,content:'資\n'.repeat(49000)});
  const before=await store.indexProgress('alpha');assert.ok(before.total>10000);
  const hits=await store.search('alpha','索引',1,'vector');assert.equal(hits.length,1);
  const after=await store.indexProgress('alpha');assert.equal(after.indexed,before.total);assert.equal(after.complete,true);
 }finally{await rm(root,{recursive:true,force:true})}
});
