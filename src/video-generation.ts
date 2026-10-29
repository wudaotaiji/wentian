import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, lstat, realpath, open, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';

export class VideoError extends Error { constructor(message:string,readonly statusCode=400){super(message)} }
export interface VideoInput {prompt:string;negativePrompt:string;width:number;height:number;frames:number;fps:number;steps:number;seed:number;image?:string;audioJobId?:string;audioVolume?:number}
export interface VideoJob {id:string;owner:string;input:Omit<VideoInput,'image'>;hasImage:boolean;status:'queued'|'running'|'cancelling'|'cancelled'|'succeeded'|'failed';progress:number;stage:string;createdAt:string;finishedAt?:string;error?:string;bytes?:number}
export interface VideoReadiness {ready:boolean;message:string;device?:string;model?:string;dependencies?:boolean;cuda?:boolean;verificationOnly?:boolean}
export type VideoRunner=(directory:string,input:VideoInput,progress:(percent:number,stage:string)=>void,signal:AbortSignal)=>Promise<void>;
const ltxWorker=fileURLToPath(new URL('../scripts/video-worker.py',import.meta.url));
const h3Worker=fileURLToPath(new URL('../scripts/comfyui-h3-video-worker.py',import.meta.url));
/** H3重みがある本機ではH3を標準にし、それ以外の環境は従来のLTX経路を保ちます。 */
function selectedWorker(){
 const requested=process.env.WENTIAN_VIDEO_BACKEND;
 if(requested==='ltx')return ltxWorker;
 const modelRoot=process.env.WENTIAN_COMFYUI_MODEL_ROOT||path.resolve('.wentian','comfyui','models');
 const h3Exists=existsSync(path.join(modelRoot,'diffusion_models','minimax_h3_fl2va_pruned_int8_convrot.safetensors'));
 return requested==='comfyui-h3'||(!requested&&h3Exists)?h3Worker:ltxWorker;
}
function usesH3(){return selectedWorker()===h3Worker}
const idPattern=/^[0-9a-f]{8}-[0-9a-f-]{27}$/;
const active=(j:VideoJob)=>['queued','running','cancelling'].includes(j.status);

/** 入力（Input）は固定パイプラインの項目だけに限定し、任意のコマンドやモデルパスを受け付けません。 */
export function validateVideoInput(value:unknown):VideoInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new VideoError('動画の設定を入力してください。');
 const x=value as Record<string,unknown>;
 if(Object.keys(x).some(k=>!['prompt','negativePrompt','width','height','frames','fps','steps','seed','image','audioJobId','audioVolume'].includes(k)))throw new VideoError('未対応の動画設定です。');
 if(typeof x.prompt!=='string'||!x.prompt.trim()||x.prompt.length>4000)throw new VideoError('生成内容は1～4000文字で指定してください。');
 if(x.negativePrompt!==undefined&&(typeof x.negativePrompt!=='string'||x.negativePrompt.length>4000))throw new VideoError('避けたい内容は4000文字以内です。');
 const result:VideoInput={prompt:x.prompt.trim(),negativePrompt:String(x.negativePrompt||''),width:Number(x.width??512),height:Number(x.height??320),frames:Number(x.frames??49),fps:Number(x.fps??24),steps:Number(x.steps??30),seed:Number(x.seed??Math.floor(Math.random()*2147483648))};
 if(![result.width,result.height,result.frames,result.fps,result.steps,result.seed].every(Number.isSafeInteger)||result.width<256||result.width>768||result.height<256||result.height>768||result.width%32||result.height%32||result.frames<9||result.frames>161||(result.frames-1)%8||result.fps<8||result.fps>30||result.steps<1||result.steps>80||result.seed<0||result.seed>2147483647)throw new VideoError('解像度は256～768の32倍数、フレーム数は9～161の8n+1、FPSは8～30、ステップは1～80です。');
 if(x.image!==undefined){if(typeof x.image!=='string'||x.image.length>14*1024*1024||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(x.image))throw new VideoError('起点画像は10MiB以内のPNGまたはJPEGです。');const data=Buffer.from(x.image.split(',')[1],'base64');if(data.length>10*1024*1024||!(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.subarray(0,3).equals(Buffer.from([255,216,255]))))throw new VideoError('画像形式または容量が不正です。');result.image=x.image;}
 if(x.audioJobId!==undefined){if(typeof x.audioJobId!=='string'||!idPattern.test(x.audioJobId))throw new VideoError('完成した音声を選択してください。');result.audioJobId=x.audioJobId;result.audioVolume=Number(x.audioVolume??1);if(!Number.isFinite(result.audioVolume)||result.audioVolume<0||result.audioVolume>2)throw new VideoError('音量は0～2で指定してください。');}
 return result;
}

