import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import path from 'node:path';
import { CloudRepository } from './repository.js';
import { PersonalCloudService } from './service.js';
import { CloudError, type AppAction } from './types.js';
import { WebSocketServer } from 'ws';

/** 管理者セッションとノード署名を別々に認証し、Agentへ管理API権限を渡しません。 */
export function registerPersonalCloud(app:FastifyInstance,options:{file?:string;authorize:(req:FastifyRequest,reply:FastifyReply)=>string|undefined}){
  const repository=new CloudRepository(options.file||process.env.WENTIAN_CLOUD_STORE||path.join(process.env.WENTIAN_INSTALL_ROOT||process.cwd(),'.wentian','personal-cloud','cloud.sqlite'));
  const service=new PersonalCloudService(repository);
  // WSS（WebSocket Secure）の各生存報告にも署名を要求し、認証済み接続の乗っ取りを防ぎます。
  const sockets=new WebSocketServer({noServer:true,maxPayload:65536,perMessageDeflate:false});
  const upgrade:Parameters<typeof app.server.on>[1]=((req:any,socket:any,head:any)=>{
    if(req.url!=='/api/personal-cloud/agent/connect')return;
    if(req.headers.origin||req.headers['x-team-virtual-key']){socket.destroy();return;}
    sockets.handleUpgrade(req,socket,head,ws=>{
      let nodeId='',lastSeen=Date.now();
      const timer=setInterval(()=>{if(Date.now()-lastSeen>45000)ws.terminate();},15000);
      ws.on('error',()=>{});ws.once('close',()=>clearInterval(timer));
      ws.on('message',data=>{try{
        const input=JSON.parse(data.toString()),identity=service.authenticate('/api/personal-cloud/agent/connect',input);
        if(nodeId&&nodeId!==identity.nodeId)throw new CloudError('接続中のノードIDは変更できません。',401);
        nodeId=identity.nodeId;const status=service.heartbeat(nodeId,input.payload);lastSeen=Date.now();ws.send(JSON.stringify({type:'heartbeat',...status}));
      }catch{ws.close(1008,'ノード認証に失敗しました。');}});
    });
  }) as any;
  app.server.on('upgrade',upgrade);
  app.addHook('preClose',async()=>{for(const ws of sockets.clients)ws.terminate();});
  app.addHook('onClose',async()=>{app.server.removeListener('upgrade',upgrade);sockets.close();repository.close();});
  app.register(async routes=>{
    routes.addHook('preHandler',async(req,reply)=>{
      if(req.headers['x-team-virtual-key'])return reply.code(403).send({error:{message:'この操作にチーム仮想キーは使用できません。'}});
      if(req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return reply.code(403).send({error:{message:'同一オリジンから操作してください。'}});
    });
    routes.setErrorHandler((error,_req,reply)=>reply.code(error instanceof CloudError?error.statusCode:400).send({error:{message:error instanceof CloudError?error.message:'要求を処理できませんでした。設定と実行環境を確認してください。'}}));
    const admin=(req:FastifyRequest,reply:FastifyReply)=>options.authorize(req,reply);
    const key=(req:FastifyRequest)=>{const value=req.headers['idempotency-key'];if(typeof value!=='string'||! /^[A-Za-z0-9_-]{8,128}$/.test(value))throw new CloudError('8～128文字の再送キー（Idempotency-Key）が必要です。');return value;};
    routes.get('/api/personal-cloud',async(req,reply)=>{const owner=admin(req,reply);return owner?service.snapshot(owner):reply;});
    routes.post('/api/personal-cloud/codes',async(req,reply)=>{const owner=admin(req,reply);return owner?service.issueCode(owner,(req.body as any)?.name):reply;});
    routes.post('/api/personal-cloud/nodes/:id/:action',async(req,reply)=>{const owner=admin(req,reply);if(!owner)return reply;const {id,action}=req.params as {id:string;action:string};if(action==='approve')return service.approve(owner,id);if(action==='revoke')return service.revoke(owner,id);throw new CloudError('未対応のノード操作です。');});
    routes.post('/api/personal-cloud/placement',async(req,reply)=>{const owner=admin(req,reply);return owner?{candidates:service.placement(owner,(req.body as any)?.spec)}:reply;});
    routes.post('/api/personal-cloud/apps',async(req,reply)=>{const owner=admin(req,reply);return owner?service.createApp(owner,req.body as any,key(req)):reply;});
    routes.post('/api/personal-cloud/apps/:id/:action',async(req,reply)=>{const owner=admin(req,reply);if(!owner)return reply;const {id,action}=req.params as {id:string;action:AppAction};return service.action(owner,id,action,req.body as any,key(req));});
    // 登録コードは推測困難な1回限りの値です。Origin付き登録と他用途への流用を拒否します。
    routes.post('/api/personal-cloud/agent/enroll',async(req,reply)=>{if(req.headers.origin)return reply.code(403).send({error:{message:'端末CLIから登録してください。'}});const body=req.body as any;if(typeof body?.code!=='string'||typeof body?.publicKey!=='string')throw new CloudError('登録要求が不正です。');return service.enroll(body.code,body.publicKey);});
    routes.post('/api/personal-cloud/agent/:action',async(req)=>{
      const body=req.body as any;if(!body||typeof body!=='object')throw new CloudError('署名要求が必要です。',401);
      const {nodeId,approved}=service.authenticate(req.url,body);const {action}=req.params as {action:string};const p=body.payload;
      if(action==='heartbeat')return service.heartbeat(nodeId,p);
      if(!approved)throw new CloudError('管理者の端末承認待ちです。',403);
      if(action==='claim')return service.claim(nodeId);
      if(action==='renew')return service.renew(nodeId,p.jobId,p.lease);
      if(action==='result')return service.finish(nodeId,p.jobId,p.lease,p.result);
      throw new CloudError('未対応の端末要求です。');
    });
  });return service;
}
