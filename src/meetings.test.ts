import test from 'node:test';
import assert from 'node:assert/strict';
import { MeetingHub } from './meetings/hub.js';
import { registerMeetings,meetingIceServers } from './meetings/routes.js';
import { AgentGroupStore,namedMembers } from './agent-group.js';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WentianPluginKernel } from './plugin-kernel.js';
import { meetingsPlugin,MEETINGS_SERVICE } from './meetings/plugin.js';

test('会議は独立プラグインとしてロードし、外すと能力を解放する',async()=>{const kernel=new WentianPluginKernel();kernel.register(meetingsPlugin);await kernel.load([{id:meetingsPlugin.id}]);assert.equal(kernel.resolve(MEETINGS_SERVICE).create(3,()=>{}).limit,3);await kernel.dispose();assert.equal(kernel.optional(MEETINGS_SERVICE),undefined);});

test('同じ会議だけへ本人名で接続情報を送り、偽装と別会議の宛先を拒否する',()=>{
 const inbox:any[][]=[[],[],[]],hub=new MeetingHub(2),a=hub.join('room','a','甲',v=>inbox[0].push(v)),b=hub.join('room','b','乙',v=>inbox[1].push(v)),c=hub.join('other','c','丙',v=>inbox[2].push(v));
 hub.message('room',a,{type:'signal',to:b,from:c,description:{type:'offer',sdp:'試験SDP'}});assert.equal(inbox[1].at(-1).from,a);assert.equal(inbox[2].length,1);
 assert.throws(()=>hub.message('room',a,{type:'signal',to:c,description:{type:'offer',sdp:'試験'}}));assert.throws(()=>hub.join('room','d','丁',()=>{}));
});

test('操作は本人の承認後だけ有効になり、第三者承認・期限切れ・切断を検査する',()=>{
 let now=0;const logs:any[]=[],events:any[][]=[[],[],[]],hub=new MeetingHub(4,e=>logs.push(e),()=>now),a=hub.join('r','a','甲',e=>events[0].push(e)),b=hub.join('r','b','乙',e=>events[1].push(e)),c=hub.join('r','c','丙',e=>events[2].push(e));
 hub.message('r',a,{type:'request-control',to:b});const id=events[1].at(-1).id;assert.equal(events[1].at(-1).type,'control-request');
 assert.throws(()=>hub.message('r',a,{type:'approve-control',id,scope:'画面1'}));assert.throws(()=>hub.message('r',c,{type:'approve-control',id,scope:'画面1'}));
 hub.message('r',b,{type:'approve-control',id,scope:'画面1'});assert.equal(events[0].at(-1).type,'control-granted');assert.equal(events[2].some(e=>e.type==='control-granted'),false);
 assert.throws(()=>hub.message('r',c,{type:'request-control',to:a}));hub.leave('r',a);assert.equal(events[1].at(-1).type,'left');assert.ok(events[1].some(e=>e.type==='control-ended'&&e.reason==='disconnected'));
 hub.message('r',b,{type:'request-control',to:c});const pending=events[2].at(-1).id;now=31000;hub.sweep();assert.throws(()=>hub.message('r',c,{type:'approve-control',id:pending,scope:'画面'}));
 hub.message('r',b,{type:'request-control',to:c});const current=events[2].at(-1).id;hub.message('r',c,{type:'approve-control',id:current,scope:'APP'});now+=300001;hub.sweep();assert.equal(events[2].at(-1).reason,'expired');assert.ok(logs.some(e=>e.action==='control-approved'));
});

test('会議設定は利用者指定のICEだけを受け付ける',()=>{assert.deepEqual(meetingIceServers(),[]);assert.equal(meetingIceServers('[{"urls":"turn:relay.test","username":"user","credential":"test"}]').length,1);assert.throws(()=>meetingIceServers('[{"urls":"http://unexpected.test"}]'));});

test('実WebSocket経路はログイン・群参加・Originを確認し、監査へ操作内容を残さない',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-meeting-')),app=Fastify(),store=new AgentGroupStore(root),group=await store.create('試験会議',namedMembers(['AI']));
 for(const id of ['a','b'])await store.participate(group.id,{id,name:id},'join');let authenticated=true;
 registerMeetings(app,{workspace:root,identity:req=>authenticated&&['a','b','outsider'].includes(String(req.headers['x-user']))?{id:String(req.headers['x-user']),displayName:String(req.headers['x-user'])}:undefined});
 const clients:WebSocket[]=[];
 try{await app.listen({host:'127.0.0.1',port:0});const port=(app.server.address() as import('node:net').AddressInfo).port,origin='http://127.0.0.1:'+port,url='ws://127.0.0.1:'+port+'/api/meetings/socket?group='+group.id;
  assert.equal((await app.inject('/api/meetings/config')).statusCode,401);
  const helper=await app.inject({url:'/api/meetings/helper',headers:{'x-user':'a'}});assert.equal(helper.statusCode,200);assert.equal(helper.rawPayload.subarray(0,2).toString(),'PK');assert.equal((await app.inject('/api/meetings/helper')).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/meetings/ticket',headers:{'x-user':'outsider'},payload:{group:group.id}})).statusCode,403);
  const rejected=async(user:string,source=origin)=>new Promise<number>(resolve=>{const ws=new WebSocket(url,{headers:{'x-user':user,origin:source}});ws.on('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode||0);ws.terminate();});ws.on('error',()=>resolve(403));});
  assert.equal(await rejected('outsider'),403);assert.equal(await rejected('a','https://foreign.test'),403);
  const connect=async(user:string)=>{const ticket=(await app.inject({method:'POST',url:'/api/meetings/ticket',headers:{'x-user':user},payload:{group:group.id}})).json().ticket;return new Promise<{ws:WebSocket;welcome:any;events:any[]}>(resolve=>{const ws=new WebSocket(url+'&ticket='+encodeURIComponent(ticket),{headers:{'x-user':user,origin}}),events:any[]=[];clients.push(ws);ws.on('message',data=>{const e=JSON.parse(data.toString());events.push(e);if(e.type==='welcome')resolve({ws,welcome:e,events});});});};
  const a=await connect('a'),b=await connect('b');const received=new Promise<any>(resolve=>b.ws.once('message',data=>resolve(JSON.parse(data.toString()))));a.ws.send(JSON.stringify({type:'signal',to:b.welcome.self,description:{type:'offer',sdp:'試験'}}));assert.equal((await received).from,a.welcome.self);
  authenticated=false;const closed=new Promise<void>(resolve=>a.ws.once('close',()=>resolve()));a.ws.send(JSON.stringify({type:'request-control',to:b.welcome.self}));await closed;
 }finally{for(const ws of clients)ws.terminate();await app.close();const log=await readFile(path.join(root,'.wentian','meetings','audit.jsonl'),'utf8');assert.match(log,/joined/);assert.doesNotMatch(log,/試験SDP|試験"|credential|Bearer/);await rm(root,{recursive:true,force:true});}
});