/** Pythonワーカー（Worker）の標準出力は構造化された進捗だけを採用し、標準エラーに秘密値を出しません。 */
function pythonProcess(args:string[],signal?:AbortSignal){
 const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)),'.wentian');
 const configured=process.env.WENTIAN_VIDEO_PYTHON;
 const plannerPython=path.join(root,'planner-engine',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const videoPython=path.join(root,'video-engine',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 const python=configured||(usesH3()&&existsSync(plannerPython)?plannerPython:videoPython);
 return spawn(python,[selectedWorker(),...args],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'}})
}
/** 取消時は自分が起動したワーカーの子プロセス（Child Process）も終了します。 */
export function terminateMediaWorker(child:ChildProcess){if(usesH3()){const base=(process.env.COMFYUI_BASE_URL||'http://127.0.0.1:8190').replace(/\/$/,'');void fetch(base+'/interrupt',{method:'POST',signal:AbortSignal.timeout(3000)}).catch(()=>undefined)}if(process.platform==='win32'&&child.pid)execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{if(child.exitCode===null)child.kill()});else child.kill()}
export async function diagnoseVideo():Promise<VideoReadiness>{
 return new Promise(resolve=>{let child:ChildProcess;try{child=pythonProcess(['--diagnose'])}catch{return resolve({ready:false,message:'動画用Python環境を準備してください。'})}child.stderr?.resume();let output='';const timer=setTimeout(()=>{child.kill();resolve({ready:false,message:'動画エンジンの診断が期限切れです。ComfyUIの初回起動には数分かかる場合があります。'})},usesH3()?240000:30000);child.stdout?.on('data',data=>{output=(output+data).slice(-32768)});child.on('error',()=>{clearTimeout(timer);resolve({ready:false,message:'動画用Python環境が未準備です。Python環境を確認してください。'})});child.on('close',()=>{clearTimeout(timer);try{const result=JSON.parse(output.trim().split('\n').at(-1)!);resolve(typeof result.ready==='boolean'&&typeof result.message==='string'?result:{ready:false,message:'診断結果が不正です。'})}catch{resolve({ready:false,message:'動画エンジンを診断できませんでした。'})}})});
}
export const runVideo:VideoRunner=async(directory,_input,progress,signal)=>{
 await new Promise<void>((resolve,reject)=>{const child=pythonProcess(['--job',directory],signal);const cancel=()=>terminateMediaWorker(child);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();child.stderr?.resume();let buffer='',workerError='';const timer=setTimeout(()=>{workerError='生成時間が60分を超えたため中止しました。';terminateMediaWorker(child)},60*60*1000);child.stdout?.on('data',data=>{buffer+=data.toString();if(buffer.length>65536){workerError='ワーカーの応答が不正です。';terminateMediaWorker(child);return;}const lines=buffer.split('\n');buffer=lines.pop()!;for(const line of lines){try{const event=JSON.parse(line);if(event.type==='progress'&&Number.isFinite(event.percent))progress(Math.max(0,Math.min(99,event.percent)),String(event.stage||'生成中').slice(0,100));if(event.type==='error')workerError=String(event.message).slice(0,500)}catch{/* 構造化されていないライブラリ出力は画面へ転送しません。 */}}});child.on('error',()=>{workerError=signal.aborted?'動画生成を取り消しました。':'動画ワーカーを起動できません。Python環境を確認してください。'});child.on('close',code=>{signal.removeEventListener('abort',cancel);clearTimeout(timer);if(code===0&&!signal.aborted&&!workerError)resolve();else reject(new VideoError(workerError||'動画生成に失敗しました。実行環境と空きGPUメモリを確認してください。'))})});
};

/** 永続キュー（Persistent Queue）。1プロセス・1ジョブでGPU競合を抑え、再起動時の実行中ジョブは失敗として明示します。 */
export class VideoService {
 private db!:DatabaseSync;private current?:{id:string;abort:AbortController;done:Promise<void>};private started=false;private closed=false;private creating=0;
 private constructor(readonly root:string,private runner:VideoRunner,private diagnose:()=>Promise<VideoReadiness>,private resolveAudio?:(owner:string,id:string)=>Promise<string>){}
 static async open(root:string,runner:VideoRunner=runVideo,diagnose=diagnoseVideo,resolveAudio?:(owner:string,id:string)=>Promise<string>){
  const service=new VideoService(path.resolve(root),runner,diagnose,resolveAudio);await mkdir(service.root,{recursive:true,mode:0o700});
  const lock=path.join(service.root,'worker.lock');
  try{await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600})}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const pid=Number(await readFile(lock,'utf8'));let alive=Number.isSafeInteger(pid)&&pid>0;try{if(alive)process.kill(pid,0)}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false}if(alive)throw new VideoError('この動画台帳は別のプロセスが使用中です。',409);await unlink(lock);await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600});}
  try{service.db=new DatabaseSync(path.join(service.root,'videos.sqlite'));service.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,value TEXT NOT NULL);');for(const j of service.all()){if(j.status==='running'||j.status==='cancelling'){j.status=j.status==='cancelling'?'cancelled':'failed';j.error='サーバーが停止したため生成を中断しました。再生成してください。';j.finishedAt=new Date().toISOString();service.save(j);}}return service;}catch(error){await unlink(lock);throw error;}
 }
 private all():VideoJob[]{return this.db.prepare('SELECT value FROM jobs ORDER BY rowid').all().map(row=>JSON.parse(String(row.value)))}
 private save(j:VideoJob){this.db.prepare('INSERT OR REPLACE INTO jobs(id,owner,value) VALUES(?,?,?)').run(j.id,j.owner,JSON.stringify(j))}
 list(owner:string){return this.all().filter(j=>j.owner===owner).reverse()}
 get(owner:string,id:string){if(!idPattern.test(id))throw new VideoError('動画が見つかりません。',404);const j=this.all().find(j=>j.id===id&&j.owner===owner);if(!j)throw new VideoError('動画が見つかりません。',404);return j;}
 async readiness(){return this.diagnose()}
 async create(owner:string,value:unknown){
  const input=validateVideoInput(value),ready=await this.diagnose();if(!ready.ready)throw new VideoError(ready.message,409);
  // 診断待ちの後に再集計し、同時要求でも待機上限を超えさせません。
  if(this.all().filter(active).length+this.creating>=8)throw new VideoError('生成待ちが上限の8件です。完了後に追加してください。',409);
  this.creating++;try{
  const soundtrack=input.audioJobId?await this.resolveAudio?.(owner,input.audioJobId):undefined;if(input.audioJobId&&!soundtrack)throw new VideoError('音声素材が見つかりません。',404);
  const id=randomUUID(),directory=path.join(this.root,id);await mkdir(directory,{mode:0o700});const {image,...settings}=input;if(soundtrack)await copyFile(soundtrack,path.join(directory,'soundtrack.audio'));
  await writeFile(path.join(directory,'request.json'),JSON.stringify(settings),{mode:0o600});if(image)await writeFile(path.join(directory,'input.image'),Buffer.from(image.split(',')[1],'base64'),{mode:0o600});
  const j:VideoJob={id,owner,input:settings,hasImage:!!image,status:'queued',progress:0,stage:'生成待ち',createdAt:new Date().toISOString()};this.save(j);this.pump();return j;
  }finally{this.creating--;}
 }
 /** 同じ所有者の完成済み動画を複製条件で再生成し、元ファイルや履歴は保持します。 */
 async retry(owner:string,id:string){
  const job=this.get(owner,id);
  if(active(job))throw new VideoError('処理が終わってから再生成してください。',409);
  const directory=path.join(this.root,id),request=JSON.parse(await readFile(path.join(directory,'request.json'),'utf8'));
  const image=path.join(directory,'input.image');
  if(job.hasImage){const bytes=await readFile(image),mime=bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'image/jpeg':'image/png';request.image=`data:${mime};base64,${bytes.toString('base64')}`;}
  return this.create(owner,request);
 }
 start(){this.started=true;this.pump()}
 private pump(){if(!this.started||this.closed||this.current)return;const j=this.all().find(j=>j.status==='queued');if(!j)return;const abort=new AbortController();j.status='running';j.stage='モデルを読み込み中';this.save(j);const done=this.perform(j,abort);this.current={id:j.id,abort,done};void done.finally(()=>{this.current=undefined;this.pump()});}
 private async perform(j:VideoJob,abort:AbortController){try{
  await this.runner(path.join(this.root,j.id),j.input,(percent,stage)=>{if(!abort.signal.aborted){j.progress=percent;j.stage=stage;this.save(j)}},abort.signal);
  if(abort.signal.aborted)throw new VideoError('取り消しました。');const file=await this.output(j.id);j.bytes=file.size;j.status='succeeded';j.progress=100;j.stage='生成完了';
 }catch(error){j.status=abort.signal.aborted?'cancelled':'failed';j.stage=abort.signal.aborted?'取消済み':'生成失敗';j.error=error instanceof VideoError?error.message:'動画生成に失敗しました。環境とモデルを確認してください。';}finally{j.finishedAt=new Date().toISOString();this.save(j);}}
 async cancel(owner:string,id:string){const j=this.get(owner,id);if(j.status==='queued'){j.status='cancelled';j.stage='取消済み';j.finishedAt=new Date().toISOString();this.save(j);}else if(j.status==='running'||j.status==='cancelling'){j.status='cancelling';j.stage='取消処理中';this.save(j);this.current?.id===id&&this.current.abort.abort();}else throw new VideoError('この動画は既に終了しています。',409);return this.get(owner,id);}
 async remove(owner:string,id:string){const j=this.get(owner,id);if(active(j))throw new VideoError('取り消しが完了してから削除してください。',409);const directory=path.join(this.root,id);for(const name of ['output.mp4','input.image','request.json','output.partial.mp4','soundtrack.audio','attached.mp4'])await unlink(path.join(directory,name)).catch(error=>{if(error.code!=='ENOENT')throw error});this.db.prepare('DELETE FROM jobs WHERE id=? AND owner=?').run(id,owner);return {ok:true};}
 async output(id:string){if(!idPattern.test(id))throw new VideoError('動画が見つかりません。',404);const file=path.join(this.root,id,'output.mp4'),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size<24||stat.size>2*1024**3||await realpath(path.dirname(file))!==path.join(await realpath(this.root),id))throw new VideoError('動画ファイルが不正です。',409);const handle=await open(file,'r');try{const header=Buffer.alloc(12);await handle.read(header,0,12,0);if(header.toString('ascii',4,8)!=='ftyp')throw new VideoError('MP4形式ではありません。',409)}finally{await handle.close()}return {file,size:stat.size};}
 async close(){this.closed=true;this.current?.abort.abort();await this.current?.done;this.db.close();await unlink(path.join(this.root,'worker.lock'));}
}

