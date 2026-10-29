import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { meetingsHtml } from './meetings/ui.js';

test('会議画面と録画欄の日本語をUnicodeエスケープのまま表示しない',()=>{
 const markup=meetingsHtml.replace(/<script>[\s\S]*?<\/script>/g,'');
 assert.ok(markup.includes('<title>ビデオ会議 · Wentian</title>'));
 assert.ok(markup.includes('録画・録音と議事録'));
 assert.doesNotMatch(markup,/\\u[0-9a-f]{4}/i);
});

async function fixture(recording=false){
 const window=new Window({url:'http://localhost/meetings?group=group-test'}),calls:any[]=[],sockets:any[]=[],connections:any[]=[];
 Object.defineProperty(window,'isSecureContext',{value:true});
 class Stream{static count=0;id='stream-'+(++Stream.count);tracks:any[]=[];getTracks(){return this.tracks}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video')}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio')}addTrack(t:any){this.tracks.push(t)}}
 const track=()=>({kind:'video',enabled:true,readyState:'live',onended:null as any,stop(){this.readyState='ended'},getSettings:()=>({displaySurface:'monitor'})});
 const capture=new Stream();capture.addTrack(track());
 // カメラとネイティブMediaStreamは試験から起動せず、表示先だけを模擬します。
 (window as any).MediaStream=Stream;(window.HTMLMediaElement.prototype as any).play=async()=>{};
 const sources=new WeakMap();Object.defineProperty(window.HTMLMediaElement.prototype,'srcObject',{configurable:true,get(){return sources.get(this)},set(value){sources.set(this,value)}});
 Object.defineProperty(window.navigator,'mediaDevices',{value:{getUserMedia:async()=>{const s=new Stream();s.addTrack(track());return s;},getDisplayMedia:async()=>capture}});
 class Connection{
  senders:any[]=[];connectionState='connected';signalingState='stable';localDescription:any;remoteDescription:any;ontrack:any;onnegotiationneeded:any;ondatachannel:any;channel:any;
  constructor(){connections.push(this)}getSenders(){return this.senders}addTrack(t:any){this.senders.push({track:t})}removeTrack(s:any){this.senders=this.senders.filter(t=>t!==s)}
  createDataChannel(){this.channel={readyState:'open',sent:[] as any[],send(value:string){this.sent.push(JSON.parse(value))},onmessage:null,onopen:null};return this.channel}
  async setLocalDescription(){this.localDescription={type:'offer',sdp:'isolated',toJSON(){return{type:this.type,sdp:this.sdp}}}}async setRemoteDescription(d:any){this.remoteDescription=d}async addIceCandidate(){}close(){this.connectionState='closed'}
 }
 (window as any).RTCPeerConnection=Connection;
 class Socket{readyState=1;sent:any[]=[];onmessage:any;onclose:any;onerror:any;constructor(){sockets.push(this);queueMicrotask(()=>this.emit({type:'welcome',self:'a',peers:[{id:'b',name:'試験担当',userId:'b'}]}))}emit(message:any){this.onmessage?.({data:JSON.stringify(message)})}send(data:string){this.sent.push(JSON.parse(data))}close(){this.readyState=3}}
 (window as any).WebSocket=Socket;
 window.fetch=(async(input:any,options:any={})=>{const url=String(input);calls.push({url,options,body:typeof options.body==='string'?JSON.parse(options.body):options.body});let data:any={};if(url==='/api/control-center/me')data={user:{id:'a',role:'admin',displayName:'本人'}};else if(url==='/api/workbench/groups')data={groups:[{id:'group-test',title:'試験会議'}]};else if(url==='/api/meetings/recordings/config')data={models:[{id:'fixture/model'}],maxBytes:1048576,maxSeconds:60};else if(url==='/api/meetings/recordings'&&options.method==='POST')data={id:'recording-test'};else if(url.startsWith('/api/meetings/recordings?'))data={recordings:[]};else if(url==='/api/meetings/config')data={iceServers:[]};else if(url==='/api/meetings/ticket')data={ticket:'isolated'};else if(url.endsWith('/status'))data={contract:'wentian-remote-assist/1',scopes:[{id:'screen:0',name:'試験画面'}]};else if(url.endsWith('/approve'))data={approved:true,scope:'試験画面'};return new window.Response(JSON.stringify(data));}) as any;
 const recorders:any[]=[];
 if(recording){
  class Audio {destination:any;constructor(){const stream=new Stream();stream.addTrack({kind:'audio',id:'mixed',readyState:'live',stop(){this.readyState='ended'}});this.destination={stream};}async resume(){}createMediaStreamDestination(){return this.destination}createMediaStreamSource(){return{connect(){},disconnect(){}}}async close(){}}
  (window as any).AudioContext=Audio;
  (window.HTMLCanvasElement.prototype as any).getContext=()=>({fillRect(){},drawImage(){},fillText(){}});
  (window.HTMLCanvasElement.prototype as any).captureStream=()=>{const stream=new Stream();stream.addTrack(track());return stream;};
  class Recorder {state='inactive';ondataavailable:any;onstop:any;onerror:any;constructor(readonly stream:any,readonly options:any){recorders.push(this)}static isTypeSupported(type:string){return type.includes('webm')}start(){this.state='recording'}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new window.Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3])])});this.onstop?.();});}}
  (window as any).MediaRecorder=Recorder;
 }
 window.document.write(meetingsHtml.replace(/<script>[\s\S]*?<\/script>/g,''));for(const script of meetingsHtml.matchAll(/<script>([\s\S]*?)<\/script>/g))window.eval(script[1]);
 const settle=async()=>{for(let i=0;i<35;i++)await new Promise(r=>setImmediate(r));};await settle();
 return{window,calls,sockets,connections,capture,Stream,settle,recorders};
}

