import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { CloudRepository } from './repository.js';
import { rankNodes, validateSpec } from './scheduler.js';
import { CloudError, iso, type AppAction, type Capabilities, type CloudState, type JobResult, type CloudJob } from './types.js';

export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** 署名対象（Signed Payload）に経路・時刻・本文を含め、別操作への流用を防ぎます。 */
export const signedPayload=(route:string,timestamp:string,nonce:string,body:unknown)=>[route,timestamp,nonce,hash(JSON.stringify(body))].join('\n');
const id=(kind:string)=>kind+'_'+randomUUID();
/** 更新候補（Candidate Deployment）も予約に含め、まだ起動していないジョブで過剰割当させません。 */
function reservedApps(s:CloudState){const extra=s.jobs.filter(j=>['deploy','start','rollback'].includes(j.action)&&['queued','running'].includes(j.status)&&s.apps.some(a=>a.id===j.appId&&(j.action!=='deploy'||a.revision>1))).map(j=>({...s.apps.find(a=>a.id===j.appId)!,id:j.id,spec:j.spec,gpuIndex:j.gpuIndex,state:'queued'}));return [...s.apps,...extra];}
function audit(s:CloudState,ownerId:string,action:string,resourceId:string,result='成功'){s.audit.push({id:id('audit'),ownerId,action,resourceId,at:iso(),result});s.audit=s.audit.slice(-10000);}
function own<T extends {id:string;ownerId:string}>(items:T[],resourceId:string,ownerId:string):T {const item=items.find(x=>x.id===resourceId&&x.ownerId===ownerId);if(!item)throw new CloudError('対象が存在しません。',404);return item;}

