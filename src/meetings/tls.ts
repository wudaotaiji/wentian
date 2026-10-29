import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

/** 利用者の証明書でHTTPS入口を追加し、既存HTTP・CLIの起動契約を保持します。 */
export function registerMeetingTls(app:FastifyInstance){
 const certificate=process.env.WENTIAN_HTTPS_CERT_FILE,key=process.env.WENTIAN_HTTPS_KEY_FILE;
 if(!certificate&&!key)return;
 if(!certificate||!key)throw Error('HTTPSの証明書と秘密鍵を両方指定してください。');
 const port=Number(process.env.WENTIAN_HTTPS_PORT||8443);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('HTTPSポートが不正です。');
 const sockets=new Set<import('node:net').Socket>();let server:ReturnType<typeof createServer>|undefined,opening:Promise<void>|undefined;
 let resolveReady!:()=>void,rejectReady!:(error:unknown)=>void;
 const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});void ready.catch(()=>undefined);
 const start=async()=>{
  const address=app.server.address();if(!address||typeof address==='string')throw Error('HTTP待受を確認できません。');
  const upstreamHost=['0.0.0.0','::'].includes(address.address)?'127.0.0.1':address.address;
  server=createServer({cert:await readFile(certificate),key:await readFile(key)},(req,res)=>{
   if(!req.url?.startsWith('/')){res.writeHead(400);res.end();return;}
   const headers={...req.headers,'x-forwarded-proto':'https','x-forwarded-for':req.socket.remoteAddress||''};
   const upstream=httpRequest({host:upstreamHost,port:address.port,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res);});
   upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(req,socket,head)=>{
   if(!req.url?.startsWith('/')){socket.destroy();return;}
   const upstream=connect({host:upstreamHost,port:address.port},()=>{
    const headers={...req.headers,'x-forwarded-proto':'https','x-forwarded-for':req.socket.remoteAddress||''};
    upstream.write(req.method+' '+req.url+' HTTP/1.1\r\n'+Object.entries(headers).filter(([,value])=>value!==undefined).map(([name,value])=>name+': '+value).join('\r\n')+'\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
   });upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
  });
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(port,process.env.WENTIAN_HTTPS_HOST||address.address,resolve);});
  app.log.info({port},'HTTPS入口を起動しました。');
 };
 app.addHook('onListen',async()=>{opening=start();try{await opening;resolveReady();}catch(error){app.log.error({err:error},'HTTPS入口の起動に失敗しました。');rejectReady(error);}});
 const stop=async()=>{await opening?.catch(()=>undefined);for(const socket of sockets)socket.destroy();const current=server;server=undefined;if(current)await new Promise<void>(resolve=>current.close(()=>resolve()));};
 app.addHook('preClose',stop);app.addHook('onClose',stop);
 return{ready};
}
