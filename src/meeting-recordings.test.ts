import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {MeetingHub} from './meetings/hub.js';
import {registerMeetingRecordings,validateMeetingMinutes} from './meetings/recordings.js';

const bytes=Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.from('隔離試験の録画')]);
const segments=[{start:0,end:5,text:'田中が金曜日までに仕様を確認します。'}];
const minutes={summary:[{text:'仕様の確認を依頼した。',evidence:[{segment:0,quote:'仕様を確認します。'}]}],decisions:[],actions:[{text:'仕様を確認',assignee:'田中',due:'金曜日',evidence:[{segment:0,quote:segments[0].text}]}],openQuestions:[]};
async function fixture(root?:string,clock=Date.now){
 root||=await mkdtemp(path.join(tmpdir(),'wentian-recordings-'));const app=Fastify(),inbox:any[][]=[[],[]],hub=new MeetingHub(6,()=>{},clock),a=hub.join('room','a','本人',v=>inbox[0].push(v)),b=hub.join('room','b','相手',v=>inbox[1].push(v));let revoked=false,badMinutes=false,transcriptions=0;
 const service=registerMeetingRecordings(app,{workspace:root,root,hub,identity:req=>req.headers['x-user']?{id:String(req.headers['x-user'])}:undefined,member:async(group,user)=>!revoked&&group==='room'&&['a','b'].includes(user),models:async()=>[{id:'fixture/model'}],transcribe:async directory=>{transcriptions++;assert.deepEqual(await readFile(path.join(directory,'capture.bin')),bytes);return segments;},summarize:async(_model,prompt)=>{assert.ok(prompt.includes(segments[0].text));return JSON.stringify(badMinutes?{...minutes,summary:[{text:'捏造',evidence:[{segment:0,quote:'存在しない発言'}]}]}:minutes);}});
 const request=(method:string,url:string,payload?:any,user='a')=>app.inject({method:method as any,url,headers:{...(user?{'x-user':user}:{}),...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})},...(payload===undefined?{}:{payload})});
 const consent=()=>{hub.message('room',a,{type:'request-recording',mode:'video',automatic:true,model:'fixture/model',language:'ja'});return inbox[0].filter((e:any)=>e.type==='recording-request').at(-1).id;};
 const create=async()=>{const session=consent();hub.message('room',b,{type:'approve-recording',id:session});const response=await request('POST','/api/meetings/recordings',{group:'room',peer:a,session,mime:'video/webm'});assert.equal(response.statusCode,200);return response.json();};
 return{root,app,hub,a,b,inbox,service,request,consent,create,revoke:()=>{revoked=true;},bad:()=>{badMinutes=true;},count:()=>transcriptions};
}
test('録画は全員承認後だけ開始し、途中参加・退出・撤回で停止する',()=>{
 const events:any[][]=[[],[],[]],hub=new MeetingHub(),a=hub.join('r','a','本人',v=>events[0].push(v)),b=hub.join('r','b','相手',v=>events[1].push(v));
 hub.message('r',a,{type:'request-recording',mode:'audio',model:'fixture',automatic:true,language:'auto'});const session=events[0].at(-1).id;
 assert.throws(()=>hub.recordingPermission('r',a,session,'a'));assert.throws(()=>hub.message('r',a,{type:'approve-recording',id:'別申請'}));
 hub.message('r',b,{type:'approve-recording',id:session});assert.equal(hub.recordingPermission('r',a,session,'a').approved.length,2);assert.throws(()=>hub.recordingPermission('r',b,session,'b'));
 const c=hub.join('r','c','途中参加',v=>events[2].push(v));assert.ok(events[0].some(e=>e.type==='recording-ended'));assert.throws(()=>hub.recordingPermission('r',a,session,'a'));hub.leave('r',c);
 hub.message('r',a,{type:'request-recording',mode:'video',model:'fixture',automatic:true,language:'ja'});const next=events[0].at(-1).id;hub.message('r',b,{type:'stop-recording',id:next});assert.throws(()=>hub.recordingPermission('r',a,next,'a'));
});
test('保存は認証・会議参加・所有者・同意を確認し、断片の再送を重複保存しない',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request('GET','/api/meetings/recordings?group=room',undefined,'')).statusCode,401);
  assert.equal((await f.request('GET','/api/meetings/recordings?group=room',undefined,'outside')).statusCode,403);
  const pending=f.consent();assert.equal((await f.request('POST','/api/meetings/recordings',{group:'room',peer:f.a,session:pending,mime:'video/webm'})).statusCode,400);
  f.hub.message('room',f.b,{type:'approve-recording',id:pending});const created=(await f.request('POST','/api/meetings/recordings',{group:'room',peer:f.a,session:pending,mime:'video/webm'})).json();
  assert.equal((await f.request('PUT',`/api/meetings/recordings/${created.id}/chunks/0`,bytes,'b')).statusCode,403);
  assert.equal((await f.request('PUT',`/api/meetings/recordings/${created.id}/chunks/1`,bytes)).statusCode,400);
  assert.equal((await f.request('PUT',`/api/meetings/recordings/${created.id}/chunks/0`,bytes)).statusCode,200);
  assert.equal((await f.request('PUT',`/api/meetings/recordings/${created.id}/chunks/0`,bytes)).statusCode,200);
  assert.equal((await f.request('PUT',`/api/meetings/recordings/${created.id}/chunks/0`,Buffer.concat([bytes,Buffer.from('別内容')]))).statusCode,400);
  await f.request('POST',`/api/meetings/recordings/${created.id}/finish`,{});await f.service.idle();
  const row=(await f.request('GET','/api/meetings/recordings/'+created.id)).json();assert.equal(row.bytes,bytes.length);assert.equal(row.status,'ready');assert.equal(f.count(),1);assert.equal(row.minutes.actions[0].assignee,'田中');
  assert.deepEqual((await f.request('GET',`/api/meetings/recordings/${created.id}/media`,undefined,'b')).rawPayload,bytes);
  assert.match((await f.request('GET',`/api/meetings/recordings/${created.id}/transcript`)).body,/田中/);
  f.revoke();assert.equal((await f.request('GET',`/api/meetings/recordings/${created.id}/media`)).statusCode,403);
 }finally{await f.app.close();}
});
test('引用が不正な議事録は未完了とし、録画と文字起こしを保全する',async()=>{
 const f=await fixture();try{f.bad();const row=await f.create();await f.request('PUT',`/api/meetings/recordings/${row.id}/chunks/0`,bytes);await f.request('POST',`/api/meetings/recordings/${row.id}/finish`,{partial:true});await f.service.idle();const result=(await f.request('GET','/api/meetings/recordings/'+row.id)).json();assert.equal(result.status,'failed');assert.equal(result.partial,true);assert.deepEqual(result.segments,segments);assert.equal(result.minutes,undefined);assert.equal((await f.request('GET',`/api/meetings/recordings/${row.id}/media`)).statusCode,200);}finally{await f.app.close();}
});
test('議事録は存在しない引用を拒否し、根拠のない担当と期限を未確認にする',()=>{
 const result=validateMeetingMinutes(JSON.stringify({...minutes,actions:[{...minutes.actions[0],assignee:'佐藤',due:'明日'}]}),segments);assert.equal(result.actions[0].assignee,null);assert.equal(result.actions[0].due,null);
 assert.throws(()=>validateMeetingMinutes(JSON.stringify({...minutes,summary:[{text:'根拠なし',evidence:[]}]}),segments));assert.throws(()=>validateMeetingMinutes(JSON.stringify({...minutes,summary:[{text:'不正区間',evidence:[{segment:8,quote:'田中'}]}]}),segments));
});
test('再起動時は未完了の処理を再開し、登録外モデル・形式・別サイト操作を拒否する',async()=>{
 const f=await fixture();const row=await f.create();try{
  assert.equal((await f.request('PUT',`/api/meetings/recordings/${row.id}/chunks/0`,Buffer.from('不正形式'))).statusCode,400);
  assert.equal((await f.app.inject({method:'POST',url:`/api/meetings/recordings/${row.id}/finish`,headers:{'x-user':'a',origin:'https://other.test'},payload:{}})).statusCode,403);
  await f.request('PUT',`/api/meetings/recordings/${row.id}/chunks/0`,bytes);await f.request('POST',`/api/meetings/recordings/${row.id}/finish`,{});await f.service.idle();
 }finally{await f.app.close();}
 const meta=path.join(f.root,row.id,'recording.json'),saved=JSON.parse(await readFile(meta,'utf8'));saved.status='transcribing';await writeFile(meta,JSON.stringify(saved));const next=await fixture(f.root);try{await next.service.ready;await next.service.idle();assert.equal((await next.request('GET','/api/meetings/recordings/'+row.id)).json().status,'ready');}finally{await next.app.close();}
});