test('本人の承認操作なしではヘルパーを呼ばず、共有と二段階承認後だけ許可する',async()=>{
 const f=await fixture(),doc=f.window.document;
 try{
  (doc.getElementById('meetingJoin') as any).click();await f.settle();
  (doc.getElementById('meetingShare') as any).click();await f.settle();
  (doc.getElementById('helperToken') as any).value='isolated-token';(doc.getElementById('helperConnect') as any).click();await f.settle();
  const socket=f.sockets[0];socket.emit({type:'control-request',id:'request',from:'b',to:'a',name:'試験担当'});await f.settle();
  assert.equal((doc.getElementById('controlRequest') as any).hidden,false);assert.equal(f.calls.some(c=>c.url.endsWith('/approve')),false);
  (doc.getElementById('controlApprove') as any).click();await f.settle();assert.equal(f.calls.filter(c=>c.url.endsWith('/approve')).length,1);assert.equal(socket.sent.at(-1).type,'approve-control');
  socket.emit({type:'control-granted',id:'request',from:'b',to:'a',scope:'試験画面',expires:Date.now()+10000});await f.settle();
  f.connections[0].channel.onmessage({data:JSON.stringify({type:'input',session:'request',seq:1,event:{kind:'move',x:0.5,y:0.5}})});await f.settle();assert.equal(f.calls.filter(c=>c.url.endsWith('/input')).length,1);
  f.capture.getVideoTracks()[0].onended();await f.settle();assert.equal(f.capture.getVideoTracks()[0].readyState,'ended');assert.ok(socket.sent.some((m:any)=>m.type==='revoke-control'));assert.ok(f.calls.some(c=>c.url.endsWith('/revoke')));
  f.connections[0].channel.onmessage({data:JSON.stringify({type:'input',session:'request',seq:2,event:{kind:'move',x:0.5,y:0.5}})});await f.settle();assert.equal(f.calls.filter(c=>c.url.endsWith('/input')).length,1);
 }finally{await f.window.happyDOM.close();}
});

