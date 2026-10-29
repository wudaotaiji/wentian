import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { withMaintenanceResources, MaintenanceResourcePause, resourceRetryDelay, type MaintenanceResourceState, type measureMaintenanceResources } from './maintenance-resources.js';
import { maintenanceControlStatus } from './maintenance-controls.js';
import { terminateProcessTree } from './external-orchestrator.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ModelPolicy=Record<'music'|'sound'|'transcribe'|'video',boolean>;
/** 初期状態では大容量取得を開始しません。許可は管理者設定として永続化します。 */
export function registerMediaModelMaintenance(app:FastifyInstance,authorize:(req:FastifyRequest,reply:FastifyReply)=>string|undefined,dependencies:{resources?:typeof measureMaintenanceResources}={}){
 const directory=process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT||path.join(process.env.WENTIAN_INSTALL_ROOT||process.cwd(),'.wentian','media-model-maintenance');
 const policyFile=path.join(directory,'policy.json'),statusFile=path.join(directory,'status.json');
 const defaults:ModelPolicy={music:false,sound:false,transcribe:false,video:false};let running:Promise<void>|undefined,child:ReturnType<typeof spawn>|undefined,timer:ReturnType<typeof setInterval>|undefined,closed=false;
 let unsafeProcess=false;
 let resourceFailures=0;
 let resourcePaused=false,resourceState:MaintenanceResourceState='normal';
 let controller=new AbortController();
 let retry:ReturnType<typeof setTimeout>|undefined;
 const policy=async()=>{try{return {...defaults,...JSON.parse(await readFile(policyFile,'utf8'))} as ModelPolicy}catch{return {...defaults}}};
 async function save(file:string,value:unknown){await mkdir(directory,{recursive:true});await writeFile(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});await renameWithRetry(file+'.tmp',file)}
 const status=async()=>{let result={};try{result=JSON.parse(await readFile(statusFile,'utf8'))}catch{/* 初回は台帳未作成です。 */}return {policy:await policy(),running:!!running,...result,resources:{state:resourceState},unsafeProcess,permission:maintenanceControlStatus().media}};
 async function sweep(force=false){if(closed||running||unsafeProcess||(resourcePaused&&retry)||!maintenanceControlStatus().media.allowed)return;running=(async()=>{const selected=await policy();if(!Object.values(selected).some(Boolean)||closed)return;
 // 準備済みのモデルは24時間以内に再検査せず、Daemon再起動のたびにPythonを起動しません。
 if(!force){try{const previous=JSON.parse(await readFile(statusFile,'utf8')) as {checkedAt?:string;models?:Record<string,{state?:string}>};if(previous.checkedAt&&Date.now()-Date.parse(previous.checkedAt)<86_400_000&&Object.entries(selected).every(([kind,enabled])=>!enabled||previous.models?.[kind]?.state==='ready'))return}catch{/* 台帳がない場合は通常の検査を行います。 */}}
 await withMaintenanceResources(async signal=>{
 await save(statusFile,{checkedAt:new Date().toISOString(),message:'モデルの取得・整合性確認中です。'});signal.throwIfAborted();await new Promise<void>((resolve,reject)=>{
   const python=process.env.WENTIAN_VIDEO_PYTHON||fileURLToPath(new URL('../.wentian/video-engine/'+(process.platform==='win32'?'Scripts/python.exe':'bin/python'),import.meta.url));
   const processChild=child=spawn(python,[fileURLToPath(new URL('../scripts/maintain-media-models.py',import.meta.url)),'--policy',policyFile],{windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',HF_HUB_OFFLINE:'0',TRANSFORMERS_OFFLINE:'0'}});
   let output='',termination:Promise<void>|undefined;
   // 親だけでなくダウンロード等の子孫も終了し、確認不能なら追加起動を禁止します。
   const abort=()=>{termination ||= (async()=>{
     try {if(processChild.pid){const result=await terminateProcessTree(processChild.pid);if(!result.verifiedStopped)unsafeProcess=true;}}
     catch {unsafeProcess=true;}
     if(unsafeProcess)reject(new Error('モデル保守の子プロセス停止を確認できません。追加起動を禁止しました。'));
   })();};
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   processChild.stdout?.on('data',data=>output=(output+data).slice(-65536));processChild.stderr?.resume();
   processChild.once('error',error=>{signal.removeEventListener('abort',abort);reject(error);});
   processChild.once('close',async code=>{
     signal.removeEventListener('abort',abort);
     try {
       await termination;signal.throwIfAborted();if(code!==0)throw new Error();
       const models=JSON.parse(output.trim().split('\n').at(-1)!);
       await save(statusFile,{checkedAt:new Date().toISOString(),models});resolve();
     }catch(error){reject(error);}
   });
 });},controller.signal,dependencies.resources,(state)=>{resourceState=state;resourcePaused=false;if(state==='warning')app.log.warn('資源使用率が80%以上です。');});resourceFailures=0;})().catch(async(error)=>{if(error instanceof MaintenanceResourcePause){resourcePaused=true;resourceFailures++;app.log.warn(error.message);await save(statusFile,{checkedAt:new Date().toISOString(),message:error.message});if(!closed&&!unsafeProcess){if(retry)clearTimeout(retry);retry=setTimeout(()=>{retry=undefined;void sweep();},resourceRetryDelay(resourceFailures));retry.unref();}return;}await save(statusFile,{checkedAt:new Date().toISOString(),message:'モデル保守を実行できませんでした。専用Python環境と通信を確認してください。次回再試行します。'})}).finally(()=>{running=undefined;child=undefined});await running;
 }
 app.addHook('onListen',async()=>{timer=setInterval(()=>void sweep(),30*60*1000);timer.unref();void sweep()});
 app.addHook('onClose',async()=>{closed=true;if(timer)clearInterval(timer);if(retry)clearTimeout(retry);controller.abort();await running});
 app.get('/api/media/models',async(req,reply)=>authorize(req,reply)?status():reply);
 app.put('/api/media/models',async(req,reply)=>{if(!authorize(req,reply))return reply;if(req.headers['x-team-virtual-key']||req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return reply.code(403).send({error:{message:'同一オリジンから操作してください。'}});if(running)return reply.code(409).send({error:{message:'取得・検査の終了後に設定を変更してください。'}});const body=req.body as Record<string,unknown>;if(!body||typeof body!=='object'||Object.keys(body).length!==4||Object.keys(defaults).some(k=>typeof body[k]!=='boolean'))return reply.code(400).send({error:{message:'対象モデルを指定してください。'}});await save(policyFile,body);void sweep(true);return reply.code(202).send(await status())});
 return {sweep,status,reloadMaintenanceControls:async()=>{
   if(closed)return;
   if(!maintenanceControlStatus().media.allowed){if(retry)clearTimeout(retry);retry=undefined;controller.abort();await running;}
   else {await running;controller=new AbortController();void sweep();}
 }};
}
