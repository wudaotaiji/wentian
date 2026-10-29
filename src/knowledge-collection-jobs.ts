import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertOrdinaryPath } from './safe-file.js';
import { collectProjectUrls, type KnowledgePageReader } from './knowledge-url-collector.js';
import { ProjectKnowledgeStore, validateProjectId, validateSourceUrl } from './project-knowledge.js';

export interface KnowledgeCollectionJob {
  id: string; projectId: string; ownerId: string;
  input: {url:string;followLinks:boolean;maxPages:number;profileId?:string;render?:boolean};
  mode: 'once'|'continuous'|'sync'; intervalMs: number;
  status: 'queued'|'running'|'paused'|'completed'|'failed'; nextRunAt: number;
  pending: string[]; seen: string[]; origin?: string;
  runs: number; documents: number; failures: number; warnings: number;
  lastError?: string; updatedAt: string;
}

/** 継続クロールと定期同期を、有限のバッチと再開可能な状態で実行します。 */
export class KnowledgeCollectionJobs {
  private db!: DatabaseSync;
  private timer?: ReturnType<typeof setInterval>;
  private current?: {id:string;controller:AbortController;done:Promise<void>};
  private closed=false;
  private constructor(readonly root:string,private store:ProjectKnowledgeStore,private permitted:(project:string,owner:string)=>Promise<boolean>,private read?:KnowledgePageReader) {}

