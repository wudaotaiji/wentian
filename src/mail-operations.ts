import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ImapFlow } from 'imapflow';
import { MailRepository, mailConflict, type MailEntity } from './mail-repository.js';
import { MailTrainingService } from './mail-training.js';
import type { MailCategory, MailProfileKind } from './mail-taxonomy.js';
import { redactTrainingText } from './training-data.js';
import { imapClient, testImap, testArchive, archiveMail, testPostgres, mirrorPostgres, sendSes, mailEndpoint, mailSecret, mailSecretAvailable, mailKnownSecrets } from './mail-connectors.js';
import { sendBusinessRecords, testBusinessRecords, businessRecord } from './mail-business-records.js';
import { mailSourceDiagnosis, type MailSourceDiagnoser } from './mail-source-diagnosis.js';

const maxMailBytes=20*1024*1024;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const text=(value:unknown,max:number,name:string)=>{if(typeof value!=='string'||value.length>max)throw new Error(`${name}は${max}文字以内で指定してください。`);return value.trim();};
const integer=(value:unknown,min:number,max:number,name:string)=>{const result=Number(value);if(!Number.isSafeInteger(result)||result<min||result>max)throw new Error(`${name}の範囲が不正です。`);return result;};
const secretRef=(value:unknown)=>{const name=text(value,110,'環境変数名');if(!/^WENTIAN_MAIL_[A-Z0-9_]{1,90}$/.test(name))throw new Error('認証情報はWENTIAN_MAIL_で始まる環境変数名を指定してください。');return name;};
export type MailCategoryProposer = (input: {subject:string;body:string;instruction:string;categories:MailCategory[]}) => Promise<{content:string;model:string}>;
const allowedFields=new Set(['name','title','skills','rate','availability','start_date','location','experience','age','headcount','period','description','contact','client','role','owner','type','status','deadline','cost','remote','priority']);
const fields=(value:unknown):Record<string,string>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('抽出項目を指定してください。');const result:Record<string,string>={};for(const [key,v]of Object.entries(value)){if(!allowedFields.has(key))throw new Error(`未定義の項目です: ${key}`);const s=text(v,300,key);if(s)result[key]=s;}return result;};
export function mailOperationError(error:unknown):string {let message=error instanceof Error?error.message:String(error);for(const [key,value]of Object.entries(process.env))if(key.startsWith('WENTIAN_MAIL_')&&value&&value.length>=6)message=message.split(value).join('[認証情報・設定値]');for(const value of mailKnownSecrets())if(value.length>=3)message=message.split(value).join('[認証情報]');return message.slice(0,1000);}
const initialSettings=()=>({revision:0,archive:{enabled:false,endpoint:'',bucket:'',region:'us-east-1',accessKeyEnv:'WENTIAN_MAIL_S3_ACCESS_KEY',secretKeyEnv:'WENTIAN_MAIL_S3_SECRET_KEY'},postgres:{enabled:false,connectionEnv:'WENTIAN_MAIL_POSTGRES_URL'},ses:{enabled:false,mode:'business-records',baseUrl:'http://127.0.0.1:8765/',username:'',passwordEnv:'WENTIAN_MAIL_SES_PASSWORD',endpoints:{personnel:'',project:''},tokenEnv:'WENTIAN_MAIL_SES_TOKEN',idPath:'id',mapping:{personnel:{name:'name',skills:'skills',rate:'rate',availability:'availability'} as Record<string,string>,project:{title:'title',skills:'skills',rate:'rate',start_date:'start_date'} as Record<string,string>}}});

