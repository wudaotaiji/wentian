import {registerMeetingRecordings,type RecordingDependencies} from './recordings.js';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { mkdir,appendFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentGroupStore } from '../agent-group.js';
import { assertOrdinaryPath } from '../safe-file.js';
import { MeetingHub } from './hub.js';
import { meetingsHtml } from './ui.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

export function meetingIceServers(raw?:string):RTCIceServerConfig[]{
  let value:any;try{value=JSON.parse(raw||'[]');}catch{throw new Error('会議用ICEサーバー設定が不正です。');}
  if(!Array.isArray(value)||value.length>8||value.some(s=>!s||Object.keys(s).some(k=>!['urls','username','credential'].includes(k))||!((typeof s.urls==='string'?[s.urls]:s.urls)?.length)||!(typeof s.urls==='string'?[s.urls]:s.urls).every((u:unknown)=>typeof u==='string'&&/^(stun|stuns|turn|turns):[^\s]+$/.test(u))||s.username!==undefined&&typeof s.username!=='string'||s.credential!==undefined&&typeof s.credential!=='string'))throw new Error('会議用ICEサーバー設定が不正です。');
  return value;
}
interface RTCIceServerConfig{urls:string|string[];username?:string;credential?:string}
export function registerMeetings(app:FastifyInstance,options:{workspace:string;identity:(req:FastifyRequest)=>{id:string;displayName:string}|undefined;hub?:(limit:number,audit:(entry:Record<string,unknown>)=>void)=>MeetingHub;iceServers?:RTCIceServerConfig[];maxParticipants?:number;recordings?:RecordingDependencies}){
 const groups=new AgentGroupStore(options.workspace),iceServers=options.iceServers||meetingIceServers(process.env.WENTIAN_MEETING_ICE_SERVERS),limit=options.maxParticipants??Number(process.env.WENTIAN_MEETING_MAX_PARTICIPANTS||6);
 if(!Number.isInteger(limit)||limit<2||limit>12)throw new Error('会議の人数上限は2〜12人で指定してください。');
 let writes=Promise.resolve();const file=path.join(options.workspace,'.wentian','meetings','audit.jsonl');
 const audit=(entry:Record<string,unknown>)=>{writes=writes.catch(()=>undefined).then(async()=>{await assertOrdinaryPath(file);await mkdir(path.dirname(file),{recursive:true});await appendFile(file,JSON.stringify(entry)+'\n',{mode:0o600});}).catch(error=>app.log.error({err:error},'会議の監査記録に失敗しました。'));};
 const hub=options.hub?.(limit,audit)||new MeetingHub(limit,audit),sockets=new WebSocketServer({noServer:true,maxPayload:128*1024,perMessageDeflate:false});
 app.get('/meetings',async(_req,reply)=>reply.type('text/html; charset=utf-8').send(meetingsHtml));
 app.get('/api/meetings/config',async(req,reply)=>{if(!options.identity(req))return reply.code(401).send({error:{message:'ログインが必要です。'}});return reply.header('cache-control','no-store').send({iceServers,maxParticipants:limit,helper:'http://127.0.0.1:8791'});});
 app.get('/api/meetings/helper',async(req,reply)=>{
  if(!options.identity(req))return reply.code(401).send({error:{message:'ログインが必要です。'}});
  const root=process.env.WENTIAN_INSTALL_ROOT||fileURLToPath(new URL('../../',import.meta.url)),files:Record<string,Uint8Array>={};
  for(const name of ['remote-assist-helper.py','remote-assist-helper.ps1'])files[name]=await readFile(path.join(root,'scripts',name));
  files['README.txt']=Buffer.from('Wentian 遠隔支援プラグイン\n\n操作されるPCで通常権限のPython 3を使用します。\npy -3 remote-assist-helper.py --origin <会議画面のOrigin>\n\n表示される接続キーは会議画面の本人用接続キーにだけ入力します。\nPC上の確認ダイアログで許可した対象だけを操作できます。\n緊急停止: Ctrl+Alt+Pause、またはヘルパーの終了。\n','utf8');
  return reply.header('cache-control','no-store').header('content-disposition','attachment; filename="WentianRemoteAssist.zip"').header('x-content-type-options','nosniff').type('application/zip').send(Buffer.from(zipSync(files)));
 });
 const authorize=async(req:FastifyRequest,groupId:string)=>{const user=options.identity(req);if(!user)return undefined;const group=await groups.load(groupId);return group.members.some(m=>m.kind==='human'&&m.active&&m.userId===user.id&&!m.muted&&!m.banned)?user:undefined;};
 registerMeetingRecordings(app,{workspace:options.workspace,hub,identity:options.identity,...options.recordings,member:async(group,user)=>{try{const value=await groups.load(group);return value.members.some(m=>m.kind==='human'&&m.active&&m.userId===user&&!m.muted&&!m.banned);}catch{return false;}}});
 const tickets=new Map<string,{userId:string;room:string;expires:number}>();
 app.post('/api/meetings/ticket',async(req,reply)=>{
  reply.header('cache-control','no-store');if((req.headers.origin&&!['http://'+req.headers.host,'https://'+req.headers.host].includes(req.headers.origin))||req.headers['sec-fetch-site']==='cross-site')return reply.code(403).send({error:{message:'同じサイトから操作してください。'}});
  const room=(req.body as {group?:string})?.group;if(typeof room!=='string')return reply.code(400).send({error:{message:'グループを選択してください。'}});
  const user=await authorize(req,room).catch(()=>undefined);if(!user)return reply.code(403).send({error:{message:'この群の有効な参加者だけが会議に参加できます。'}});
  for(const [id,ticket]of tickets)if(ticket.expires<=Date.now())tickets.delete(id);if(tickets.size>=256)return reply.code(429).send({error:{message:'接続準備が混雑しています。'}});
  const ticket=randomUUID();tickets.set(ticket,{userId:user.id,room,expires:Date.now()+15000});return{ticket};
 });
 const connections=new Map<WebSocket,{req:FastifyRequest;room:string;id:string;alive:boolean;rate:number;since:number;pending:number}>();
 const upgrade=(request:import('node:http').IncomingMessage,socket:import('node:stream').Duplex,head:Buffer)=>{
  if(request.url?.split('?')[0]!=='/api/meetings/socket')return;
  const origin=request.headers.origin,expected=['http://'+request.headers.host,'https://'+request.headers.host];
  if(!origin||!expected.includes(origin)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  const query=new URL(request.url,'http://localhost').searchParams,room=query.get('group')||'',req=request as unknown as FastifyRequest,token=query.get('ticket')||'',ticket=tickets.get(token),user=options.identity(req);
  // Bunでも同期Upgradeを保つため、直前のHTTP認証で発行した一回限りの券を検査します。
  if(!ticket||ticket.room!==room||ticket.userId!==user?.id||ticket.expires<=Date.now()||socket.destroyed){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  tickets.delete(token);
   sockets.handleUpgrade(request,socket,head,ws=>{
    let id:string;try{id=hub.join(room,user!.id,user!.displayName,value=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value));});}catch(error){ws.close(1008,(error as Error).message);return;}
    const connection={req,room,id,alive:true,rate:0,since:Date.now(),pending:0};connections.set(ws,connection);ws.on('pong',()=>connection.alive=true);
    let queue=Promise.resolve();ws.on('message',raw=>{
      if(Date.now()-connection.since>1000){connection.rate=0;connection.since=Date.now();}
      if(++connection.rate>100||++connection.pending>64){ws.close(1008,'送信頻度が上限です。');return;}
      queue=queue.then(async()=>{if(!connections.has(ws)||ws.readyState!==WebSocket.OPEN)return;if(!await authorize(req,room)){ws.close(1008,'参加権限が失効しました。');return;}hub.message(room,id,JSON.parse(raw.toString()));}).catch(error=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'error',message:(error as Error).message}));}).finally(()=>{connection.pending--;});
    });
    ws.on('close',()=>{hub.leave(room,id);connections.delete(ws);});ws.on('error',()=>ws.close());
   });
 };
 app.server.on('upgrade',upgrade);let checking=false;
 const timer=setInterval(()=>{hub.sweep();if(checking)return;checking=true;void Promise.all([...connections].map(async([ws,c])=>{if(!c.alive||!await authorize(c.req,c.room).catch(()=>undefined)){hub.leave(c.room,c.id);connections.delete(ws);ws.terminate();return;}c.alive=false;ws.ping();})).finally(()=>checking=false);},5000);timer.unref();
 app.addHook('preClose',async()=>{clearInterval(timer);for(const [ws,c]of connections){hub.leave(c.room,c.id);ws.terminate();}connections.clear();});
 app.addHook('onClose',async()=>{clearInterval(timer);app.server.removeListener('upgrade',upgrade);for(const [ws,c]of connections){hub.leave(c.room,c.id);ws.terminate();}connections.clear();sockets.close();await writes;});
 return hub;
}