test('承認撤回後の新規断片は終了猶予後に拒否し、保存済みの部分を確定できる',async()=>{
 let now=0;const f=await fixture(undefined,()=>now);try{const row=await f.create();await f.request('PUT',`/api/meetings/recordings/${row.id}/chunks/0`,bytes);f.hub.message('room',f.b,{type:'stop-recording',id:row.session});now=31000;assert.equal((await f.request('PUT',`/api/meetings/recordings/${row.id}/chunks/1`,Buffer.from('追加断片'))).statusCode,403);assert.equal((await f.request('POST',`/api/meetings/recordings/${row.id}/finish`,{model:'別モデル'})).statusCode,400);assert.equal((await f.request('POST',`/api/meetings/recordings/${row.id}/finish`,{partial:true})).statusCode,200);await f.service.idle();assert.equal((await f.request('GET','/api/meetings/recordings/'+row.id)).json().partial,true);}finally{await f.app.close();}
});
test('容量上限を超えた断片は書き込まず、原録画の全体容量も制限する',async()=>{
 const previous=process.env.WENTIAN_MEETING_RECORDING_QUOTA_BYTES;process.env.WENTIAN_MEETING_RECORDING_QUOTA_BYTES=String(bytes.length);const f=await fixture();try{const row=await f.create();assert.equal((await f.request('PUT',`/api/meetings/recordings/${row.id}/chunks/0`,bytes)).statusCode,200);assert.equal((await f.request('PUT',`/api/meetings/recordings/${row.id}/chunks/1`,Buffer.from('上限超過'))).statusCode,400);assert.deepEqual(await readFile(path.join(f.root,row.id,'capture.bin')),bytes);f.hub.message('room',f.a,{type:'stop-recording',id:row.session});const session=f.consent();f.hub.message('room',f.b,{type:'approve-recording',id:session});assert.equal((await f.request('POST','/api/meetings/recordings',{group:'room',peer:f.a,session,mime:'video/webm'})).statusCode,400);}finally{await f.app.close();if(previous===undefined)delete process.env.WENTIAN_MEETING_RECORDING_QUOTA_BYTES;else process.env.WENTIAN_MEETING_RECORDING_QUOTA_BYTES=previous;}
});