/** 取り込み・人手確認・外部登録の状態を実データから管理します。 */
export class MailOperationsService {
  readonly repository:MailRepository;
  private busySources=new Set<string>();
  private diagnosing=new Map<string,Promise<any>>();
  private sending=new Set<string>();
  private closing=false;
  private pending=new Set<Promise<unknown>>();
  constructor(readonly directory=process.env.WENTIAN_MAIL_ROOT||path.join(process.env.WENTIAN_INSTALL_ROOT||process.cwd(),'.wentian','mail-operations'),readonly training=new MailTrainingService(),readonly dependencies:{imap?:(source:MailEntity)=>ImapFlow;archive?:typeof archiveMail;send?:typeof sendSes;propose?:MailCategoryProposer;diagnose?:MailSourceDiagnoser}={}){this.repository=new MailRepository(path.join(directory,'mail.sqlite'));}
  async saveCategory(input:any,actor:string){const item=await this.training.taxonomy.save(input);this.repository.audit(actor,'taxonomy.saved',item.path.join('/'),{name:item.name});return {category:item,...this.training.taxonomy.load()};}
  async proposeCategories(id:string,input:any,actor:string){
    const message=this.repository.require('message',id);
    if(!this.dependencies.propose)throw new Error('AI提案の接続が設定されていません。分類は手入力で追加できます。');
    const instruction=text(input?.instruction||'',2000,'分類の要望');
    const categories=this.training.taxonomy.load().categories;
    // メールは命令ではなく分類対象データです。匿名化した本文のみを推論へ渡します。
    const response=await this.dependencies.propose({subject:redactTrainingText(message.subject.slice(0,1000)),body:redactTrainingText(message.body.slice(0,12000)),instruction,categories});
    if(typeof response.content!=='string'||response.content.length>20000)throw new Error('AIの提案形式が不正です。');
    let payload:any;try{payload=JSON.parse(response.content.replace(/^\s*```(?:json)?\s*/i,'').replace(/\s*```\s*$/,''));}catch{throw new Error('AIから正しい分類提案を取得できませんでした。手入力で追加するか再試行してください。');}
    if(!Array.isArray(payload.suggestions)||!payload.suggestions.length||payload.suggestions.length>5)throw new Error('AIの分類候補は1〜5件必要です。');
    const suggestions=payload.suggestions.map((item:any)=>{
      if(!item||!['personnel','project','other'].includes(item.profileKind))throw new Error('AIの分類対象が不正です。');
      const name=text(item.name,200,'分類名'),reason=text(item.reason,1000,'提案理由');if(!name||!reason)throw new Error('AIの分類名と理由が不足しています。');
      const existing=item.labelPath?this.training.taxonomy.category(item.labelPath):undefined;
      if(existing&&existing.profileKind!==item.profileKind)throw new Error('AIの既存分類と抽出対象が一致しません。');
      return {name:existing?.name||name,profileKind:item.profileKind as MailProfileKind,reason,...(existing?{labelPath:existing.path}:{})};
    });
    this.repository.audit(actor,'taxonomy.proposed',id,{model:response.model,count:suggestions.length});
    return {suggestions,model:response.model,reviewRequired:true};
  }
  async classifyWithAI(id:string,input:any,actor:string){
    const message=this.repository.require('message',id),revision=integer(input?.revision,1,Number.MAX_SAFE_INTEGER,'世代番号');
    if(message.revision!==revision)throw mailConflict();
    if(!['pending','analyzed','reviewed'].includes(message.status))throw new Error('登録待ち・登録済みメールはAIで上書きできません。');
    const result=await this.proposeCategories(id,input,actor),proposal=result.suggestions[0];
    if(this.repository.require('message',id).revision!==revision)throw mailConflict();
    let item:MailCategory;
    if(proposal.labelPath)item=this.training.taxonomy.category(proposal.labelPath);
    else{
      const state=this.training.taxonomy.load();
      const existing=state.categories.find(item=>item.name===proposal.name&&item.profileKind===proposal.profileKind);
      item=existing||await this.training.taxonomy.save({revision:state.revision,name:proposal.name,profileKind:proposal.profileKind});
      if(!existing)this.repository.audit(actor,'taxonomy.ai-created',item.path.join('/'),{model:result.model});
    }
    // AIの先行判断を保存しますが、人による確認済みラベルには変換しません。
    return this.repository.transaction(()=>{const current=this.repository.require('message',id);if(current.revision!==revision)throw mailConflict();const saved=this.repository.put('message',{...current,labelPath:item.path,profileKind:item.profileKind,status:'analyzed',classificationModel:result.model,classificationReason:proposal.reason,classificationOrigin:'ai',score:null,reviewedBy:null,reviewedAt:null},undefined,revision);this.repository.audit(actor,'mail.ai-classified',id,{model:result.model,category:item.path});return saved;});
  }
  settings(){return this.repository.meta('settings',initialSettings());}
  saveSettings(input:any,actor:string){
    if(!input||typeof input!=='object')throw new Error('接続設定を指定してください。');
    const previous=this.settings();if(input.revision!==previous.revision)throw mailConflict();
    const next=structuredClone(initialSettings());next.revision=previous.revision+1;
    for(const name of ['archive','postgres','ses'] as const){if(typeof input[name]?.enabled!=='boolean')throw new Error('接続の有効状態を指定してください。');}
    const archive=input.archive;
    next.archive={enabled:archive.enabled,endpoint:archive.endpoint?mailEndpoint(archive.endpoint):'',bucket:text(archive.bucket||'',63,'バケット'),region:text(archive.region||'us-east-1',80,'リージョン'),accessKeyEnv:secretRef(archive.accessKeyEnv),secretKeyEnv:secretRef(archive.secretKeyEnv)};
    if(next.archive.enabled&&(!next.archive.endpoint||! /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(next.archive.bucket)))throw new Error('有効なMinIO接続先とバケットを設定してください。');
    next.postgres={enabled:input.postgres.enabled,connectionEnv:secretRef(input.postgres.connectionEnv)};
    const ses=input.ses;
    const mode=ses.mode||'business-records';if(!['business-records','http-api'].includes(mode))throw new Error('BusinessRecordsの接続方式が不正です。');
    next.ses={enabled:ses.enabled,mode,baseUrl:mailEndpoint(ses.baseUrl||'http://127.0.0.1:8765/'),username:text(ses.username||'',100,'BusinessRecordsアカウント'),passwordEnv:secretRef(ses.passwordEnv||'WENTIAN_MAIL_SES_PASSWORD'),endpoints:{personnel:ses.endpoints?.personnel?mailEndpoint(ses.endpoints.personnel):'',project:ses.endpoints?.project?mailEndpoint(ses.endpoints.project):''},tokenEnv:secretRef(ses.tokenEnv),idPath:text(ses.idPath||'id',100,'応答IDの項目'),mapping:{personnel:{},project:{}}};
    if(!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(next.ses.idPath))throw new Error('応答IDの項目パスが不正です。');
    for(const kind of ['personnel','project'] as const){const mapping=ses.mapping?.[kind];if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))throw new Error('登録先の項目対応を指定してください。');for(const [local,remote]of Object.entries(mapping)){if(!allowedFields.has(local)||typeof remote!=='string'||!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(remote))throw new Error('登録先の項目対応が不正です。');(next.ses.mapping[kind] as Record<string,string>)[local]=remote;}}
    if(next.ses.enabled&&mode==='http-api'&&(!next.ses.endpoints.personnel||!next.ses.endpoints.project))throw new Error('技術者と案件の登録URLを設定してください。');
    if(next.ses.enabled&&mode==='business-records'&&!next.ses.username)throw new Error('BusinessRecordsのアカウントを指定してください。');
    this.repository.transaction(()=>{this.repository.setMeta('settings',next);this.repository.setMeta('postgres-cursor',0);this.repository.setMeta('connection-tests',{});this.repository.audit(actor,'settings.saved','connections',{revision:next.revision});});return next;
  }
  sources():Array<MailEntity & {secretConfigured:boolean;diagnosis:ReturnType<typeof mailSourceDiagnosis>}>{return this.repository.list('source',100).map(source=>{
    const diagnosis=mailSourceDiagnosis({...source,lastError:mailOperationError(source.lastError||'')},Number(this.repository.db.prepare("SELECT count(*) total FROM mail_items WHERE kind='message' AND json_extract(value,'$.sourceId')=?").get(source.id)!.total));
    const saved=this.repository.meta('source-diagnosis:'+source.id,null);
    return {...source,secretConfigured:mailSecretAvailable(source.secretEnv),diagnosis,aiDiagnosis:saved?{...saved,stale:saved.fingerprint!==hash(JSON.stringify(diagnosis))}:null};
  });}
  async diagnoseSource(id:string,actor:string,cookie?:string,force=true):Promise<any>{
    const running=this.diagnosing.get(id);if(running)return running;
    const source=this.sources().find(item=>item.id===id);if(!source)throw new Error('メールソースが見つかりません。');
    if(!this.dependencies.diagnose)throw new Error('AI診断モデルが未設定です。');
    const fingerprint=hash(JSON.stringify(source.diagnosis)),key='source-diagnosis:'+id;
    const previous=this.repository.meta(key,null);
    if(!force&&previous?.fingerprint===fingerprint&&(previous.status==='ready'||Date.now()-Date.parse(previous.at)<15*60*1000))return previous;
    // 観測事実だけを渡し、本文・アカウント・ホスト・秘密情報を推論入力に含めません。
    this.repository.setMeta(key,{status:'running',fingerprint,at:new Date().toISOString()});
    const pending=(async()=>{try{
      const result=await this.dependencies.diagnose!(source.diagnosis,cookie);
      const saved={...result,status:'ready',at:new Date().toISOString(),revision:source.revision,fingerprint};
      this.repository.setMeta(key,saved);this.repository.audit(actor,'source.diagnosed',id,{model:result.model});return saved;
    }catch(error){const message=mailOperationError(error);this.repository.setMeta(key,{status:'failed',fingerprint,at:new Date().toISOString(),error:message});this.repository.audit(actor,'source.diagnosis.failed',id,{error:message});throw error;
    }finally{this.diagnosing.delete(id);}})();this.diagnosing.set(id,pending);return pending;
  }
  saveSource(input:any,actor:string){
    const id=input.id||randomUUID(),old=this.repository.get('source',id);
    if(old?.leaseUntil&&Date.parse(old.leaseUntil)>Date.now())throw new Error('このソースは同期中です。完了後に編集してください。');
    if(old&&input.revision!==old.revision)throw mailConflict();
    const type=input.type;if(type!=='imap'&&type!=='archive')throw new Error('ソース種別はimapまたはarchiveです。');
    const folders=type==='imap'?input.folders:[];
    if(!Array.isArray(folders)||folders.length>20||type==='imap'&&!folders.length)throw new Error('IMAPフォルダーを1〜20件指定してください。');
    const source={id,name:text(input.name,100,'ソース名'),type,host:type==='imap'?text(input.host,253,'ホスト'):'',port:type==='imap'?integer(input.port||993,1,65535,'ポート'):0,user:type==='imap'?text(input.user,250,'アカウント'):'',tls:input.tls||'implicit',auth:input.auth||'password',secretEnv:type==='imap'?secretRef(input.secretEnv):'',folders:folders.map(folder=>text(folder,250,'フォルダー')),enabled:input.enabled===true,intervalSeconds:integer(input.intervalSeconds||300,60,86400,'同期間隔'),batchSize:integer(input.batchSize||50,1,200,'バッチサイズ'),checkpoints:old?.checkpoints||{},status:old?.status||'idle',lastSync:old?.lastSync||null,lastError:null};
    if(!source.name||type==='imap'&&(!source.host||!source.user||!['implicit','starttls'].includes(source.tls)||!['password','oauth2'].includes(source.auth)))throw new Error('ソース名とIMAPの接続設定を指定してください。');
    if(old&&['type','host','port','user'].some(key=>old[key]!==source[key as keyof typeof source]))throw new Error('接続先やアカウントの変更は新しいソースとして登録してください。');
    return this.repository.transaction(()=>{const saved=this.repository.put('source',{...source,blockedMessage:old?.blockedMessage||null,lastAttempt:old?.lastAttempt||null},undefined,old?.revision??0);this.repository.audit(actor,'source.saved',id,{type});return saved;});
  }
  async testSource(id:string,actor:string){const source=this.repository.require('source',id);if(source.type!=='imap')return {connected:true,mode:'eml-upload'};try{const result=await testImap(source);this.repository.audit(actor,'source.tested',id,{connected:true});return result;}catch(error){this.repository.audit(actor,'source.tested',id,{connected:false,error:mailOperationError(error)});throw error;}}
  /** 本文を取得せず、停止メールの封筒情報（Envelope）だけを読取専用で照合します。 */
  async locateBlockedMail(id:string,actor:string){
    const source=this.repository.require('source',id),match=String(source.lastError||'').match(/UID (\d+)は20 MiBを超え/);
    if(!match&&!source.blockedMessage)throw new Error('特定できる停止メールがありません。');
    const uid=Number(source.blockedMessage?.uid||match![1]);
    // UIDはフォルダー内だけで一意です。過去の記録ではチェックポイント直後との一致を検証します。
    const folder=source.blockedMessage?.folder||source.folders.find((name:string)=>Number(source.checkpoints[name]?.backfill)+1===uid);
    if(!folder)throw new Error('停止フォルダーを特定できません。「同期」で停止情報を更新してください。');
    const expected=source.blockedMessage?.uidValidity||source.checkpoints[folder]?.validity;
    const client=(this.dependencies.imap||imapClient)(source);client.on('error',()=>{});
    try{await client.connect();const lock=await client.getMailboxLock(folder,{readOnly:true});try{
      if(!client.mailbox||String(client.mailbox.uidValidity)!==String(expected))throw new Error('フォルダーの識別情報が変わりました。古いUIDではメールを特定できません。');
      const item=await client.fetchOne(uid,{uid:true,size:true,envelope:true,internalDate:true},{uid:true});
      if(!item||item.uid!==uid)throw new Error('対象メールはこのフォルダーにありません。移動・削除された可能性があります。');
      const blocked=this.blockedMailInfo(folder,String(expected),item);
      return this.repository.transaction(()=>{const current=this.repository.require('source',id);if(current.revision!==source.revision)throw mailConflict();this.repository.put('source',{...current,blockedMessage:blocked},undefined,source.revision);this.repository.audit(actor,'source.blocked-mail-located',id,{folder,uid});return blocked;});
    }finally{lock.release();}}finally{await client.logout().catch(()=>client.close());}
  }
  private blockedMailInfo(folder:string,uidValidity:string,item:any){
    const envelope=item.envelope||{},date=(value:any)=>value instanceof Date?value.toISOString():typeof value==='string'?value:null;
    return {folder,uidValidity,uid:Number(item.uid),sizeBytes:Number(item.size||0),subject:String(envelope.subject||'（件名なし）').slice(0,1000),from:(envelope.from||[]).map((entry:any)=>({name:String(entry.name||'').slice(0,200),address:String(entry.address||'').slice(0,300)})),date:date(envelope.date),receivedAt:date(item.internalDate),messageId:String(envelope.messageId||'').slice(0,1000),locatedAt:new Date().toISOString()};
  }
  async ingest(sourceId:string,raw:Buffer,identity?:string,context:Record<string,any>={},actor='admin'){
    const source=this.repository.require('source',sourceId);
    if(!raw.length||raw.length>maxMailBytes)throw new Error('メール原本は1件20 MiB以内です。');
    const digest=hash(raw),key=identity||`${sourceId}:archive:${digest}`;
    const existing=this.repository.byIdentity('message',key);if(existing)return {message:existing,duplicate:true};
    const parsed=await simpleParser(raw,{skipHtmlToText:false,skipImageLinks:true,skipTextToHtml:true,maxHtmlLengthToParse:5*1024*1024});
    const subject=(parsed.subject||'（件名なし）').slice(0,1000),body=(parsed.text||'').slice(0,1000000);
    if(!body&&!parsed.attachments.length)throw new Error('本文も添付もないメールです。原本形式を確認してください。');
    const rawKey=`raw/${sourceId}/${digest}.eml`,destination=path.join(this.directory,rawKey);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,raw,{flag:'wx',mode:0o600}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const config=this.settings();if(config.archive.enabled)await (this.dependencies.archive||archiveMail)(config.archive,rawKey,raw);
    const threadId=hash(JSON.stringify([sourceId,(Array.isArray(parsed.references)?parsed.references[0]:parsed.references)||parsed.inReplyTo||parsed.messageId||digest]));
    return this.repository.transaction(()=>{const duplicate=this.repository.byIdentity('message',key);if(duplicate)return {message:duplicate,duplicate:true};const message=this.repository.put('message',{sourceId,sourceName:source.name,subject,sender:(parsed.from?.text||'').slice(0,2000),body,receivedAt:parsed.date?.toISOString()||new Date().toISOString(),messageId:parsed.messageId||'',threadId,duplicateGroupId:digest,rawKey,rawHash:digest,archive:config.archive.enabled?'s3':'local',attachments:parsed.attachments.map(a=>({filename:a.filename||'attachment',contentType:a.contentType,size:a.size})),status:'pending',profileKind:'other',labelPath:[],fields:{},score:null,...context},key);this.repository.audit(actor,'mail.imported',message.id,{sourceId});return {message,duplicate:false};});
  }
  messages(query:any={}){
    const limit=integer(query.limit||50,1,100,'表示件数'),offset=integer(query.offset||0,0,10000000,'表示位置'),q=text(query.q||'',300,'検索文字');
    const conditions=['kind=?'],values:any[]=['message'];
    if(q){conditions.push("(json_extract(value,'$.subject') LIKE ? ESCAPE '\\' OR json_extract(value,'$.sender') LIKE ? ESCAPE '\\' OR json_extract(value,'$.body') LIKE ? ESCAPE '\\')");const escaped='%'+q.replace(/[\\%_]/g,'\\$&')+'%';values.push(escaped,escaped,escaped);}
    if(query.filter==='review')conditions.push("json_extract(value,'$.status') IN ('pending','analyzed')");
    else if(query.filter==='personnel'||query.filter==='project'){conditions.push("json_extract(value,'$.profileKind')=?");values.push(query.filter);}
    if(query.sourceId){conditions.push("json_extract(value,'$.sourceId')=?");values.push(text(query.sourceId,100,'ソースID'));}
    const where=conditions.join(' AND '),total=Number(this.repository.db.prepare('SELECT count(*) AS count FROM mail_items WHERE '+where).get(...values)!.count);
    const items=this.repository.db.prepare('SELECT value FROM mail_items WHERE '+where+' ORDER BY updated DESC,id DESC LIMIT ? OFFSET ?').all(...values,limit,offset).map(row=>{const item=JSON.parse(String(row.value));delete item.body;return item;});
    return {items,total,limit,offset};
  }
  async analyze(id:string,revision:number,actor:string){
    const message=this.repository.require('message',id);if(message.revision!==revision)throw mailConflict();
    if(!['pending','analyzed'].includes(message.status))throw new Error('確認済みのメールは自動解析で上書きできません。');
    const status=await this.training.status(),warnings:string[]=[];
    if(!status.active.classification)throw new Error('分類モデルが未登録です。AI分類を利用するか、分類を人が確認してください。');
    const input={subject:message.subject.slice(0,1000),body:message.body.slice(0,19000)};
    if(message.body.length>19000)warnings.push('モデル入力は本文の先頭19000文字です。全文を確認してください。');
    const predicted=await this.training.predict('classification',input),item=this.training.taxonomy.category(predicted.label_path);
    const result={labelPath:item.path,score:predicted.score,classificationModel:predicted.model_run_id,profileKind:item.profileKind,fields:{} as Record<string,string>,extractionModel:''};
    if(result.profileKind!=='other'&&status.active.extraction){const predicted=await this.training.predict('extraction',{...input,kind:result.profileKind});result.fields=fields(Object.fromEntries(Object.entries(predicted.fields).map(([key,value])=>[key,(value as any).value])));result.extractionModel=predicted.model_run_id;}
    else warnings.push('抽出モデル未登録または対象外のため、項目を人が確認してください。');
    return this.repository.transaction(()=>{const current=this.repository.require('message',id);if(current.revision!==revision)throw mailConflict();const saved=this.repository.put('message',{...current,...result,warnings,status:'analyzed'},undefined,revision);this.repository.audit(actor,'mail.analyzed',id,{classificationModel:result.classificationModel,extractionModel:result.extractionModel});return saved;});
  }
  review(id:string,input:any,actor:string){
    const item=this.training.taxonomy.category(input.labelPath),labelPath=item.path,profileKind=input.profileKind;if(!['personnel','project','other'].includes(profileKind))throw new Error('抽出対象を指定してください。');
    if(profileKind!==item.profileKind)throw new Error('分類と抽出対象が一致していません。');
    const corrected=fields(input.fields);
    return this.repository.transaction(()=>{const current=this.repository.require('message',id);if(!['pending','analyzed','reviewed'].includes(current.status))throw new Error('登録待ち・登録済みのデータは直接変更できません。');const saved=this.repository.put('message',{...current,labelPath,profileKind,fields:corrected,status:'reviewed',reviewedBy:actor,reviewedAt:new Date().toISOString()},undefined,integer(input.revision,1,Number.MAX_SAFE_INTEGER,'世代番号'));this.repository.audit(actor,'mail.reviewed',id,{fields:Object.keys(corrected)});return saved;});
  }
  queue(id:string,input:any,actor:string){return this.repository.transaction(()=>{
    const message=this.repository.require('message',id);if(message.revision!==input.revision)throw mailConflict();
    if(message.status==='queued'||message.status==='registered')return {job:this.repository.require('outbox',message.outboxId),duplicate:true};
    if(message.status!=='reviewed'||!['personnel','project'].includes(message.profileKind))throw new Error('人が確認済みの技術者・案件だけ登録待ちにできます。');
    const required=message.profileKind==='personnel'?['name','skills']:['title','skills'];if(required.some(key=>!message.fields[key]))throw new Error('必須項目（氏名または案件名・スキル）を確認してください。');
    const fingerprint=hash(JSON.stringify([message.profileKind,Object.entries(message.fields).sort(([a],[b])=>a.localeCompare(b))]));
    const existing=this.repository.byIdentity('outbox',fingerprint);if(existing&&existing.status!=='cancelled'){this.repository.audit(actor,'registration.duplicate',id,{outboxId:existing.id});return {job:existing,duplicate:true};}
    const job=this.repository.put('outbox',{...(existing?{id:existing.id}:{}),mailId:id,profileKind:message.profileKind,fields:message.fields,status:'queued',fingerprint,attempts:0,approvedBy:actor},fingerprint);
    this.repository.put('message',{...message,status:'queued',outboxId:job.id},undefined,message.revision);this.repository.audit(actor,'registration.queued',job.id,{mailId:id});return {job,duplicate:false};
  });}
  outbox(){return this.repository.list('outbox',100).map(job=>job.status==='sending'&&Date.parse(job.updatedAt)<Date.now()-90000?this.repository.transaction(()=>this.repository.put('outbox',{...this.repository.require('outbox',job.id),status:'unknown',error:'送信処理が中断されました。登録先の結果を照合してください。'})):job);}
  async dispatch(id:string,revision:number,actor:string){
    const config=this.settings().ses;if(!config.enabled)throw new Error('BusinessRecords接続を設定・有効化してください。');
    // 通信前の設定不備は送信状態へ移さず、安全に修正できるようにします。
    const candidate=this.repository.require('outbox',id);
    if(config.mode==='business-records'){businessRecord(candidate);mailEndpoint(config.baseUrl);mailSecret(config.passwordEnv);}
    else{mailEndpoint(config.endpoints[candidate.profileKind]);mailSecret(config.tokenEnv);if(!Object.keys(config.mapping[candidate.profileKind]||{}).length)throw new Error('登録先の項目対応を指定してください。');}
    if(this.sending.has(id))throw new Error('このデータは送信中です。');
    const job=this.repository.transaction(()=>{const current=this.repository.require('outbox',id);if(current.revision!==revision)throw mailConflict();if(!['queued','failed'].includes(current.status))throw new Error('送信済み・結果不明のデータは再送できません。');const saved=this.repository.put('outbox',{...current,status:'sending',attempts:current.attempts+1},undefined,revision);this.repository.audit(actor,'registration.sending',id);return saved;});
    this.sending.add(id);
    try {const result=await (this.dependencies.send||(config.mode==='business-records'?sendBusinessRecords:sendSes))(config,job);return this.repository.transaction(()=>{const current=this.repository.require('outbox',id);const saved=this.repository.put('outbox',{...current,status:'registered',remoteId:result.remoteId,error:null},undefined,job.revision);const message=this.repository.require('message',job.mailId);this.repository.put('message',{...message,status:'registered',remoteId:result.remoteId});this.repository.audit(actor,'registration.completed',id,{remoteId:result.remoteId});return saved;});}
    catch(error){return this.repository.transaction(()=>{const current=this.repository.require('outbox',id);if(current.revision!==job.revision)throw mailConflict();const saved=this.repository.put('outbox',{...current,status:(error as any).definiteFailure?'failed':'unknown',error:mailOperationError(error)});this.repository.audit(actor,'registration.failed',id,{status:saved.status,error:saved.error});return saved;});}
    finally{this.sending.delete(id);}
  }
  resolve(id:string,input:any,actor:string){return this.repository.transaction(()=>{const job=this.repository.require('outbox',id);if(job.revision!==input.revision)throw mailConflict();if(job.status!=='unknown'||input.confirmation!==id)throw new Error('結果不明の登録をID確認付きで照合してください。');if(input.outcome!=='registered'&&input.outcome!=='not_registered')throw new Error('照合結果を指定してください。');const remoteId=input.outcome==='registered'?text(input.remoteId,200,'登録先ID'):'';if(input.outcome==='registered'&&!remoteId)throw new Error('登録先のレコードIDが必要です。');const saved=this.repository.put('outbox',{...job,status:input.outcome==='registered'?'registered':'queued',remoteId,error:null});if(remoteId){const message=this.repository.require('message',job.mailId);this.repository.put('message',{...message,status:'registered',remoteId});}this.repository.audit(actor,'registration.reconciled',id,{outcome:input.outcome,remoteId});return saved;});}
  cancel(id:string,revision:number,actor:string){return this.repository.transaction(()=>{const job=this.repository.require('outbox',id);if(job.revision!==revision)throw mailConflict();if(!['queued','failed'].includes(job.status))throw new Error('送信中・登録済み・結果不明のデータは取り消せません。');const saved=this.repository.put('outbox',{...job,status:'cancelled'});const message=this.repository.require('message',job.mailId);this.repository.put('message',{...message,status:'reviewed',outboxId:null});this.repository.audit(actor,'registration.cancelled',id);return saved;});}
  async trainingExample(id:string,task:'classification'|'extraction',actor:string){const message=this.repository.require('message',id);if(!message.reviewedBy)throw new Error('人が確認したメールだけ学習例にできます。');const common={mail_id:message.id,thread_id:message.threadId,duplicate_group_id:message.duplicateGroupId,subject:message.subject,body:message.body.slice(0,19000),reviewed:true};
    // 担当者などメールにない業務項目を抽出の教師値に混ぜず、本文に存在する確認済み値だけを使います。
    const present=Object.fromEntries(Object.entries(message.fields).filter(([,value])=>(common.subject+'\n'+common.body).includes(String(value))));
    const example=task==='classification'?{...common,label_path:message.labelPath}:{...common,kind:message.profileKind,fields:present};const result=await this.training.importExamples(task,[example]);this.repository.audit(actor,'training.example',id,{task,fields:task==='extraction'?Object.keys(present):[]});return {...result,excludedFields:task==='extraction'?Object.keys(message.fields).filter(key=>!(key in present)):[]};}
  async download(id:string,index?:number){const message=this.repository.require('message',id);const raw=await readFile(path.join(this.directory,message.rawKey));if(index===undefined)return {bytes:raw,name:message.id+'.eml'};const parsed=await simpleParser(raw);const attachment=parsed.attachments[index];if(!attachment)throw new Error('添付ファイルがありません。');return {bytes:attachment.content,name:attachment.filename||'attachment'};}
  async connectionTest(kind:string,actor:string){const settings=this.settings();let result:unknown;
    try {if(kind==='archive')result=await testArchive(settings.archive);else if(kind==='postgres')result=await testPostgres(settings.postgres);else if(kind==='ses'){if(settings.ses.mode==='business-records')result=await testBusinessRecords(settings.ses);else{mailSecret(settings.ses.tokenEnv);for(const endpoint of Object.values(settings.ses.endpoints))mailEndpoint(endpoint);result={configured:true,connected:false,message:'設定形式を確認しました。実接続は登録時の応答で確認します。'};}}else throw new Error('接続先が不正です。');const tests=this.repository.meta('connection-tests',{});tests[kind]={at:new Date().toISOString(),ok:true,result};this.repository.setMeta('connection-tests',tests);this.repository.audit(actor,'connection.tested',kind,{ok:true});return tests[kind];}
    catch(error){const tests=this.repository.meta('connection-tests',{});tests[kind]={at:new Date().toISOString(),ok:false,error:mailOperationError(error)};this.repository.setMeta('connection-tests',tests);throw error;}
  }
  async mirror(actor:string){const config=this.settings().postgres;if(!config.enabled)throw new Error('PostgreSQL接続を有効化してください。');const result=await mirrorPostgres(config,this.repository);this.repository.audit(actor,'postgres.mirrored','postgres',result);return result;}
  async syncSource(id:string,actor:string,requestedMode?:string){
    if(this.closing)throw new Error('停止処理中です。');
    if(this.busySources.has(id))throw new Error('このソースは同期中です。');
    const source=this.repository.transaction(()=>{const current=this.repository.require('source',id);if(current.type!=='imap')throw new Error('アーカイブソースはEMLファイルを取り込んでください。');if(current.leaseUntil&&Date.parse(current.leaseUntil)>Date.now())throw new Error('このソースは別プロセスで同期中です。');return this.repository.put('source',{...current,status:'syncing',lastAttempt:new Date().toISOString(),leaseUntil:new Date(Date.now()+600000).toISOString(),lastError:null});});
    this.busySources.add(id);let client:ImapFlow|undefined,imported=0;
    try {
      client=(this.dependencies.imap||imapClient)(source);client.on('error',()=>{});
      await client.connect();
      for(const folder of source.folders){if(this.closing)break;const lock=await client.getMailboxLock(folder,{readOnly:true});
        try {if(!client.mailbox)throw new Error('フォルダーを開けません。');const validity=String(client.mailbox.uidValidity),maxUid=Number(client.mailbox.uidNext)-1;
          let checkpoint=source.checkpoints[folder];if(!checkpoint||checkpoint.validity!==validity)checkpoint={validity,backfill:0,target:maxUid,incremental:maxUid};
          const mode=requestedMode==='incremental'?'incremental':checkpoint.backfill<checkpoint.target?'backfill':'incremental';
          const start=Number(checkpoint[mode])+1,end=Math.min(mode==='backfill'?checkpoint.target:maxUid,start+source.batchSize-1);
          // UIDの固定幅で取得し、大量履歴を全件メモリへ読み込まずに再開可能にします。
          if(start<=end){const metadata=await client.fetchAll(`${start}:${end}`,{uid:true,size:true,envelope:true,internalDate:true},{uid:true});
            for(const item of metadata.sort((a,b)=>a.uid-b.uid)){if(item.uid<start||item.uid>end)continue;if(Number(item.size||0)>maxMailBytes){
              // 停止前に件名・送信者・日時を保存し、利用者が対象メールを検索できるようにします。
              const blockedMessage=this.blockedMailInfo(folder,validity,item);
              this.repository.transaction(()=>{const current=this.repository.require('source',id);this.repository.put('source',{...current,blockedMessage});});
              throw new Error(`UID ${item.uid}は20 MiBを超えます。同期を保留しました。`);
            }
              const fetched=await client.fetchOne(item.uid,{source:true,uid:true},{uid:true});if(!fetched||!fetched.source)throw new Error(`UID ${item.uid}の原文取得に失敗しました。`);
              const result=await this.ingest(id,fetched.source,`${id}:${folder}:${validity}:${item.uid}`,{folder,uid:item.uid,uidValidity:validity},actor);if(!result.duplicate)imported++;
              if(source.blockedMessage?.folder===folder&&source.blockedMessage?.uid===item.uid){source.blockedMessage=null;this.repository.transaction(()=>{const current=this.repository.require('source',id);this.repository.put('source',{...current,blockedMessage:null});});}
              checkpoint[mode]=item.uid;source.checkpoints[folder]=checkpoint;this.repository.transaction(()=>{const current=this.repository.require('source',id);this.repository.put('source',{...current,checkpoints:source.checkpoints,leaseUntil:new Date(Date.now()+600000).toISOString()});});
            }
            checkpoint[mode]=end;
          }
          source.checkpoints[folder]=checkpoint;
          this.repository.transaction(()=>{const current=this.repository.require('source',id);this.repository.put('source',{...current,checkpoints:source.checkpoints});});
        }finally{lock.release();}
      }
      this.repository.transaction(()=>{const current=this.repository.require('source',id);this.repository.put('source',{...current,status:'idle',leaseUntil:null,lastSync:new Date().toISOString(),lastError:null});this.repository.audit(actor,'source.synced',id,{imported});});return {imported,checkpoints:source.checkpoints};
    }catch(error){this.repository.transaction(()=>{const current=this.repository.require('source',id);this.repository.put('source',{...current,status:'error',leaseUntil:null,lastError:mailOperationError(error)});this.repository.audit(actor,'source.failed',id,{error:mailOperationError(error)});});throw error;}
    finally{if(client)await client.logout().catch(()=>client?.close());this.busySources.delete(id);}
  }
  track<T>(promise:Promise<T>):Promise<T>{this.pending.add(promise);promise.finally(()=>this.pending.delete(promise)).catch(()=>{});return promise;}
  async tick(){if(this.closing)return;
    // 人が確認して保存したメールだけを分類用の正解例へ登録し、11件以降は常駐サーバーで学習します。
    const imported=this.repository.meta('classification-training-reviewedAt',{}),candidates=this.repository.db.prepare("SELECT value FROM mail_items WHERE kind='message' AND json_extract(value,'$.status')='reviewed' AND json_extract(value,'$.reviewedBy') IS NOT NULL ORDER BY updated LIMIT 500").all();
    for(const row of candidates){if(this.closing)break;const message=JSON.parse(String(row.value));if(imported[message.id]===message.reviewedAt)continue;
      try{await this.trainingExample(message.id,'classification','background-training');this.repository.transaction(()=>{const latest=this.repository.require('message',message.id);if(latest.reviewedAt===message.reviewedAt){this.repository.setMeta('classification-training-reviewedAt',{...imported,[message.id]:message.reviewedAt});imported[message.id]=message.reviewedAt;}});}catch(error){this.repository.audit('background-training','training.example.failed',message.id,{error:mailOperationError(error)});imported[message.id]=message.reviewedAt;this.repository.setMeta('classification-training-reviewedAt',imported);}}
    if(!this.closing){const training=await this.training.status(),runs=training.runs.filter((run:any)=>run.task==='classification'),latest=runs[0];if(training.examples.classification>=11&&!training.running&&(!latest||latest.datasetHash!==training.datasetHashes.classification))await this.training.start('classification').catch(error=>this.repository.audit('background-training','training.start.failed','classification',{error:mailOperationError(error)}));}
    for(const source of this.sources()){if(this.closing)break;const previous=source.lastAttempt||source.lastSync;if(source.enabled&&source.type==='imap'&&!this.busySources.has(source.id)&&(!previous||Date.parse(previous)<Date.now()-source.intervalSeconds*1000))await this.track(this.syncSource(source.id,'scheduler')).catch(()=>{});
      // 障害の観測事実が変わった場合だけ再分析し、同じ結果を画面へ保存して再利用します。
      const current=this.repository.require('source',source.id);if(this.dependencies.diagnose&&(current.lastError||current.blockedMessage))await this.track(this.diagnoseSource(source.id,'scheduler',undefined,false)).catch(()=>{});
    }}
  async status(){const counts=this.repository.db.prepare("SELECT count(*) total,sum(json_extract(value,'$.status') IN ('pending','analyzed')) pending,sum(json_extract(value,'$.profileKind')='personnel') personnel,sum(json_extract(value,'$.profileKind')='project') project,sum(json_extract(value,'$.status')='registered') registered FROM mail_items WHERE kind='message'").get()!;this.outbox();const queued=Number(this.repository.db.prepare("SELECT count(*) count FROM mail_items WHERE kind='outbox' AND json_extract(value,'$.status')='queued'").get()!.count),taxonomy=this.training.taxonomy.load();return {counts:Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,Number(value)||0])),queued,sources:this.sources(),settings:this.settings(),connections:this.repository.meta('connection-tests',{}),training:await this.training.status(),taxonomy:taxonomy.categories.map(item=>item.path),categories:taxonomy.categories,taxonomyRevision:taxonomy.revision,storage:'SQLite + 原文ファイル'};}
  async close(){this.closing=true;await Promise.allSettled([...this.pending]);this.repository.close();}
}