test('共有していない相手の操作申請を無効にし、他PCのヘルパー接続先を拒否する',async()=>{
 const f=await fixture(),doc=f.window.document;
 try{
  (doc.getElementById('meetingJoin') as any).click();await f.settle();assert.equal((doc.querySelector('#meetingPeers button') as any).disabled,true);
  (doc.getElementById('helperToken') as any).value='isolated-token';(doc.getElementById('helperUrl') as any).value='https://foreign.test';(doc.getElementById('helperConnect') as any).click();await f.settle();assert.equal(f.calls.some(c=>c.url.startsWith('https://foreign.test')),false);
  f.sockets[0].emit({type:'control-request',id:'request',from:'b',to:'a',name:'試験担当'});(doc.getElementById('controlApprove') as any).click();await f.settle();assert.equal(f.calls.some(c=>c.url.endsWith('/approve')),false);
 }finally{await f.window.happyDOM.close();}
});

test('相手が共有を停止したら最後の共有映像も画面から取り除く',async()=>{
 const f=await fixture(),doc=f.window.document;
 try{(doc.getElementById('meetingJoin') as any).click();await f.settle();const stream=new f.Stream();f.connections[0].ontrack({streams:[stream]});f.connections[0].channel.onmessage({data:JSON.stringify({type:'media',camera:'other-camera',screen:stream.id})});await f.settle();assert.ok(doc.querySelector('video[data-stream="'+stream.id+'"]'));f.connections[0].channel.onmessage({data:JSON.stringify({type:'media',camera:'other-camera',screen:''})});await f.settle();assert.equal(doc.querySelector('video[data-stream="'+stream.id+'"]'),null);}finally{await f.window.happyDOM.close();}
});


test('録画は全員承認通知の後だけ開始し、停止時に最後の断片を保存して確定する',async()=>{
 for(const mode of ['audio','video']){
 const f=await fixture(true),doc=f.window.document;try{
  (doc.getElementById('meetingJoin') as any).click();await f.settle();(doc.getElementById('recordingModel') as any).value='fixture/model';(doc.getElementById('recordingMode') as any).value=mode;
  (doc.getElementById('recordingRequest') as any).click();await f.settle();assert.equal(f.sockets[0].sent.at(-1).type,'request-recording');assert.equal(f.recorders.length,0);
  const consent={id:'session',owner:'a',model:'fixture/model',automatic:true,language:'auto',mode,name:'本人'};
  f.sockets[0].emit({type:'recording-request',...consent});await f.settle();assert.equal(f.recorders.length,0);
  f.sockets[0].emit({type:'recording-ready',...consent});await f.settle();assert.equal(f.recorders.length,1);assert.equal(f.recorders[0].state,'recording');
  assert.equal(f.recorders[0].stream.getVideoTracks().length,mode==='video'?1:0);
  f.sockets[0].emit({type:'recording-ended',id:'session',reason:'participants_changed'});await f.settle();assert.ok(f.calls.some(c=>c.url.endsWith('/chunks/0')));assert.ok(f.calls.some(c=>c.url.endsWith('/finish')&&c.body.partial===false));assert.equal(f.recorders[0].state,'inactive');assert.ok(f.recorders[0].stream.getTracks().every((t:any)=>t.readyState==='ended'));
 }finally{await f.window.happyDOM.close();}}
});
test('録画の申請相手は承認・拒否を明示操作し、録画開始を勝手に実行しない',async()=>{
 const f=await fixture(true),doc=f.window.document;try{(doc.getElementById('meetingJoin') as any).click();await f.settle();f.sockets[0].emit({type:'recording-request',id:'session',owner:'b',mode:'video',model:'fixture/model',name:'相手'});await f.settle();assert.equal((doc.getElementById('recordingConsent') as any).hidden,false);assert.equal(f.recorders.length,0);(doc.getElementById('recordingApprove') as any).click();assert.equal(f.sockets[0].sent.at(-1).type,'approve-recording');(doc.getElementById('recordingStop') as any).click();assert.equal(f.sockets[0].sent.at(-1).type,'stop-recording');}finally{await f.window.happyDOM.close();}
});
