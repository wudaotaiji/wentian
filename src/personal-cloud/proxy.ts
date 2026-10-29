import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { CloudError } from './types.js';
import type { AccessVerifier } from './access.js';

/** アプリ専用プロキシ（Application Proxy）。制御APIを中継せず、候補の正常性確認後に転送先を切り替えます。 */
export class AppProxy {
  readonly server:Server;
  targetPort=0;
  allowedHost='';
  access?:AccessVerifier;
  port=0;
  constructor(){
    this.server=createServer(async(req,res)=>{
      if(!this.allowed(req.headers.host)){res.writeHead(404);res.end('未登録の公開ホストです。');return;}
      if(req.headers.host===this.allowedHost&&this.access&&!await this.access.authorize(req.headers['cf-access-jwt-assertion'] as string|undefined)){res.writeHead(403);res.end('アプリの利用者認証が必要です。');return;}
      if(!this.targetPort){res.writeHead(503);res.end('アプリは停止中です。');return;}
      const upstream=request({hostname:'127.0.0.1',port:this.targetPort,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:'+this.targetPort}},response=>{res.writeHead(response.statusCode||502,response.headers);response.pipe(res);});
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('アプリに接続できません。');});
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
    });
    // WebSocketアップグレード（WebSocket Upgrade）も同じホスト・転送先の制限を適用します。
    this.server.on('upgrade',async(req,socket,head)=>{
      if(!this.allowed(req.headers.host)||!this.targetPort){socket.destroy();return;}
      if(req.headers.host===this.allowedHost&&this.access&&!await this.access.authorize(req.headers['cf-access-jwt-assertion'] as string|undefined)){socket.destroy();return;}
      const upstream=connect(this.targetPort,'127.0.0.1',()=>{
        const headers={...req.headers,host:'127.0.0.1:'+this.targetPort};
        upstream.write(req.method+' '+req.url+' HTTP/1.1\r\n'+Object.entries(headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
        if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);
      });upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
    });
  }
  private allowed(host:string|undefined){const h=(host||'').toLowerCase();return h==='127.0.0.1:'+this.port||h==='localhost:'+this.port||(!!this.allowedHost&&h===this.allowedHost);}
  async listen(port=0){if(port===8787)throw new CloudError('管理用ポートは公開できません。');await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',()=>{this.server.removeListener('error',reject);resolve()});});this.port=(this.server.address() as import('node:net').AddressInfo).port;return this.port;}
  switch(port:number){if(port&&(!Number.isInteger(port)||port<1||port>65535||port===8787||port===this.port))throw new CloudError('アプリの転送先が不正です。');this.targetPort=port;}
  async close(){this.server.closeAllConnections();await new Promise<void>(resolve=>this.server.close(()=>resolve()));}
}