/** 管理者認証と同一オリジン（Origin）検証を全操作へ適用します。 */
export function registerMailOperations(app:FastifyInstance,authorize:(req:FastifyRequest,reply:FastifyReply)=>boolean,service=new MailOperationsService(),actor:(req:FastifyRequest)=>string=()=> 'admin'){
  app.register(async routes=>{
    routes.addHook('preHandler',async(req,reply)=>{if(!authorize(req,reply))return reply;if(req.headers['x-team-virtual-key']||req.method!=='GET'&&req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return reply.code(403).send({error:{message:'同じサイトの管理者だけが操作できます。'}});});
    routes.setErrorHandler((error,_req,reply)=>reply.code([404,409].includes(Number((error as any).statusCode))?Number((error as any).statusCode):400).send({error:{message:mailOperationError(error)}}));
    const id=(req:FastifyRequest)=>text((req.params as any).id,100,'データID');
    routes.get('/api/mail-operations',()=>service.status());
    routes.post('/api/mail-operations/taxonomy',req=>service.track(service.saveCategory(req.body,actor(req))));
    routes.post('/api/mail-operations/messages/:id/category-proposals',req=>service.track(service.proposeCategories(id(req),req.body,actor(req))));
    routes.post('/api/mail-operations/messages/:id/ai-classify',req=>service.track(service.classifyWithAI(id(req),req.body,actor(req))));
    routes.get('/api/mail-operations/messages',req=>service.messages(req.query));
    routes.get('/api/mail-operations/messages/:id',req=>service.repository.require('message',id(req)));
    routes.post('/api/mail-operations/sources',req=>service.saveSource(req.body,actor(req)));
    routes.post('/api/mail-operations/sources/:id/test',req=>service.track(service.testSource(id(req),actor(req))));
    routes.post('/api/mail-operations/sources/:id/diagnose',req=>service.track(service.diagnoseSource(id(req),actor(req),req.headers.cookie)));
    routes.post('/api/mail-operations/sources/:id/blocked-mail',req=>service.track(service.locateBlockedMail(id(req),actor(req))));
    routes.post('/api/mail-operations/sources/:id/sync',req=>service.track(service.syncSource(id(req),actor(req),(req.body as any)?.mode)));
    routes.post('/api/mail-operations/import',{bodyLimit:30*1024*1024},async req=>{const body=req.body as any;const encoded=text(body.raw,Math.ceil(maxMailBytes*4/3)+4,'EML原本');if(!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('原本はBase64形式で指定してください。');const result=await service.ingest(text(body.sourceId,100,'ソースID'),Buffer.from(encoded,'base64'),undefined,{},actor(req));return {id:result.message.id,duplicate:result.duplicate};});
    routes.post('/api/mail-operations/messages/:id/analyze',req=>service.track(service.analyze(id(req),integer((req.body as any)?.revision,1,Number.MAX_SAFE_INTEGER,'世代番号'),actor(req))));
    routes.post('/api/mail-operations/messages/:id/review',req=>service.review(id(req),req.body,actor(req)));
    routes.post('/api/mail-operations/messages/:id/queue',req=>service.queue(id(req),req.body,actor(req)));
    routes.post('/api/mail-operations/messages/:id/training',req=>{const task=(req.body as any)?.task;if(task!=='classification'&&task!=='extraction')throw new Error('学習対象を指定してください。');return service.track(service.trainingExample(id(req),task,actor(req)));});
    routes.get('/api/mail-operations/messages/:id/raw',async(req,reply)=>{const result=await service.download(id(req));return reply.header('content-disposition',`attachment; filename="${result.name}"`).type('application/octet-stream').send(result.bytes);});
    routes.get('/api/mail-operations/messages/:id/attachments/:index',async(req,reply)=>{const result=await service.download(id(req),integer((req.params as any).index,0,1000,'添付番号'));return reply.header('content-security-policy','sandbox').header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`).type('application/octet-stream').send(result.bytes);});
    routes.get('/api/mail-operations/outbox',()=>({items:service.outbox()}));
    routes.post('/api/mail-operations/outbox/:id/send',req=>service.track(service.dispatch(id(req),integer((req.body as any)?.revision,1,Number.MAX_SAFE_INTEGER,'世代番号'),actor(req))));
    routes.post('/api/mail-operations/outbox/:id/resolve',req=>service.resolve(id(req),req.body,actor(req)));
    routes.post('/api/mail-operations/outbox/:id/cancel',req=>service.cancel(id(req),integer((req.body as any)?.revision,1,Number.MAX_SAFE_INTEGER,'世代番号'),actor(req)));
    routes.get('/api/mail-operations/events',()=>({items:service.repository.events()}));
    routes.post('/api/mail-operations/settings',req=>service.saveSettings(req.body,actor(req)));
    routes.post('/api/mail-operations/connections/:id/test',req=>service.track(service.connectionTest(id(req),actor(req))));
    routes.post('/api/mail-operations/postgres/sync',req=>service.track(service.mirror(actor(req))));
  });
  let timer:ReturnType<typeof setInterval>|undefined,running=false;
  app.addHook('onListen',async()=>{timer=setInterval(()=>{if(running)return;running=true;service.track(service.tick()).finally(()=>{running=false;}).catch(()=>{});},30000);timer.unref();});
  app.addHook('onClose',async()=>{if(timer)clearInterval(timer);await service.close();});return service;
}
