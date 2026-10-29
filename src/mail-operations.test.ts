import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {MailOperationsService,registerMailOperations} from './mail-operations.js';
import {MailTrainingService} from './mail-training.js';
import { Window, HTMLButtonElement } from 'happy-dom';
import { mailSolutionsHtml } from './mail-solutions.js';
import { withMailOperations } from './mail-operations-ui.js';
import { createMailSourceDiagnoser, mailSourceDiagnosis } from './mail-source-diagnosis.js';

const raw=Buffer.from('From: test@example.invalid\r\nSubject: Candidate available\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nName: Test Candidate\r\nSkills: Python, SQL\r\nRate: 80\r\n');
const actor='検証担当';
test('停止メールを読取専用で特定し、本文・取得位置を変更せず件名と送信者を保存する',async()=>{
  let readOnly=false;let query:any;
  const client={on(){},async connect(){},mailbox:{uidValidity:10n},async getMailboxLock(_folder:string,options:any){readOnly=options.readOnly;return {release(){}};},async fetchOne(uid:number,fields:any){query=fields;return {uid,size:25*1024*1024,envelope:{subject:'大容量の資料',from:[{name:'担当者',address:'sender@example.invalid'}],date:new Date('2026-10-01T01:00:00Z'),messageId:'<large@example.invalid>'},internalDate:new Date('2026-10-01T01:01:00Z')};},async logout(){}};
  const f=await fixture({imap:()=>client});
  try{
    const source=f.service.saveSource({name:'停止IMAP',type:'imap',host:'localhost',user:'test',secretEnv:'WENTIAN_MAIL_TEST_PASSWORD',folders:['INBOX']},actor);
    const checkpoints={INBOX:{validity:'10',backfill:2417,target:602397,incremental:602397}};
    f.service.repository.put('source',{...source,status:'error',lastError:'UID 2418は20 MiBを超えます。同期を保留しました。',checkpoints});
    const mail=await f.service.locateBlockedMail(source.id,actor);
    assert.equal(readOnly,true);assert.equal(query.source,undefined);assert.equal(query.envelope,true);
    assert.equal(mail.subject,'大容量の資料');assert.equal(mail.from[0].address,'sender@example.invalid');assert.equal(mail.sizeBytes,25*1024*1024);
    assert.deepEqual(f.service.repository.require('source',source.id).checkpoints,checkpoints);
    client.mailbox.uidValidity=11n;await assert.rejects(f.service.locateBlockedMail(source.id,actor),/識別情報が変わりました/);
  }finally{await f.close();}
});
test('メールソース画面で停止原因と対応手順を表示しAI診断ボタンから結果を表示する',async()=>{
  const f=await fixture();
  const window=new Window({url:'http://localhost/sites/mail-solutions/'});
  try{
    const source=f.service.saveSource({name:'受信メール',type:'imap',host:'localhost',user:'test',secretEnv:'WENTIAN_MAIL_TEST_PASSWORD',folders:['INBOX']},actor);
    f.service.repository.put('source',{...source,status:'error',lastError:'UID 2418は20 MiBを超えます。同期を保留しました。',checkpoints:{INBOX:{backfill:2417,target:602397,incremental:602397}},blockedMessage:{uid:2418,folder:'INBOX',subject:'確認用の大容量メール',from:[{name:'担当者',address:'sender@example.invalid'}],sizeBytes:25*1024*1024,receivedAt:'2026-10-01T01:00:00Z',messageId:'<test@example.invalid>'}});
    const status=await f.service.status();let diagnoses=0;
    window.fetch=(async(url:unknown)=>{const address=String(url);let body:any={items:[],total:0};if(address==='/api/mail-operations')body=status;if(address.endsWith('/diagnose')){diagnoses++;body={status:'ready',content:'大容量メールによる停止です。上記手順を確認してください。',model:'test-ai',at:new Date().toISOString()};}return new window.Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});}) as typeof window.fetch;
    const html=withMailOperations(mailSolutionsHtml);
    window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g,''));
    for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))window.eval(match[1]);
    const settle=async()=>{for(let i=0;i<30;i++)await new Promise<void>(resolve=>setImmediate(resolve));};await settle();
    const host=window.document.getElementById('mailLiveSourceList')!;
    assert.match(host.textContent,/UID 2418/);assert.match(host.textContent,/総件数ではありません/);
    assert.match(host.textContent,/取得状況とAIによる対応方法/);
    assert.match(host.textContent,/確認用の大容量メール/);assert.match(host.textContent,/sender@example.invalid/);assert.match(host.textContent,/25.00 MiB/);
    assert.match(host.textContent,/Ctrl\+Cでコピー/);
    const button=[...host.querySelectorAll('button')].find(item=>item.textContent==='AIに原因・対応を相談') as HTMLButtonElement;
    assert.ok(button);button.click();await settle();assert.equal(diagnoses,1);assert.match(host.textContent,/AI診断案.*test-ai/);
  }finally{await window.happyDOM.close();await f.close();}
});
test('障害ごとの実データをAIへ渡し同じ状態の自動診断を再利用する',async()=>{
  const inputs:any[]=[];
  const f=await fixture({diagnose:async(facts:any)=>{inputs.push(facts);return {content:'原因分析: '+facts.error,model:'実験モデル'};}});
  try{
    f.service.repository.put('source',{...f.source,status:'error',lastError:'接続タイムアウト'});
    const first=await f.service.diagnoseSource(f.source.id,actor,undefined,false);
    const second=await f.service.diagnoseSource(f.source.id,actor,undefined,false);
    assert.equal(inputs.length,1);assert.equal(first.content,second.content);
    assert.equal(inputs[0].actions,undefined);assert.match(inputs[0].error,/タイムアウト/);
    f.service.repository.put('source',{...f.service.repository.require('source',f.source.id),lastError:'認証が拒否されました'});
    assert.equal(f.service.sources()[0].aiDiagnosis.stale,true);
    const changed=await f.service.diagnoseSource(f.source.id,actor,undefined,false);
    assert.equal(inputs.length,2);assert.match(changed.content,/認証/);assert.equal(f.service.sources()[0].aiDiagnosis.stale,false);
  }finally{await f.close();}
});
test('AI推論のHTTPエラーを隠さず表示できる情報として保持する',async()=>{
  const diagnose=createMailSourceDiagnoser(async()=>({statusCode:503,json:()=>({error:{code:'no_available_models',message:'利用可能な推論モデルがありません。'}})}));
  await assert.rejects(diagnose(mailSourceDiagnosis({status:'error',lastError:'接続失敗'},0)),/HTTP 503.*no_available_models.*利用可能/);
});
test('メール診断はGatewayの統合選択を使い代替経路を無効化しない',async()=>{
  let payload:any;
  const diagnose=createMailSourceDiagnoser(async input=>{payload=input;return {statusCode:200,json:()=>({model:'external/kilo',choices:[{message:{content:'Gatewayが選んだ推論先による診断'}}]})};});
  const result=await diagnose(mailSourceDiagnosis({status:'error',lastError:'認証失敗'},0));
  assert.equal(payload.model,process.env.WENTIAN_MAIL_DIAGNOSIS_MODEL||'wentian-auto/all');
  assert.equal(payload.wentian_execution_mode,'auto');assert.equal(result.model,'external/kilo');
  assert.match(payload.messages[1].content,/認証失敗/);assert.doesNotMatch(payload.messages[1].content,/同じ設定のまま/);
});
test('大容量メールの診断は取得位置と保存件数を区別し、AIへ秘密情報を渡さない',async()=>{
  let facts:any;
  const f=await fixture({diagnose:async(input:any)=>{facts=input;return {content:'大容量メールで停止しています。新着のみの取得は可能です。',model:'test-ai'};}});
  try {
    const source=f.service.saveSource({name:'診断IMAP',type:'imap',host:'private.example',user:'private-user',secretEnv:'WENTIAN_MAIL_TEST_PASSWORD',folders:['INBOX']},actor);
    f.service.repository.put('source',{...source,status:'error',lastError:'UID 2418は20 MiBを超えます。同期を保留しました。',checkpoints:{INBOX:{backfill:2417,target:602397,incremental:602397}}});
    const before=f.service.repository.require('source',source.id);
    const result=await f.service.diagnoseSource(source.id,actor);
    assert.equal(facts.code,'oversized_message');assert.equal(facts.blockedUid,2418);
    assert.equal(facts.imported,0);assert.equal(facts.folders[0].targetUid,602397);
    assert.match(facts.countMeaning,/総件数ではありません/);
    assert.doesNotMatch(JSON.stringify(facts),/private.example|private-user|WENTIAN_MAIL_TEST_PASSWORD/);
    assert.equal(result.model,'test-ai');assert.deepEqual(f.service.repository.require('source',source.id),before);
  }finally{await f.close();}
});
async function fixture(dependencies:any={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'mail-operations-'));
  const service=new MailOperationsService(directory,new MailTrainingService(path.join(directory,'training')),dependencies);
  const source=service.saveSource({name:'検証原本',type:'archive'},actor);
  return {service,source,async close(){await service.close();await rm(directory,{recursive:true,force:true});}};
}