/** 制御平面（Control Plane）の所有者境界・登録・予約・ジョブ状態を一元管理します。 */
export class PersonalCloudService {
  constructor(readonly repository:CloudRepository){}
  snapshot(ownerId:string){const s=this.repository.read();const now=Date.now();return {
    nodes:s.nodes.filter(n=>n.ownerId===ownerId).map(({publicKey,...n})=>({...n,status:n.revoked?'revoked':!n.approved?'pending':!n.lastSeenAt||now-Date.parse(n.lastSeenAt)>90000?'offline':now-Date.parse(n.lastSeenAt)>45000?'unknown':'online'})),
    apps:s.apps.filter(a=>a.ownerId===ownerId),jobs:s.jobs.filter(j=>j.ownerId===ownerId).slice(-100).reverse(),audit:s.audit.filter(a=>a.ownerId===ownerId).slice(-100).reverse(),
    readiness:{cloud:'ローカル制御平面。外部ホスティングは未設定',tunnel:'通常Tunnelはアカウント・ドメイン・ノード別資格情報の設定が必要',gpu:'NVIDIAはコンテナ実測証拠が必要。アプリ予約をAI資源判定へ反映。GPU実機は未検証',transport:'署名付きWSS生存報告とHTTPSジョブ取得。接続障害時は再接続'}
  };}
  issueCode(ownerId:string,name:string){if(typeof name!=='string'||!name.trim()||name.length>100)throw new CloudError('ノード名を入力してください。');const code=randomBytes(24).toString('base64url');return this.repository.transaction(s=>{s.codes=s.codes.filter(c=>c.expires>Date.now());s.codes.push({hash:hash(code),ownerId,name:name.trim(),expires:Date.now()+600000});audit(s,ownerId,'node.code','登録コード');return {code,expiresAt:new Date(Date.now()+600000).toISOString()};});}
  enroll(code:string,publicKey:string){
    if(typeof publicKey!=='string'||publicKey.length>1000||createPublicKey(publicKey).asymmetricKeyType!=='ed25519')throw new CloudError('Ed25519公開鍵を指定してください。');
    return this.repository.transaction(s=>{const c=s.codes.find(x=>x.hash===hash(code)&&x.expires>Date.now());if(!c)throw new CloudError('登録コードが無効または期限切れです。',401);s.codes=s.codes.filter(x=>x!==c);const node={id:id('node'),ownerId:c.ownerId,name:c.name,publicKey,approved:false,revoked:false,createdAt:iso()};s.nodes.push(node);audit(s,c.ownerId,'node.enroll',node.id);return {nodeId:node.id,status:'pending'};});
  }
  approve(ownerId:string,nodeId:string){return this.repository.transaction(s=>{const n=own(s.nodes,nodeId,ownerId);if(n.revoked)throw new CloudError('失効済みノードは再登録してください。',409);n.approved=true;audit(s,ownerId,'node.approve',nodeId);return {ok:true};});}
  revoke(ownerId:string,nodeId:string){return this.repository.transaction(s=>{own(s.nodes,nodeId,ownerId).revoked=true;audit(s,ownerId,'node.revoke',nodeId);return {ok:true,warning:'制御接続を失効しました。公開経路の外部遮断は別途必要です。'};});}
  /** 全Agent要求を登録鍵で検証し、5分有効のnonceを原子的に消費します。 */
  authenticate(route:string,input:{nodeId:string;timestamp:string;nonce:string;signature:string;payload:unknown}) {
    const {nodeId,timestamp,nonce,signature,payload}=input;
    if(typeof timestamp!=='string'||Math.abs(Date.now()-Number(timestamp))>60000||!Number.isFinite(Number(timestamp))||typeof nonce!=='string'||!/^[a-f0-9]{32}$/.test(nonce)||typeof signature!=='string')throw new CloudError('署名情報が不正です。',401);
    return this.repository.transaction(s=>{const node=s.nodes.find(n=>n.id===nodeId);if(!node||node.revoked)throw new CloudError('ノードは未登録または失効しています。',401);
      if(!verify(null,Buffer.from(signedPayload(route,timestamp,nonce,payload)),node.publicKey,Buffer.from(signature,'base64')))throw new CloudError('ノード署名が一致しません。',401);
      s.nonces=s.nonces.filter(n=>n.expires>Date.now());if(s.nonces.some(n=>n.nodeId===nodeId&&n.nonce===nonce))throw new CloudError('要求の再利用を拒否しました。',409);s.nonces.push({nodeId,nonce,expires:Date.now()+300000});
      return {nodeId:node.id,ownerId:node.ownerId,approved:node.approved};
    });
  }
  heartbeat(nodeId:string,capabilities:Capabilities){
    if(!capabilities||!['win32','linux','darwin'].includes(capabilities.os)||!Number.isFinite(capabilities.memoryBytes)||capabilities.memoryBytes<=0||!Number.isFinite(capabilities.freeMemoryBytes)||capabilities.freeMemoryBytes<0||capabilities.freeMemoryBytes>capabilities.memoryBytes||!Number.isFinite(capabilities.cpuCores)||capabilities.cpuCores<=0||!Array.isArray(capabilities.runtimes)||!Array.isArray(capabilities.gpus)||!Array.isArray(capabilities.ai))throw new CloudError('端末の診断結果が不正です。');
    return this.repository.transaction(s=>{const n=s.nodes.find(n=>n.id===nodeId)!;n.capabilities={...capabilities,observedAt:iso()};n.lastSeenAt=iso();return {approved:n.approved,revoked:n.revoked};});
  }
  placement(ownerId:string,spec:unknown){const s=this.repository.read();return rankNodes(s.nodes,reservedApps(s),validateSpec(spec),ownerId);}
  createApp(ownerId:string,input:{nodeId?:string;spec:unknown},key:string){const spec=validateSpec(input.spec);return this.repository.transaction(s=>{
    const requestHash=hash(JSON.stringify({spec,nodeId:input.nodeId}));const duplicate=s.jobs.find(j=>j.ownerId===ownerId&&j.action==='deploy'&&j.idempotencyKey===key);
    if(duplicate){if(duplicate.requestHash!==requestHash)throw new CloudError('同じ再送キーで異なる設定は使えません。',409);return duplicate;}
    const candidates=rankNodes(s.nodes,reservedApps(s),spec,ownerId);const selected=input.nodeId?candidates.find(n=>n.nodeId===input.nodeId):candidates.find(n=>n.eligible);
    if(!selected?.eligible)throw new CloudError('配置可能なノードがありません: '+(selected?.reasons.join('、')||candidates.flatMap(n=>n.reasons).join('、')||'ノードを登録・承認し、診断してください。'),409);
    const app={id:id('app'),ownerId,nodeId:selected.nodeId,spec,gpuIndex:selected.gpuIndex,revision:1,desiredState:'running' as const,state:'queued',publication:'private',createdAt:iso()};s.apps.push(app);
    const job=this.newJob(s,ownerId,app.id,'deploy',key,requestHash);audit(s,ownerId,'app.create',app.id);return job;
  });}
  private newJob(s:CloudState,ownerId:string,appId:string,action:AppAction,key:string,requestHash:string){const app=own(s.apps,appId,ownerId);const job:CloudJob={id:id('job'),ownerId,nodeId:app.nodeId,appId,action,spec:structuredClone(app.spec),gpuIndex:app.gpuIndex,status:'queued',createdAt:iso(),deadlineAt:new Date(Date.now()+30*60000).toISOString(),requestHash,idempotencyKey:key,attempt:0};s.jobs.push(job);return job;}
  action(ownerId:string,appId:string,action:AppAction,input:{revision:number;spec?:unknown;publication?:unknown},key:string){
    if(!['deploy','start','stop','rollback','delete','publish','unpublish'].includes(action))throw new CloudError('未対応の操作です。');
    return this.repository.transaction(s=>{const app=own(s.apps,appId,ownerId);const requestHash=hash(JSON.stringify({action,appId,input}));const duplicate=s.jobs.find(j=>j.ownerId===ownerId&&j.appId===appId&&j.action===action&&j.idempotencyKey===key);
      if(duplicate){if(duplicate.requestHash!==requestHash)throw new CloudError('再送キーが別の設定に使われています。',409);return duplicate;}
      if(app.revision!==input.revision)throw new CloudError('他の操作で更新されています。一覧を再取得してください。',409);
      if(s.jobs.some(j=>j.appId===appId&&['queued','running'].includes(j.status)))throw new CloudError('このアプリは処理中です。',409);
      if(app.desiredState==='deleted')throw new CloudError('削除済みアプリです。',409);
      const n=own(s.nodes,app.nodeId,ownerId);if(n.revoked||!n.approved)throw new CloudError('ノードは失効または未承認です。',409);
      let nextSpec=app.spec,nextGpu=app.gpuIndex;
      if(action==='deploy') {nextSpec=validateSpec(input.spec);const candidate=rankNodes(s.nodes,reservedApps(s),nextSpec,ownerId).find(n=>n.nodeId===app.nodeId);if(!candidate?.eligible)throw new CloudError('旧版を維持した更新用資源が不足しています。',409);nextGpu=candidate.gpuIndex;}
      if(action==='rollback'){
        // 成功した配備のうち現行版以外の直近を選び、旧版の資源も起動前に予約します。
        const previous=[...s.jobs].reverse().find(j=>j.appId===appId&&j.action==='deploy'&&j.status==='succeeded'&&j.id!==app.deploymentId);
        if(!previous)throw new CloudError('戻せる旧版がありません。',409);nextSpec=previous.spec;nextGpu=previous.gpuIndex;
      }
      if(action==='start'||action==='rollback'){const candidate=rankNodes(s.nodes,reservedApps(s).filter(a=>action==='rollback'||a.id!==appId),nextSpec,ownerId).find(n=>n.nodeId===app.nodeId);if(!candidate?.eligible||(nextSpec.gpuMemoryBytes&&candidate.gpuIndex!==nextGpu))throw new CloudError('起動用資源が不足しています。',409);}
      const job=this.newJob(s,ownerId,appId,action,key,requestHash);
      job.spec=nextSpec;
      job.gpuIndex=nextGpu;
      if(action==='publish'){
        const p=input.publication as {mode?:string;anonymous?:boolean;hostname?:string;allowedEmails?:string[]};
        if(!p||!['quick','named'].includes(p.mode||''))throw new CloudError('公開方式を指定してください。');
        if(p.allowedEmails!==undefined&&(!Array.isArray(p.allowedEmails)||p.allowedEmails.length>20||p.allowedEmails.some(email=>typeof email!=='string'||! /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(email)||email.length>254)))throw new CloudError('許可メールアドレスは20件以内で指定してください。');
        if(p.mode==='quick'&&p.anonymous!==true&&!p.allowedEmails?.length)throw new CloudError('認証付き検証用公開には許可メールアドレスが必要です。');
        if(p.mode==='named'&&(typeof p.hostname!=='string'||! /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(p.hostname)))throw new CloudError('公開ホスト名が不正です。');
        if(p.hostname&&s.apps.some(a=>a.id!==appId&&a.publicUrl==='https://'+p.hostname&&a.publication!=='private'))throw new CloudError('この公開名は使用済みです。',409);
        Object.assign(job,{publication:{mode:p.mode,anonymous:p.anonymous===true,hostname:p.hostname,allowedEmails:p.allowedEmails}});
      }
      if(['stop','delete'].includes(action))app.desiredState='stopped';
      if(['start','deploy','rollback'].includes(action))app.desiredState='running';app.revision++;audit(s,ownerId,'app.'+action,appId);return job;
    });
  }
  claim(nodeId:string){return this.repository.transaction(s=>{const node=s.nodes.find(n=>n.id===nodeId)!;if(!node.approved||node.revoked)return {job:null};
    for(const job of s.jobs.filter(j=>j.nodeId===nodeId&&['queued','running'].includes(j.status))){if(Date.parse(job.deadlineAt)<Date.now()){job.status='failed';job.result={state:'failed',error:'実行期限を超過しました。'};const app=s.apps.find(a=>a.id===job.appId)!;app.error=job.result.error;continue;}
      if(job.status==='running'&&Date.parse(job.leaseUntil||'')>Date.now())continue;
      job.status='running';job.attempt++;job.lease=randomBytes(24).toString('hex');job.leaseUntil=new Date(Date.now()+45_000).toISOString();return {job};
    }return {job:null};
  });}
  renew(nodeId:string,jobId:string,lease:string){return this.repository.transaction(s=>{const job=s.jobs.find(j=>j.id===jobId&&j.nodeId===nodeId&&j.lease===lease&&j.status==='running');if(!job)throw new CloudError('実行権が失効しました。',409);job.leaseUntil=new Date(Date.now()+45000).toISOString();return {ok:true};});}
  finish(nodeId:string,jobId:string,lease:string,result:JobResult){return this.repository.transaction(s=>{const job=s.jobs.find(j=>j.id===jobId&&j.nodeId===nodeId);if(!job||job.lease!==lease)throw new CloudError('実行権が一致しません。',409);if(job.status==='succeeded'||job.status==='failed')return {ok:true};if(job.status!=='running')throw new CloudError('ジョブは実行中ではありません。',409);
    // Agentから任意の台帳書換えを受けず、結果の許可項目だけを採用します。
    const safe:JobResult={state:String(result.state).slice(0,100),...(typeof result.localUrl==='string'?{localUrl:result.localUrl}:{}),...(typeof result.publicUrl==='string'?{publicUrl:result.publicUrl}:{}),...(result.publication?{publication:result.publication}:{}),...(result.error?{error:String(result.error).slice(0,1000)}:{}),...(result.imageDigest?{imageDigest:result.imageDigest}:{}),...(typeof result.deploymentId==='string'?{deploymentId:result.deploymentId}:{})};
    job.result=safe;job.status=safe.error?'failed':'succeeded';const app=s.apps.find(a=>a.id===job.appId)!;Object.assign(app,safe);app.error=safe.error;if(!safe.error&&job.action==='deploy'){app.spec=job.spec;app.gpuIndex=job.gpuIndex;}if(!safe.error&&job.action==='rollback'){const previous=s.jobs.find(j=>j.id===safe.deploymentId&&j.appId===job.appId&&j.action==='deploy'&&j.status==='succeeded');if(previous){app.spec=previous.spec;app.gpuIndex=previous.gpuIndex;}}if(!safe.error&&job.action==='delete')app.desiredState='deleted';if(safe.error&&app.state!=='failed')app.state='degraded';audit(s,job.ownerId,'job.'+job.action,job.appId,job.status);return {ok:true};
  });}
}
