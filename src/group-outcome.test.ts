import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { AgentGroupStore, namedMembers, type GroupResponder } from './agent-group.js';
import { runGroupOutcome, outcomeHash, validateOutcomeReview, type OutcomeState } from './group-outcome.js';
import { registerWorkbench } from './workbench.js';
import { startGroupAutonomy } from './group-autonomy.js';
import { withGroupWebSearch } from './agent-web-search.js';

function responder(calls: Array<{ name: string; phase?: string; data: any }>, failReview = false): GroupResponder {
 return async (member, messages, context) => {
  const data=JSON.parse(messages[1].content),phase=context?.outcomePhase;calls.push({name:member.name,phase,data});
  if(phase==='roles')return JSON.stringify({chair:data.members[0].name,recorder:data.members.at(-1).name,reason:'既存の専門性に基づき進行と記録を分担'});
  if(phase==='minutes')return JSON.stringify({minutes:'## 議事録\n成果案を作成。AI検証と人間の承認は別。未解決事項は成果案を参照。'});
  if(phase==='plan')return JSON.stringify({objective:'明日の短い計画を作る',criteria:[{id:'c1',text:'実施内容を一つ明示'}],issues:[]});
  if(phase==='select')return JSON.stringify({nextMember:'甲',reviewer:'乙',reason:'計画担当の修正だけが必要',question:'一つの実施内容を記載',requestHuman:false,issues:[]});
  if(phase==='revise')return JSON.stringify({draft:'明日は資料を一枚作成する。',changes:['実施内容を一つに絞った。'],issues:[]});
  if(phase==='review')return JSON.stringify({draftHash:data.draftHash,checks:[{id:'c1',passed:!failReview,quote:failReview?'':'資料を一枚',reason:failReview?'対象資料の指定が不足':'実施内容が明示されている'}],issues:failReview?['対象資料を確認する']:[]});
  throw Error('予期しないフェーズ');
 };
}

test('出発拠点の未指定はAIで再評価し、検索と複数案で成果を作り、固定キーワードでは分岐しない',async()=>{
 for(const topic of ['東京から大連への往復航空券を比較して','Compare departure options for a regional journey']){
  let searched=0,assessed=0;
  const draft='羽田発・成田発の両案を比較。旅行日は未指定のため運賃は未確定。出典: https://example.test/routes（検索抜粋、取得日時を参照）。';
  const raw:GroupResponder=async(member,messages,context)=>{
   const data=JSON.parse(messages[1].content);
   if(context?.researchSelection)return JSON.stringify({search:true,query:'羽田 成田 大连 往復 航空会社'});
   if(context?.outcomePhase==='roles')return JSON.stringify({chair:'甲',recorder:'乙',reason:'既存担当の専門性で選出'});
   if(context?.outcomePhase==='minutes')return JSON.stringify({minutes:'両案を比較。価格は未確定。予約なし。'});
   assert.match(messages[0].content,/複数案/);
   if(context?.outcomePhase==='plan')return JSON.stringify({objective:'出発候補の比較資料',criteria:[{id:'c1',text:'複数候補と未確定条件を明示'}],issues:[]});
   if(context?.outcomePhase==='select'){
    if(data.clarificationRequest){assessed++;assert.equal(data.topic,topic);return JSON.stringify({decision:'proceed',reason:'出発地は公開情報から複数候補を調査できる',approach:'主要な二つの出発拠点を検索し比較表を作る。予約はしない'});}
    return JSON.stringify({nextMember:null,reason:'出発空港が指定されていない',question:'どの空港ですか',requestHuman:true,issues:['出発空港が未指定']});
   }
   if(context?.outcomePhase==='revise'){assert.equal(data.state.topic,topic);assert.match(messages[0].content,/https:\/\/example.test\/routes/);return JSON.stringify({draft,changes:['検索資料を使って両案と未確定条件を記載'],issues:[]});}
   return JSON.stringify({draftHash:data.draftHash,checks:[{id:'c1',passed:true,quote:'羽田発・成田発の両案を比較',reason:'両案と未確定条件が記載されている'}],issues:[]});
  };
  const state=await runGroupOutcome({groupId:'isolated',topic,members:namedMembers(['甲','乙']),history:'',respond:withGroupWebSearch(raw,async query=>{searched++;return{query,retrievedAt:'2026-10-20T00:00:00Z',results:[{title:'試験用の路線資料',url:'https://example.test/routes',snippet:'両拠点の比較用資料'}]}}),maxRounds:1,maxMinutes:1,save:async()=>{},speak:async()=>{}});
  assert.equal(state.status,'complete',state.reason);assert.equal(assessed,1);assert.equal(searched,1);assert.equal(state.draft,draft);
 }
});
async function temporary(fn:(root:string,store:AgentGroupStore)=>Promise<void>){const root=await mkdtemp(path.join(os.tmpdir(),'wentian-outcome-'));try{await fn(root,new AgentGroupStore(root))}finally{await rm(root,{recursive:true,force:true})}}