test('原本の重複・検索・世代競合・確認必須・登録待ちの取消と再登録を検証する',async()=>{
  const f=await fixture();try{
    const {service,source}=f;
    let message=(await service.ingest(source.id,raw)).message;
    assert.equal((await service.ingest(source.id,raw)).duplicate,true);
    assert.equal(service.messages({q:'Python'}).total,1);
    assert.equal(service.messages({q:'%'}).total,0);
    assert.throws(()=>service.queue(message.id,{revision:message.revision},actor),/確認済み/);
    await assert.rejects(service.analyze(message.id,message.revision,actor),/分類モデルが未登録/);
    assert.equal(service.repository.require('message',message.id).status,'pending');
    const review={revision:message.revision,labelPath:['normal','normal.personnel','normal.personnel.business_app'],profileKind:'personnel',fields:{name:'検証人材',skills:'Python'}};
    message=service.review(message.id,review,actor);
    assert.throws(()=>service.review(message.id,review,actor),/別の操作/);
    let queued=service.queue(message.id,{revision:message.revision},actor);
    assert.equal(queued.job.status,'queued');
    const cancelled=service.cancel(queued.job.id,queued.job.revision,actor);
    assert.equal(cancelled.status,'cancelled');
    message=service.repository.require('message',message.id);assert.equal(message.status,'reviewed');
    queued=service.queue(message.id,{revision:message.revision},actor);
    assert.equal(queued.job.id,cancelled.id);assert.equal(queued.job.status,'queued');
    assert.ok((await service.download(message.id)).bytes.equals(raw));
    assert.ok(service.repository.events().some((event:any)=>event.action==='mail.reviewed'));
  }finally{await f.close();}
});

