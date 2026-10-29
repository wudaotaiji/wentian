import { ImapFlow } from 'imapflow';
import { S3Client, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client } from 'pg';
import type { MailEntity, MailRepository } from './mail-repository.js';
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const secretCache=new Map<string,{value:string;mtime:number}>();
function secretFile(){return process.env.WENTIAN_MAIL_SECRET_FILE||path.join(process.env.WENTIAN_INSTALL_ROOT||process.cwd(),'.wentian','mail-secrets.json');}
export function mailSecretAvailable(name:string):boolean {if(process.env[name])return true;try{return Boolean(JSON.parse(readFileSync(secretFile(),'utf8'))[name]);}catch{return false;}}
export function mailKnownSecrets():string[]{return [...secretCache.values()].map(item=>item.value);}

/** 接続設定には環境変数名だけを保存し、認証情報の値をAPI（Application Programming Interface）へ返しません。 */
export function mailSecret(name:unknown,required=true):string {
  if(typeof name!=='string'||!/^WENTIAN_MAIL_[A-Z0-9_]{1,90}$/.test(name)){if(!required&&!name)return '';throw new Error('認証情報はWENTIAN_MAIL_から始まる環境変数名で指定してください。');}
  let value=process.env[name];
  if(!value&&process.platform==='win32'&&mailSecretAvailable(name)){
    const file=secretFile(),mtime=statSync(file).mtimeMs,cached=secretCache.get(name);
    if(cached?.mtime===mtime)value=cached.value;
    else{value=execFileSync(process.env.WENTIAN_MAIL_SECRET_PYTHON||'python',[fileURLToPath(new URL('../scripts/mail-secrets.py',import.meta.url)),'get','--name',name,'--file',file],{encoding:'utf8',windowsHide:true,timeout:10000,stdio:['ignore','pipe','pipe']});secretCache.set(name,{value,mtime});}
  }
  if(!value&&required)throw new Error(`認証情報 ${name} が未設定です。`);return value||'';
}
export function mailEndpoint(value:unknown):string {if(typeof value!=='string')throw new Error('接続URLを指定してください。');const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw new Error('認証情報・クエリーを含まないHTTP(S) URLを指定してください。');return url.href;}
export function imapClient(source:MailEntity):ImapFlow {
  const secret=mailSecret(source.secretEnv);
  return new ImapFlow({host:source.host,port:source.port,secure:source.tls==='implicit',...(source.tls==='starttls'?{doSTARTTLS:true}:{}),
    auth:{user:source.user,...(source.auth==='oauth2'?{accessToken:secret}:{pass:secret})},logger:false,disableAutoIdle:true,connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000});
}
export async function testImap(source:MailEntity){const client=imapClient(source);client.on('error',()=>{});try{await client.connect();return {folders:(await client.list()).map(item=>item.path)};}finally{await client.logout().catch(()=>client.close());}}

/** MinIO/S3は既存バケットだけを使い、テスト接続でバケットを作成・変更しません。 */
function s3(config:any){return new S3Client({endpoint:mailEndpoint(config.endpoint),region:config.region||'us-east-1',forcePathStyle:true,credentials:{accessKeyId:mailSecret(config.accessKeyEnv),secretAccessKey:mailSecret(config.secretKeyEnv)},maxAttempts:2});}
export async function testArchive(config:any){const client=s3(config);try{await client.send(new HeadBucketCommand({Bucket:config.bucket}),{abortSignal:AbortSignal.timeout(15000)});return {connected:true};}finally{client.destroy();}}
export async function archiveMail(config:any,key:string,raw:Buffer){const client=s3(config);try{await client.send(new PutObjectCommand({Bucket:config.bucket,Key:key,Body:raw,ContentType:'message/rfc822'}),{abortSignal:AbortSignal.timeout(30000)});}finally{client.destroy();}}

/** PostgreSQLは明示的な同期でローカル台帳を複製します。未設定時もSQLiteで業務を継続できます。 */
function postgres(config:any){return new Client({connectionString:mailSecret(config.connectionEnv),connectionTimeoutMillis:10000,statement_timeout:15000});}
export async function testPostgres(config:any){const client=postgres(config);try{await client.connect();await client.query('SELECT 1');return {connected:true};}finally{await client.end();}}
export async function mirrorPostgres(config:any,repository:MailRepository){
  // 時計の精度や時刻補正に依存せず、単調増加する変更番号で同一ミリ秒の更新も複製します。
  const cursor=repository.meta('postgres-cursor',0);
  const rows=repository.db.prepare('SELECT i.kind,i.id,i.updated,i.value,c.sequence FROM mail_items i JOIN (SELECT kind,id,MAX(sequence) sequence FROM mail_changes WHERE sequence>? GROUP BY kind,id) c ON i.kind=c.kind AND i.id=c.id ORDER BY c.sequence LIMIT 200').all(typeof cursor==='number'?cursor:0);
  const client=postgres(config);
  try {
    await client.connect();await client.query('BEGIN');
    await client.query('CREATE TABLE IF NOT EXISTS wentian_mail_records(kind TEXT NOT NULL,id TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL,data JSONB NOT NULL,PRIMARY KEY(kind,id))');
    for(const row of rows)await client.query('INSERT INTO wentian_mail_records VALUES($1,$2,$3,$4) ON CONFLICT(kind,id) DO UPDATE SET updated_at=EXCLUDED.updated_at,data=EXCLUDED.data WHERE wentian_mail_records.updated_at<=EXCLUDED.updated_at',[row.kind,row.id,row.updated,row.value]);
    await client.query('COMMIT');
    const last=rows.at(-1);if(last)repository.setMeta('postgres-cursor',Number(last.sequence));
    return {copied:rows.length,more:rows.length===200};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{await client.end();}
}

/** 登録先の契約は設定された項目対応と成功IDで検証し、通信断を成功や安全な再試行と決めつけません。 */
export async function sendSes(config:any,job:MailEntity):Promise<{remoteId:string}> {
  const endpoint=mailEndpoint(config.endpoints?.[job.profileKind]);
  const token=mailSecret(config.tokenEnv);
  const mapping=config.mapping?.[job.profileKind];
  if(!mapping||typeof mapping!=='object'||!Object.keys(mapping).length)throw new Error('BusinessRecordsの項目対応が未設定です。');
  const payload:Record<string,string>={};
  for(const [local,remote]of Object.entries(mapping)){if(typeof remote!=='string'||!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(remote))throw new Error('登録先項目名が不正です。');if(job.fields[local])payload[remote]=job.fields[local];}
  if(!Object.keys(payload).length)throw new Error('登録先へ送る項目がありません。');
  const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':job.id},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Object.assign(new Error(`登録先からHTTP ${response.status}が返りました。`),{definiteFailure:response.status>=400&&response.status<500&&![408,409,425,429].includes(response.status)});
  const text=await response.text();if(text.length>1000000)throw new Error('登録先の応答が大きすぎます。登録結果を照合してください。');
  const data=JSON.parse(text);let remote:any=data;for(const key of String(config.idPath||'id').split('.'))remote=remote?.[key];
  if(!['string','number'].includes(typeof remote)||String(remote).length>200||!String(remote))throw new Error('登録先のレコードIDが確認できません。登録結果を照合してください。');
  return {remoteId:String(remote)};
}
