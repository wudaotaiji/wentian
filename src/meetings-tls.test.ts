import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { WebSocket,WebSocketServer } from 'ws';
import { registerMeetingTls } from './meetings/tls.js';

test('任意のHTTPS入口はHTTPとWebSocketを中継し、既存HTTP待受も維持する',async t=>{
 const openssl=process.env.WENTIAN_TEST_OPENSSL||'openssl';try{execFileSync(openssl,['version'],{stdio:'ignore'});}catch{t.skip('隔離した試験証明書の生成用OpenSSLがありません。');return;}
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-meeting-tls-')),cert=path.join(root,'test-cert.pem'),key=path.join(root,'test-key.pem'),config=path.join(root,'openssl.cnf');
 // 試験証明書は一時領域だけに作り、OSやブラウザーへ信頼登録しません。
 // 端末既定の設定Pathが無い環境でも動くよう、この試験専用の最小設定を明示します。
 await writeFile(config,'[req]\ndistinguished_name = dn\nprompt = no\n[dn]\nCN = localhost\n');
 execFileSync(openssl,['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-config',config],{stdio:'ignore'});
 const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));const port=(listener.address() as import('node:net').AddressInfo).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
 const names=['WENTIAN_HTTPS_CERT_FILE','WENTIAN_HTTPS_KEY_FILE','WENTIAN_HTTPS_PORT','WENTIAN_HTTPS_HOST'],previous=names.map(name=>process.env[name]);
 process.env.WENTIAN_HTTPS_CERT_FILE=cert;process.env.WENTIAN_HTTPS_KEY_FILE=key;process.env.WENTIAN_HTTPS_PORT=String(port);process.env.WENTIAN_HTTPS_HOST='127.0.0.1';
 const app=Fastify({trustProxy:['127.0.0.1']});const tls=registerMeetingTls(app);app.get('/test',req=>({protocol:req.protocol}));const wsServer=new WebSocketServer({noServer:true});app.server.on('upgrade',(req,socket,head)=>wsServer.handleUpgrade(req,socket,head,ws=>ws.on('message',data=>ws.send(data))));
 try{
  await app.listen({host:'127.0.0.1',port:0});await tls!.ready;assert.equal((await app.inject('/test')).statusCode,200);
  const body=await new Promise<string>((resolve,reject)=>{request({host:'127.0.0.1',port,path:'/test',rejectUnauthorized:false},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(text));}).on('error',reject).end();});assert.equal(JSON.parse(body).protocol,'https');
  const result=await new Promise<string>((resolve,reject)=>{const ws=new WebSocket('wss://127.0.0.1:'+port+'/echo',{rejectUnauthorized:false});ws.on('open',()=>ws.send('隔離した会議接続'));ws.on('message',data=>{resolve(data.toString());ws.close();});ws.on('error',reject);});assert.equal(result,'隔離した会議接続');
 }finally{await app.close();wsServer.close();for(let i=0;i<names.length;i++){if(previous[i]===undefined)delete process.env[names[i]];else process.env[names[i]]=previous[i];}await rm(root,{recursive:true,force:true});}
});