test('通信断は結果不明として保持し、照合なしの再送を禁止する',async()=>{
  let fail=true,calls=0;
  process.env.WENTIAN_MAIL_TEST_TOKEN='検証用秘密値';
  const f=await fixture({send:async()=>{calls++;if(fail)throw new Error('通信断');return {remoteId:'remote-1'};}});
  try{
    const {service,source}=f,settings=service.settings();
    settings.ses={...settings.ses,enabled:true,mode:'http-api',tokenEnv:'WENTIAN_MAIL_TEST_TOKEN',endpoints:{personnel:'http://127.0.0.1:1/talent',project:'http://127.0.0.1:1/project'}};
    service.saveSettings(settings,actor);
    let message=(await service.ingest(source.id,raw)).message;
    message=service.review(message.id,{revision:message.revision,labelPath:['normal','normal.personnel','normal.personnel.business_app'],profileKind:'personnel',fields:{name:'検証人材',skills:'Python'}},actor);
    let job=service.queue(message.id,{revision:message.revision},actor).job;
    job=await service.dispatch(job.id,job.revision,actor);assert.equal(job.status,'unknown');
    await assert.rejects(service.dispatch(job.id,job.revision,actor),/再送できません/);assert.equal(calls,1);
    job=service.resolve(job.id,{revision:job.revision,confirmation:job.id,outcome:'not_registered'},actor);
    fail=false;job=await service.dispatch(job.id,job.revision,actor);assert.equal(job.status,'registered');
    assert.equal(service.repository.require('message',message.id).remoteId,'remote-1');
    await assert.rejects(service.dispatch(job.id,job.revision,actor),/再送できません/);assert.equal(calls,2);
  }finally{delete process.env.WENTIAN_MAIL_TEST_TOKEN;await f.close();}
});

test('IMAPは読取専用で固定幅同期し、失敗箇所から再開する',async()=>{
  let broken=true,range='',readOnly=false,released=0;
  const client={on(){},async connect(){},mailbox:{uidValidity:10n,uidNext:4},async getMailboxLock(_folder:string,options:any){readOnly=options.readOnly;return {release(){released++;}};},async fetchAll(value:string){range=value;return [{uid:1,size:raw.length},{uid:2,size:raw.length}];},async fetchOne(uid:number){if(uid===2&&broken)throw new Error('原文取得失敗');return {uid,source:raw};},async logout(){},close(){}};
  const f=await fixture({imap:()=>client});try{
    const source=f.service.saveSource({name:'検証IMAP',type:'imap',host:'localhost',user:'test',secretEnv:'WENTIAN_MAIL_TEST_PASSWORD',folders:['INBOX'],batchSize:2},actor);
    await assert.rejects(f.service.syncSource(source.id,actor),/原文取得失敗/);
    assert.equal(range,'1:2');assert.equal(readOnly,true);assert.equal(released,1);
    assert.equal(f.service.repository.require('source',source.id).checkpoints.INBOX.backfill,1);
    broken=false;client.fetchAll=async(value:string)=>{range=value;return [{uid:2,size:raw.length},{uid:3,size:raw.length}];};
    const result=await f.service.syncSource(source.id,actor);
    assert.equal(range,'2:3');assert.equal(result.imported,2);assert.equal(f.service.messages().total,3);
  }finally{await f.close();}
});

test('業務APIは認証・同一オリジン・仮想キーの境界を守る',async()=>{
  const f=await fixture(),app=Fastify();
  registerMailOperations(app,(req,reply)=>{if(req.headers.authorization==='Bearer test')return true;reply.code(401).send({error:'認証必須'});return false;},f.service);
  try{
    assert.equal((await app.inject('/api/mail-operations')).statusCode,401);
    const headers={authorization:'Bearer test'};
    assert.equal((await app.inject({url:'/api/mail-operations',headers})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/mail-operations/sources',headers:{...headers,origin:'https://other.invalid'},payload:{name:'拒否',type:'archive'}})).statusCode,403);
    assert.equal((await app.inject({url:'/api/mail-operations',headers:{...headers,'x-team-virtual-key':'key'}})).statusCode,403);
  }finally{await app.close();await rm(f.service.directory,{recursive:true,force:true});}
});