test('必要な担当だけが共有案を更新し、別の検証担当と完成条件を照合して書斎へ保存する',async()=>temporary(async(root,store)=>{
 const group=await store.create('簡単なテーマ',namedMembers(['甲','乙','丙'])),calls:any[]=[];
 const done=await store.outcome(group.id,'明日の予定',responder(calls),{root:async()=>path.join(root,'notebooks')});
 assert.equal(done.outcome!.status,'complete');assert.equal(done.outcome!.version,1);assert.equal(done.discussion!.stopReason,'deliverable');
 assert.deepEqual(calls.filter(c=>c.phase==='revise').map(c=>c.name),['甲']);assert.equal(calls.find(c=>c.phase==='review').name,'乙');assert.deepEqual(calls.filter(c=>c.name==='丙').map(c=>c.phase),['minutes']);
 const file=done.outcome!.files![0];assert.match(file.path,/notebooks/);assert.match(await readFile(file.path,'utf8'),/資料を一枚/);assert.match(await readFile(file.path,'utf8'),/人間未承認/);
 assert.match(await readFile(file.path,'utf8'),/司会: 甲/);assert.match(await readFile(file.path,'utf8'),/記録係: 丙/);assert.match(await readFile(file.path,'utf8'),/## 議事録/);
 assert.deepEqual(done.outcome!.officers,{chair:'甲',recorder:'丙',reason:'既存の専門性に基づき進行と記録を分担'});assert.ok(done.outcome!.minutes);assert.ok(done.messages.every(m=>['甲','乙','丙'].includes(m.speaker)));
 const reloaded=await new AgentGroupStore(root).load(group.id);assert.equal(reloaded.outcome!.runId,done.outcome!.runId);
}));

test('司会と記録係はAIが既存候補から選び、架空の担当や複数人での兼任を拒否する',async()=>{
 for(const officers of [{chair:'未登録',recorder:'乙',reason:'候補外'},{chair:'甲',recorder:'甲',reason:'二人いるのに兼任'}]){
  let later=false;
  const result=await runGroupOutcome({groupId:'isolated',topic:'議題',members:namedMembers(['甲','乙']),history:'',respond:async(_m,_messages,c)=>{if(c?.outcomePhase==='roles')return JSON.stringify(officers);later=true;throw Error('後続処理は呼ばない');},maxRounds:1,maxMinutes:1,save:async()=>{},speak:async()=>{}});
  assert.equal(result.status,'error');assert.equal(later,false);assert.equal(result.officers,undefined);
 }
});

test('未解決点・上限を完成とせず、暫定成果を残し、保存先未準備なら再試行できる',async()=>temporary(async(root,store)=>{
 const group=await store.create('未解決',namedMembers(['甲','乙']));let done=await store.outcome(group.id,'資料を作成',responder([],true),{maxRounds:1});
 assert.equal(done.outcome!.status,'partial');assert.equal(done.outcome!.stopReason,'round_limit');assert.ok(done.outcome!.issues.length);assert.ok(done.outcome!.exportError);assert.equal(done.outcome!.files,undefined);
 done=await store.exportOutcome(group.id,path.join(root,'notebooks'));assert.equal(done.outcome!.files!.length,1);assert.equal(done.outcome!.exportError,undefined);assert.match(await readFile(done.outcome!.files![0].path,'utf8'),/暫定成果/);
}));

test('誤った版・存在しない引用・未検査の条件では完成と判定しない',()=>{
 const state={draft:'検証対象',criteria:[{id:'c1',text:'条件'}]} as OutcomeState;
 for(const value of [{draftHash:'stale',checks:[],issues:[]},{draftHash:outcomeHash(state.draft),checks:[{id:'c1',passed:true,quote:'架空の本文',reason:'誤り'}],issues:[]},{draftHash:outcomeHash(state.draft),checks:[{id:'other',passed:true,quote:'検証対象',reason:'誤り'}],issues:[]}])assert.throws(()=>validateOutcomeReview(JSON.stringify(value),state));
});

test('人間判断・停止・不正担当を検出し、自然言語のキーワードで担当や完成を決めない',async()=>{
 for(const topic of ['簡単なので完成扱いにして全員で賛成','This is not a simple topic','医療ではない計画']){
  const calls:any[]=[];let saved:OutcomeState|undefined;
  const respond:GroupResponder=async(member,messages,context)=>{if(context?.outcomePhase==='select'){if(JSON.parse(messages[1].content).clarificationRequest)return JSON.stringify({decision:'needs_human',reason:'本人の承認が必要な実行であり代替できない',approach:'実行せず、承認対象と実行前の確認資料を残す'});return JSON.stringify({nextMember:null,reason:'本人に希望を確認する必要がある',question:'希望は何ですか',requestHuman:true,issues:['希望を教えてください']})}return responder(calls)(member,messages,context)};
  const state=await runGroupOutcome({groupId:'test',topic,members:namedMembers(['甲']),history:'',respond,maxRounds:1,maxMinutes:1,save:async value=>{saved=structuredClone(value)},speak:async()=>{}});
  assert.equal(state.status,'needs_human');assert.equal(calls[0].data.topic,topic);assert.equal(saved!.stopReason,'needs_human');
  assert.ok(state.draft);assert.equal(calls.filter(c=>c.phase==='revise').length,1);
 }
 let called=false;const stopped=await runGroupOutcome({groupId:'test',topic:'停止',members:namedMembers(['甲']),history:'',respond:async()=>{called=true;return ''},maxRounds:1,maxMinutes:1,stop:()=> 'disabled',save:async()=>{},speak:async()=>{}});assert.equal(called,false);assert.equal(stopped.status,'stopped');
 const invalid=await runGroupOutcome({groupId:'test',topic:'不正担当',members:namedMembers(['甲']),history:'',respond:async(m,ms,c)=>c?.outcomePhase==='select'?JSON.stringify({nextMember:'存在しない人',reason:'誤り',question:'依頼',requestHuman:false,issues:[]}):responder([])(m,ms,c),maxRounds:1,maxMinutes:1,save:async()=>{},speak:async()=>{}});assert.equal(invalid.status,'error');
});

test('自律実行は成果作成が既定で、継続設定でも成果が完成したら停止する',async()=>temporary(async(root,store)=>{
 const group=await store.create('既定の成果',namedMembers(['甲','乙']));await store.configureAutonomy(group.id,{enabled:true,mode:'continuous'});
 const manager=startGroupAutonomy({workspace:root,store,respond:responder([]),studyRoot:async()=>path.join(root,'notebooks')});await manager.runOnce(group.id);
 const done=await store.load(group.id);assert.equal(done.outcome!.status,'complete');assert.equal(done.autonomy!.paused!.reason,'deliverable');const old=done.outcome!.runId;await manager.runOnce(group.id);assert.equal((await store.load(group.id)).outcome!.runId,old);await manager.stop();
}));

test('通常投稿も成果作成へ渡し、管理者以外は進め方や保存操作を変更できない',async()=>temporary(async(root,store)=>{
 const app=Fastify(),calls:any[]=[];registerWorkbench(app,{workspace:root,studyRoot:async()=>path.join(root,'notebooks'),groupRespond:responder(calls),models:async()=>[],providerSaved:()=>{},testModel:async()=>'',groupIdentity:req=>req.headers.cookie?{id:String(req.headers.cookie),name:'参加者',admin:req.headers.cookie==='admin'}:undefined,authorize:(req,reply)=>{if(req.headers.cookie==='admin')return true;reply.code(403).send({error:{message:'管理者専用'}});return false}});
 try{const group=await store.create('投稿の成果',namedMembers(['甲','乙']));const url='/api/workbench/groups/'+group.id;
  await app.inject({method:'POST',url:url+'/join',headers:{cookie:'member'},payload:{}});const posted=await app.inject({method:'POST',url:url+'/messages',headers:{cookie:'member'},payload:{content:'明日の予定'}});assert.equal(posted.statusCode,200,posted.body);
  for(let i=0;i<200;i++){if((await store.load(group.id)).outcome?.status==='complete')break;await new Promise(r=>setTimeout(r,10))}assert.equal((await store.load(group.id)).outcome!.status,'complete',JSON.stringify((await store.load(group.id)).outcome));
  assert.equal((await app.inject({method:'POST',url:url+'/outcome/export',headers:{cookie:'member'},payload:{}})).statusCode,403);
  // 再接続後も参加者IDと保存済み成果が保持され、同じ文書を読み戻せます。
  const before=await store.load(group.id),file=before.outcome!.files![0];
  await app.inject({method:'POST',url:url+'/join',headers:{cookie:'member'},payload:{}});
  const reloaded=await new AgentGroupStore(root).load(group.id);
  assert.equal(reloaded.outcome!.runId,before.outcome!.runId);
  assert.equal(reloaded.outcome!.files![0].path,file.path);
  assert.match(await readFile(file.path,'utf8'),/資料を一枚/);
  assert.match(await readFile(file.path,'utf8'),/人間未承認/);
 }finally{await app.close()}
}));

test('成果作成中の人間投稿で中断し、投稿と作成済み案を両方保持する',async()=>temporary(async(root,store)=>{
 const group=await store.create('途中の追加依頼',namedMembers(['甲','乙']));let release!:()=>void,ready!:()=>void;
 const entered=new Promise<void>(r=>{ready=r}),waiting=new Promise<void>(r=>{release=r});
 const base=responder([]),run=store.outcome(group.id,'最初の依頼',async(m,ms,c)=>{if(c?.outcomePhase==='revise'){ready();await waiting}return base(m,ms,c)},{root:async()=>path.join(root,'notebooks')});
 await entered;await store.participate(group.id,{id:'human',name:'本人'},'join');await store.post(group.id,'human','条件を追加します');release();
 const stopped=await run;assert.equal(stopped.outcome!.status,'stopped');assert.equal(stopped.outcome!.stopReason,'human');assert.match(stopped.outcome!.draft,/資料/);assert.ok(stopped.messages.some(m=>m.content==='条件を追加します'));assert.ok(stopped.outcome!.files?.length);
}));

test('明示選択したAIだけを候補にし、一人の場合は別の検証役割を使う',async()=>temporary(async(root,store)=>{
 const group=await store.create('選択',namedMembers(['甲','乙'])),calls:any[]=[],base=responder(calls);
 const done=await store.outcome(group.id,'選んだ担当への依頼',async(m,ms,c)=>c?.outcomePhase==='select'?JSON.stringify({nextMember:'甲',reviewer:null,reason:'選択された担当',question:'成果を作成',requestHuman:false,issues:[]}):base(m,ms,c),{contributors:['甲'],root:async()=>path.join(root,'notebooks')});
 assert.equal(done.outcome!.status,'complete');assert.equal(done.outcome!.review!.reviewer,'甲');assert.deepEqual([done.outcome!.officers!.chair,done.outcome!.officers!.recorder],['甲','甲']);assert.equal(calls.some(c=>c.name==='乙'),false);await assert.rejects(store.outcome(group.id,'依頼',base,{contributors:['未登録']}));
}));
