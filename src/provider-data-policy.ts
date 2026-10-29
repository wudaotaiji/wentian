import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { machineConfigDirectory } from './agent-exclusion-policy.js';
import { atomicOrdinaryWrite, assertOrdinaryPath } from './safe-file.js';

export interface ProviderTransfer { provider:string; model:string; scope:'local'|'remote'; action:string }
interface DataPolicy {version:1; blocked:Record<string,boolean>}
export class ProviderDataDenied extends Error { readonly code='provider_data_blocked'; constructor(){super('このProviderへのデータ送信は管理者が停止しています。');} }
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id);
export function providerPolicyPath():string{return process.env.WENTIAN_PROVIDER_DATA_POLICY_FILE||path.join(machineConfigDirectory(),'provider-data-policy.json');}
export function providerAuditPath():string{return process.env.WENTIAN_PROVIDER_DATA_AUDIT_FILE||path.join(machineConfigDirectory(),'provider-data-audit.jsonl');}
function readPolicy():DataPolicy {
  if(!existsSync(providerPolicyPath()))return {version:1,blocked:{}};
  const value=JSON.parse(readFileSync(providerPolicyPath(),'utf8'));
  if(value?.version!==1||!value.blocked||Array.isArray(value.blocked)||typeof value.blocked!=='object'||Object.entries(value.blocked).some(([id,blocked])=>!validId(id)||typeof blocked!=='boolean'))throw new Error('Provider送信方針を確認できません。');
  return value;
}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function providerTargetDigest(provider:{id:string;baseUrl:string;scope:string}):string{return hash(JSON.stringify([provider.id,provider.baseUrl,provider.scope]));}
export function providerOrigin(url:string):string{try{return new URL(url).origin;}catch{return 'unknown';}}
async function audit(event:string,detail:Record<string,unknown>):Promise<void>{const file=providerAuditPath();await assertOrdinaryPath(file);await mkdir(path.dirname(file),{recursive:true});await appendFile(file,JSON.stringify({at:new Date().toISOString(),event,...detail})+'\n',{encoding:'utf8',mode:0o600});}
let writes=Promise.resolve();
const active=new Map<string,Set<AbortController>>();
/** 停止設定はProviderの接続先変更・再起動を越えて保持します。再開は現在の接続先確認を必要とします。 */
export async function setProviderDataBlocked(provider:{id:string;baseUrl:string;scope:string},blocked:boolean,expectedTarget:string,actor:string):Promise<void>{
  if(!validId(provider.id)||typeof blocked!=='boolean'||!actor||expectedTarget!==providerTargetDigest(provider))throw new Error('Provider送信方針の入力が不正です。');
  const work=async()=>{const file=providerPolicyPath(),lock=file+'.lock';await assertOrdinaryPath(lock);await mkdir(path.dirname(file),{recursive:true});const handle=await open(lock,'wx',0o600);
    try{const policy=readPolicy();policy.blocked[provider.id]=blocked;await audit('policy_requested',{provider:provider.id,blocked,actor,origin:providerOrigin(provider.baseUrl)});await atomicOrdinaryWrite(file,JSON.stringify(policy)+'\n');if(blocked)for(const controller of active.get(provider.id)||[])controller.abort(new ProviderDataDenied());}
    finally{await handle.close();await unlink(lock);}
  };
  const result=writes.then(work,work);writes=result.then(()=>{},()=>{});await result;
}
/** 本文・認証ヘッダー・URLクエリを保存せず、実際の送信直前で検査します。 */
export async function beginProviderTransfer(meta:ProviderTransfer,target:string,body:BodyInit|null|undefined):Promise<{signal:AbortSignal;finish:(ok:boolean,status?:number)=>Promise<void>}>{
  if(!validId(meta.provider))throw new ProviderDataDenied();
  let blocked=true;try{blocked=readPolicy().blocked[meta.provider]===true;}catch{/* 不正台帳では通信しません。 */}
  const bytes=typeof body==='string'?Buffer.from(body):body instanceof Uint8Array?body:body instanceof ArrayBuffer?new Uint8Array(body):undefined;
  // 中継側がサイズを観測できないストリームを、ゼロバイト送信として記録しません。
  if(body!=null&&!bytes)throw new Error('送信本文の形式を監査できません。');
  const detail={provider:meta.provider,model:meta.model.slice(0,256),scope:meta.scope,action:meta.action,origin:providerOrigin(target),inputBytes:bytes?.byteLength||0,bodyDigest:hash(bytes||new Uint8Array())};
  if(blocked){await audit('denied',detail);throw new ProviderDataDenied();}
  const executionId=randomUUID(),controller=new AbortController(),started=Date.now(),controllers=active.get(meta.provider)||new Set<AbortController>();let finished=false;
  controllers.add(controller);active.set(meta.provider,controllers);
  try{await audit('started',{...detail,executionId});}catch(error){controllers.delete(controller);if(!controllers.size)active.delete(meta.provider);throw error;}
  // 監査の保存待ちに取消された場合も、Fetchを起動する前に停止します。
  try{if(readPolicy().blocked[meta.provider])controller.abort(new ProviderDataDenied());}catch{controller.abort(new ProviderDataDenied());}
  const timer=setInterval(()=>{try{if(readPolicy().blocked[meta.provider])controller.abort(new ProviderDataDenied());}catch{controller.abort(new ProviderDataDenied());}},500);timer.unref();
  return {signal:controller.signal,finish:async(ok,status)=>{if(finished)return;finished=true;clearInterval(timer);controllers.delete(controller);if(!controllers.size)active.delete(meta.provider);await audit('finished',{provider:meta.provider,executionId,ok,status,aborted:controller.signal.aborted,durationMs:Date.now()-started});}};
}
/** 大きな監査台帳でも末尾だけを読み、管理画面のメモリー使用量を制限します。 */
function recentAudit():Record<string,unknown>[] {
  const file=providerAuditPath();if(!existsSync(file))return [];const size=statSync(file).size,start=Math.max(0,size-4*1024*1024),buffer=Buffer.alloc(size-start),handle=openSync(file,'r');
  try{readSync(handle,buffer,0,buffer.length,start);}finally{closeSync(handle);}
  const lines=buffer.toString('utf8').split('\n');if(start)lines.shift();
  return lines.filter(Boolean).slice(-2000).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
}
export function providerDataSummary(providers:Array<{id:string;baseUrl:string;scope:string;enabled?:boolean}>):unknown{
  const policy=readPolicy(),recent=recentAudit();
  return {providers:providers.map(provider=>({id:provider.id,origin:providerOrigin(provider.baseUrl),scope:provider.scope,configured:provider.enabled!==false,blocked:policy.blocked[provider.id]===true,targetDigest:providerTargetDigest(provider),active:active.get(provider.id)?.size||0})),recent:recent.slice(-50).reverse(),auditContainsContent:false};
}
