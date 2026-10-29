import { createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CloudError, type CloudJob, type JobResult, type AppSpec } from './types.js';
import { signedPayload } from './service.js';
import { ContainerRuntime, diagnoseNode, waitHealthy } from './runtime.js';
import { AppProxy } from './proxy.js';
import { TunnelConnector } from './tunnel.js';
import WebSocket from 'ws';
import { writeFileSync, renameSync } from 'node:fs';
import { readGpuProofs } from './gpu.js';
import { observeMemory } from '../manager.js';

interface Identity {server:string;nodeId:string;publicKey:string;protectedKey:string;protection:'dpapi'|'file-0600'}
interface LocalDeployment {name:string;port:number;spec:AppSpec;imageDigest:string;gpuIndex?:number}
interface LocalApp {appId:string;proxyPort:number;desired:'running'|'stopped';current?:LocalDeployment;previous?:LocalDeployment;candidate?:LocalDeployment;pendingSpec?:AppSpec;pendingGpu?:number}
const execute=promisify(execFile);
/** WindowsではDPAPI（Data Protection API）を使い、秘密鍵を同じOSユーザーに束縛します。 */
async function protectKey(value:string,decrypt=false){
  if(process.platform!=='win32')return value;
  const script=decrypt
    ? "Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String($env:WENTIAN_PRIVATE_KEY_INPUT); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"
    : "Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes($env:WENTIAN_PRIVATE_KEY_INPUT); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  const result=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,env:{...process.env,WENTIAN_PRIVATE_KEY_INPUT:value},encoding:'utf8'});return result.stdout.trim();
}
export function validateControlUrl(value:string){const url=new URL(value);if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new CloudError('制御先は認証値を含まないルートURLで指定してください。');if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new CloudError('遠隔制御にはHTTPSが必要です。');return url.origin;}

/** 登録（Enrollment）はPC上で鍵を生成し、公開鍵だけを制御サーバーへ送ります。 */
export async function enrollNode(root:string,server:string,code:string){
  server=validateControlUrl(server);await mkdir(root,{recursive:true,mode:0o700});
  const identityFile=path.join(root,'identity.json');try{await readFile(identityFile);throw new CloudError('この保存先は登録済みです。別の保存先を指定してください。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'pem'}).toString(),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const response=await fetch(server+'/api/personal-cloud/agent/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,publicKey}),redirect:'error',signal:AbortSignal.timeout(15000)});const data=await response.json() as any;if(!response.ok)throw new CloudError(data.error?.message||'端末登録に失敗しました。');
  const identity:Identity={server,nodeId:data.nodeId,publicKey,protectedKey:await protectKey(privateKey),protection:process.platform==='win32'?'dpapi':'file-0600'};
  await writeFile(identityFile,JSON.stringify(identity),{mode:0o600,flag:'wx'});return {nodeId:data.nodeId,status:data.status};
}