  static async open(root:string,store:ProjectKnowledgeStore,permitted:(project:string,owner:string)=>Promise<boolean>,read?:KnowledgePageReader) {
    const service=new KnowledgeCollectionJobs(path.resolve(root),store,permitted,read);
    await assertOrdinaryPath(service.root);await mkdir(service.root,{recursive:true,mode:0o700});
    const lock=path.join(service.root,'worker.lock');await assertOrdinaryPath(lock);
    try{await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600})}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const pid=Number(await readFile(lock,'utf8'));let alive=true;
      try{process.kill(pid,0)}catch(e){alive=(e as NodeJS.ErrnoException).code!=='ESRCH'}
      if(!Number.isSafeInteger(pid)||pid<=0||alive)throw new Error('別の収集ワーカーが稼働しています。');
      await unlink(lock);await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});
    }
    try{
      await assertOrdinaryPath(path.join(service.root,'jobs.sqlite'));
      service.db=new DatabaseSync(path.join(service.root,'jobs.sqlite'));
      service.db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project TEXT NOT NULL, body TEXT NOT NULL)');
      for(const job of service.all())if(job.status==='running'){job.status='queued';job.lastError='再起動後に保存済みの続きから再開します。';service.save(job)}
      return service;
    }catch(error){service.db?.close();await unlink(lock);throw error}
  }
  private all():KnowledgeCollectionJob[]{return this.db.prepare('SELECT body FROM jobs').all().map(row=>JSON.parse(String(row.body)))}
  private save(job:KnowledgeCollectionJob){job.updatedAt=new Date().toISOString();this.db.prepare('INSERT INTO jobs(id,project,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(job.id,job.projectId,JSON.stringify(job))}
  list(projectId:string){return this.all().filter(j=>j.projectId===projectId).map(({pending,seen,...job})=>({...job,pendingCount:pending.length,visitedCount:seen.length}))}
  create(projectId:string,ownerId:string,input:any):KnowledgeCollectionJob{
    validateProjectId(projectId);
    if(!ownerId||!input||Object.keys(input).some(k=>!['url','followLinks','maxPages','profileId','render','mode','intervalMs'].includes(k))||!['once','continuous','sync'].includes(input.mode)||typeof input.followLinks!=='boolean'||(input.render!==undefined&&typeof input.render!=='boolean')||(input.profileId!==undefined&&typeof input.profileId!=='string'))throw new Error('収集ジョブの入力が不正です。');
    const intervalMs=input.intervalMs??60000,maxPages=input.maxPages??5;
    if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>365*86400000||!Number.isInteger(maxPages)||maxPages<1||maxPages>10)throw new Error('実行間隔は1秒〜365日、バッチは1〜10ページで指定してください。');
    const url=validateSourceUrl(input.url);
    const job:KnowledgeCollectionJob={id:randomUUID(),projectId,ownerId,input:{url,followLinks:input.followLinks,maxPages,...(input.profileId?{profileId:input.profileId}:{}),...(input.render!==undefined?{render:input.render}:{})},mode:input.mode,intervalMs,status:'queued',nextRunAt:Date.now(),pending:[url],seen:[],runs:0,documents:0,failures:0,warnings:0,updatedAt:new Date().toISOString()};
    this.save(job);return job;
  }
  action(project:string,id:string,action:'pause'|'resume'|'delete'){
    const job=this.all().find(j=>j.projectId===project&&j.id===id);if(!job)throw new Error('収集ジョブが見つかりません。');
    if(action==='delete'){this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);if(this.current?.id===id)this.current.controller.abort();return}
    job.status=action==='pause'?'paused':'queued';job.nextRunAt=Date.now();if(action==='resume'&&!job.pending.length){job.pending=[job.input.url];job.seen=[]}this.save(job);
    if(action==='pause'&&this.current?.id===id)this.current.controller.abort();
  }
  /** 同一プロジェクトの権限を毎バッチ・各取得前・保存前に再評価します。 */
  async tick(now=Date.now()):Promise<void>{
    if(this.closed||this.current)return;
    const job=this.all().find(j=>j.status==='queued'&&j.nextRunAt<=now);if(!job)return;
    job.status='running';this.save(job);const controller=new AbortController();
    const done=this.perform(job,controller,now);this.current={id:job.id,controller,done};
    try{await done}finally{this.current=undefined}
  }
  private async perform(job:KnowledgeCollectionJob,controller:AbortController,now:number){
    try{
      const result=await collectProjectUrls(this.store,job.projectId,job.input,()=>this.permitted(job.projectId,job.ownerId),this.read,{pending:job.pending,seen:job.seen,origin:job.origin,signal:controller.signal});
      const current=this.all().find(j=>j.id===job.id);if(!current)return;
      current.pending=result.pending;current.seen=result.seen;current.origin=result.origin;current.runs++;current.documents+=result.documents.length;current.failures+=result.errors.length;current.warnings+=result.warnings.length;
      current.lastError=result.errors.length?result.errors[0].message:result.warnings.length?result.warnings[0].message:undefined;
      if(result.errors.some(error=>error.code==='auth_required')){current.status='paused';current.lastError='収集先の認証が失効しました。ログイン状態を更新し、このジョブを再開してください。'}
      else if(current.status==='paused'||controller.signal.aborted){current.status=current.status==='queued'||this.closed&&current.status!=='paused'?'queued':'paused'}
      else if(result.pending.length){current.status='queued';current.nextRunAt=Math.max(now,Date.now())+current.intervalMs}
      else if(current.mode!=='once'){current.status='queued';current.pending=[current.input.url];current.seen=[];current.nextRunAt=Math.max(now,Date.now())+current.intervalMs}
      else current.status=result.errors.length||result.warnings.length?'failed':'completed';
      this.save(current);
    }catch{
      const current=this.all().find(j=>j.id===job.id);if(!current)return;
      current.status=controller.signal.aborted?(this.closed&&current.status!=='paused'?'queued':'paused'):'failed';current.lastError='収集を継続できません。権限・接続設定を確認して再開してください。';current.failures++;this.save(current);
    }
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.tick().catch(()=>undefined)},1000);this.timer.unref()}
  async close(){this.closed=true;if(this.timer)clearInterval(this.timer);if(this.current){this.current.controller.abort();await this.current.done}this.db.close();await unlink(path.join(this.root,'worker.lock'))}
}