/** 動画API（Video API）は管理者の所有者境界を守り、再生のRange要求にも同じ認証を適用します。 */
export function registerVideoGeneration(app:FastifyInstance,options:{root?:string;authorize:(req:FastifyRequest,reply:FastifyReply)=>string|undefined;runner?:VideoRunner;diagnose?:()=>Promise<VideoReadiness>;resolveAudio?:(owner:string,id:string)=>Promise<string>}){
 let pending:Promise<VideoService>|undefined;const get=()=>pending??=VideoService.open(options.root||process.env.WENTIAN_VIDEO_ROOT||path.join(process.env.WENTIAN_INSTALL_ROOT||process.cwd(),'.wentian','videos'),options.runner,options.diagnose,options.resolveAudio);
 app.addHook('onListen',async()=>{(await get()).start()});app.addHook('onClose',async()=>{if(pending)await(await pending).close()});
 app.register(async routes=>{
  routes.addHook('preHandler',async(req,reply)=>{if(req.headers['x-team-virtual-key'])return reply.code(403).send({error:{message:'動画操作にチーム仮想キーは使えません。'}});if(req.headers.origin&&req.headers.origin!==`${req.protocol}://${req.headers.host}`)return reply.code(403).send({error:{message:'同一オリジンから操作してください。'}});});
  routes.setErrorHandler((error,_req,reply)=>reply.code(error instanceof VideoError?error.statusCode:400).send({error:{message:error instanceof VideoError?error.message:'動画処理に失敗しました。'}}));
  routes.get('/api/videos/readiness',async(req,reply)=>{const owner=options.authorize(req,reply);return owner?(await get()).readiness():reply;});
  routes.get('/api/videos',async(req,reply)=>{const owner=options.authorize(req,reply);return owner?{jobs:(await get()).list(owner)}:reply;});
  routes.post('/api/videos',async(req,reply)=>{const owner=options.authorize(req,reply);return owner?reply.code(202).send(await(await get()).create(owner,req.body)):reply;});
  routes.post('/api/videos/:id/retry',async(req,reply)=>{const owner=options.authorize(req,reply);return owner?reply.code(202).send(await(await get()).retry(owner,(req.params as any).id)):reply;});
  routes.post('/api/videos/:id/cancel',async(req,reply)=>{const owner=options.authorize(req,reply);return owner?(await get()).cancel(owner,(req.params as any).id):reply;});
  routes.delete('/api/videos/:id',async(req,reply)=>{const owner=options.authorize(req,reply);return owner?(await get()).remove(owner,(req.params as any).id):reply;});
  routes.get('/api/videos/:id/content',async(req,reply)=>{
   const owner=options.authorize(req,reply);if(!owner)return reply;const service=await get(),j=service.get(owner,(req.params as any).id);if(j.status!=='succeeded')throw new VideoError('動画はまだ生成されていません。',409);const {file,size}=await service.output(j.id);let start=0,end=size-1;
   reply.header('cache-control','private, no-store').header('accept-ranges','bytes').header('x-content-type-options','nosniff').type('video/mp4');
   if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||(!match[1]&&!match[2]))return reply.code(416).header('content-range',`bytes */${size}`).send();if(!match[1]){const suffix=Number(match[2]);start=Math.max(0,size-suffix);if(suffix<=0)start=size;}else {start=Number(match[1]);end=match[2]?Math.min(end,Number(match[2])):end;}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return reply.code(416).header('content-range',`bytes */${size}`).send();reply.code(206).header('content-range',`bytes ${start}-${end}/${size}`);}
   if((req.query as any).download==='1')reply.header('content-disposition',`attachment; filename="wentian-${j.id}.mp4"`);reply.header('content-length',end-start+1);return reply.send(createReadStream(file,{start,end}));
  });
 });return {service:get};
}