/** 外向きAgent接続（Outbound Agent Connection）。制御サーバー停止時もプロキシとアプリは維持します。 */
export class NodeAgent {
  private db:DatabaseSync;
  private identity!:Identity;
  private privateKey!:ReturnType<typeof createPrivateKey>;
  private proxies=new Map<string,AppProxy>();
  private connector:TunnelConnector;
  private busy=false;
  private pendingResult?:{job:CloudJob;result:JobResult};
  private socket?:WebSocket;
  private socketStatus?:{approved:boolean;revoked:boolean;at:number};
  private lockOwned=false;
  constructor(readonly root:string){this.db=new DatabaseSync(path.join(root,'node.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,value TEXT NOT NULL);');this.connector=new TunnelConnector(path.join(root,'tunnels'));}
  private save(app:LocalApp){this.db.prepare('INSERT OR REPLACE INTO apps(id,value) VALUES(?,?)').run(app.appId,JSON.stringify(app));this.publishReservations();}
  private publishReservations(){
    const reservations=[];
    for(const row of this.db.prepare('SELECT value FROM apps').all()){const app:LocalApp=JSON.parse(String(row.value));if(app.desired==='running'&&app.current)reservations.push({appId:app.appId,memoryBytes:app.current.spec.memoryBytes,gpuMemoryBytes:app.current.spec.gpuMemoryBytes,gpuIndex:app.current.gpuIndex});if(app.pendingSpec)reservations.push({appId:app.appId,memoryBytes:app.pendingSpec.memoryBytes,gpuMemoryBytes:app.pendingSpec.gpuMemoryBytes,gpuIndex:app.pendingGpu});}
    const target=path.join(this.root,'resources.json'),temporary=target+'.'+process.pid+'.tmp';writeFileSync(temporary,JSON.stringify({at:new Date().toISOString(),reservations}),{mode:0o600});renameSync(temporary,target);
  }
  private app(appId:string):LocalApp|undefined{const row=this.db.prepare('SELECT value FROM apps WHERE id=?').get(appId);return row?JSON.parse(String(row.value)):undefined;}
  private async proxy(app:LocalApp){let proxy=this.proxies.get(app.appId);if(!proxy){proxy=new AppProxy();await proxy.listen(app.proxyPort);app.proxyPort=proxy.port;this.proxies.set(app.appId,proxy);this.save(app);}return proxy;}
  async initialize(){
    // 同じ端末台帳を2プロセスで操作させず、再接続中の二重プロキシ・二重配備を防ぎます。
    this.db.exec('CREATE TABLE IF NOT EXISTS agent_lock(id INTEGER PRIMARY KEY,pid INTEGER NOT NULL); BEGIN IMMEDIATE');
    try{const previous=this.db.prepare('SELECT pid FROM agent_lock WHERE id=1').get();if(previous){let alive=true;try{process.kill(Number(previous.pid),0)}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}if(alive)throw new CloudError('この端末Agentは既に実行中です。');}this.db.prepare('INSERT OR REPLACE INTO agent_lock(id,pid) VALUES(1,?)').run(process.pid);this.db.exec('COMMIT');this.lockOwned=true;}catch(error){this.db.exec('ROLLBACK');throw error;}
    this.identity=JSON.parse(await readFile(path.join(this.root,'identity.json'),'utf8'));validateControlUrl(this.identity.server);this.privateKey=createPrivateKey(await protectKey(this.identity.protectedKey,true));
    for(const row of this.db.prepare('SELECT value FROM apps').all()) {const app:LocalApp=JSON.parse(String(row.value));const proxy=await this.proxy(app);if(app.desired==='running'&&app.current){const runtime=new ContainerRuntime(app.current.spec.engine);try{app.current.port=(await runtime.start(app.current.name,app.appId,app.current.spec.containerPort))!;await waitHealthy(app.current.port,app.current.spec.healthPath);proxy.switch(app.current.port);this.save(app);}catch{console.warn('配備済みアプリの復旧に失敗しました。実行環境を確認してください。');}}}
  }
  private envelope(route:string,payload:unknown){const timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex');const signature=sign(null,Buffer.from(signedPayload(route,timestamp,nonce,payload)),this.privateKey).toString('base64');return {nodeId:this.identity.nodeId,timestamp,nonce,signature,payload};}
  private async request(route:string,payload:unknown){
    const response=await fetch(this.identity.server+route,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(this.envelope(route,payload)),signal:AbortSignal.timeout(20000)});const data=await response.json() as any;if(!response.ok)throw new CloudError(data.error?.message||'制御接続に失敗しました。',response.status);return data;
  }
  async tick(){
    const capabilities=await diagnoseNode(undefined,this.root);
    // WSSへ外向き接続し、生存報告だけを継続します。ジョブ本文は署名付きHTTPSで取得します。
    if(!this.socket||this.socket.readyState===WebSocket.CLOSED){
      const socket=new WebSocket(this.identity.server.replace(/^http/,'ws')+'/api/personal-cloud/agent/connect',{handshakeTimeout:10000,perMessageDeflate:false,maxPayload:65536});this.socket=socket;
      socket.on('error',()=>{});socket.on('open',()=>socket.send(JSON.stringify(this.envelope('/api/personal-cloud/agent/connect',capabilities))));
      socket.on('message',data=>{try{const response=JSON.parse(data.toString());if(response.type==='heartbeat')this.socketStatus={approved:response.approved,revoked:response.revoked,at:Date.now()};}catch{/* 不正な応答を成功扱いにしません。 */}});
      socket.on('close',code=>{this.socketStatus=undefined;if(code===1008)for(const [id,proxy] of this.proxies)this.connector.unpublish(id,proxy);});
    }else if(this.socket.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(this.envelope('/api/personal-cloud/agent/connect',capabilities)));
    const status=this.socketStatus&&Date.now()-this.socketStatus.at<45000?this.socketStatus:await this.request('/api/personal-cloud/agent/heartbeat',capabilities);
    if(!status.approved)return;
    if(this.pendingResult){try{await this.report(this.pendingResult.job,this.pendingResult.result);}catch(error){if(!(error instanceof CloudError)||error.statusCode!==409)throw error;}this.pendingResult=undefined;}
    if(this.busy)return;
    this.busy=true;
    let job:CloudJob;
    try{const response=await this.request('/api/personal-cloud/agent/claim',{});if(!response.job){this.busy=false;return;}job=response.job;}catch(error){this.busy=false;throw error;}
    // 配備中も別のtickが生存報告を続け、ジョブの実行権だけを定期延長します。
    const renew=setInterval(()=>{void this.request('/api/personal-cloud/agent/renew',{jobId:job.id,lease:job.lease}).catch(()=>{});},15000);
    try{
      const cached=this.db.prepare('SELECT value FROM results WHERE id=?').get(job.id);
      const result:JobResult=cached?JSON.parse(String(cached.value)):await this.execute(job);
      this.db.prepare('INSERT OR REPLACE INTO results(id,value) VALUES(?,?)').run(job.id,JSON.stringify(result));this.pendingResult={job,result};
      await this.report(job,result);this.pendingResult=undefined;
    }finally{clearInterval(renew);this.busy=false;}
  }
  private async report(job:CloudJob,result:JobResult){await this.request('/api/personal-cloud/agent/result',{jobId:job.id,lease:job.lease,result});}
  /** 限定ジョブ（Restricted Job）だけを実行し、シェル本文・任意パス・実行ファイルを受け付けません。 */
  async execute(job:CloudJob):Promise<JobResult>{
    let app=this.app(job.appId)||{appId:job.appId,proxyPort:0,desired:'running' as const};
    const runtime=new ContainerRuntime(job.spec.engine);
    try{
      if(Date.parse(job.deadlineAt)<Date.now())throw new CloudError('ジョブ期限を超過しています。');
      const proxy=await this.proxy(app);
      if(job.action==='deploy'){
        const name='wentian-'+job.id;
        // 台帳確定後・結果報告前に切断して再送された場合、稼働版を旧版として停止しません。
        if(app.current?.name===name){await waitHealthy(app.current.port,app.current.spec.healthPath);proxy.switch(app.current.port);return {state:'ready',localUrl:'http://127.0.0.1:'+proxy.port,imageDigest:app.current.imageDigest,deploymentId:app.current.name.slice(8)};}
        try{
          if(job.spec.gpuMemoryBytes){const proofs=await readGpuProofs(this.root);const memory=await observeMemory({ignoreNodeReservations:true});const gpu=memory.gpus.find(g=>g.index===job.gpuIndex&&g.vendor==='nvidia');if(!gpu||gpu.freeBytes<job.spec.gpuMemoryBytes||!proofs.some(p=>p.engine===job.spec.engine&&p.index===gpu.index&&p.name===gpu.name))throw new CloudError('検証済みGPUまたは空きVRAMが不足しています。');}
          app.pendingSpec=job.spec;app.pendingGpu=job.gpuIndex;this.save(app);
          const deployed=await runtime.deploy(job.appId,job.id,job.spec,job.gpuIndex);app.candidate={...deployed,spec:job.spec,gpuIndex:job.gpuIndex};this.save(app);
          await waitHealthy(deployed.port,job.spec.healthPath);
          // 旧版を除去する前に新しい経路と台帳を確定し、更新失敗時の応答を維持します。
          const obsolete=app.previous;app.previous=app.current;app.current=app.candidate;app.candidate=undefined;app.pendingSpec=undefined;app.pendingGpu=undefined;app.desired='running';proxy.switch(deployed.port);this.save(app);
          if(obsolete)await new ContainerRuntime(obsolete.spec.engine).remove(obsolete.name,job.appId).catch(()=>{});
          if(app.previous)await new ContainerRuntime(app.previous.spec.engine).stop(app.previous.name,job.appId).catch(()=>{});
          return {state:'ready',localUrl:'http://127.0.0.1:'+proxy.port,imageDigest:deployed.imageDigest,deploymentId:job.id};
        }catch(error){await runtime.remove(name,job.appId).catch(()=>{});if(!app.current)await runtime.removeNetwork(job.appId).catch(()=>{});app.candidate=undefined;app.pendingSpec=undefined;app.pendingGpu=undefined;this.save(app);throw error;}
      }
      if(job.action==='publish'){
        if(!app.current||app.desired!=='running'||!job.publication)throw new CloudError('起動済みアプリを指定してください。');
        await waitHealthy(app.current.port,app.current.spec.healthPath);
        return {state:'ready',...await this.connector.publish(job.appId,proxy,job.publication)};
      }
      if(job.action==='unpublish'){this.connector.unpublish(job.appId,proxy);return {state:app.desired==='running'?'ready':'stopped',publicUrl:'',publication:'private'};}
      if(job.action==='stop'||job.action==='delete'){
        proxy.switch(0);this.connector.unpublish(job.appId,proxy);app.desired='stopped';this.save(app);
        for(const deployment of [app.current,app.previous,app.candidate])if(deployment){const engine=new ContainerRuntime(deployment.spec.engine);if(job.action==='delete')await engine.remove(deployment.name,job.appId);else await engine.stop(deployment.name,job.appId);}
        if(job.action==='delete'){for(const engine of new Set([job.spec.engine,...[app.current,app.previous,app.candidate].filter(Boolean).map(d=>d!.spec.engine)]))await new ContainerRuntime(engine).removeNetwork(job.appId);app.current=undefined;app.previous=undefined;app.candidate=undefined;app.pendingSpec=undefined;this.save(app);}
        return {state:job.action==='delete'?'deleted':'stopped',publicUrl:'',publication:'private'};
      }
      if(job.action==='rollback'){
        if(!app.previous)throw new CloudError('戻せる旧版がありません。');const old=app.previous;
        old.port=(await new ContainerRuntime(old.spec.engine).start(old.name,job.appId,old.spec.containerPort))!;await waitHealthy(old.port,old.spec.healthPath);
        app.previous=app.current;app.current=old;app.desired='running';proxy.switch(old.port);this.save(app);
        if(app.previous)await new ContainerRuntime(app.previous.spec.engine).stop(app.previous.name,job.appId).catch(()=>{});
        return {state:'ready',localUrl:'http://127.0.0.1:'+proxy.port,imageDigest:old.imageDigest,deploymentId:old.name.slice(8)};
      }
      if(job.action==='start'){
        if(!app.current)throw new CloudError('配備済みアプリがありません。');
        app.current.port=(await new ContainerRuntime(app.current.spec.engine).start(app.current.name,job.appId,app.current.spec.containerPort))!;await waitHealthy(app.current.port,app.current.spec.healthPath);app.desired='running';proxy.switch(app.current.port);this.save(app);return {state:'ready',localUrl:'http://127.0.0.1:'+proxy.port};
      }
      throw new CloudError('未対応のジョブです。');
    }catch(error){return {state:app.current?'degraded':'failed',error:error instanceof CloudError?error.message:'実行処理が失敗しました。端末の実行環境を確認してください。'};}
  }
  /** 明示的なAgent停止ではTunnelを閉じ、コンテナは停止させません。 */
  async close(){this.socket?.terminate();for(const [id,proxy] of this.proxies){this.connector.unpublish(id,proxy);await proxy.close();}if(this.lockOwned)this.db.prepare('DELETE FROM agent_lock WHERE id=1 AND pid=?').run(process.pid);this.lockOwned=false;this.db.close();}
}

/** 15秒の生存報告（Heartbeat）と指数バックオフ（Exponential Backoff）で外向き接続を維持します。 */
export async function runNodeAgent(root:string,signal:AbortSignal){
  const agent=new NodeAgent(root);let failures=0;const running=new Set<Promise<void>>();
  try{await agent.initialize();while(!signal.aborted){const task=agent.tick().then(()=>{failures=0}).catch(error=>{failures++;console.warn(error instanceof CloudError?error.message:'端末の制御接続に失敗しました。再接続します。');});running.add(task);void task.finally(()=>running.delete(task));
    const delay=failures?Math.min(60000,1000*2**Math.min(failures,6))+Math.random()*1000:15000;
    await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()},timer=setTimeout(done,delay);signal.addEventListener('abort',done,{once:true});});
  }}finally{await Promise.allSettled(running);await agent.close();}
}
