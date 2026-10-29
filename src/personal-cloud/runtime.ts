import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { observeMemory } from '../manager.js';
import { CloudError, iso, type AppSpec, type Capabilities, type Engine } from './types.js';
import { readGpuProofs } from './gpu.js';

const exec=promisify(execFile);
export type CommandRunner=(command:string,args:string[],timeoutMs?:number)=>Promise<string>;
/** シェル（Shell）を使わず、固定の実行ファイルと分離した引数で実行します。 */
export const runCommand:CommandRunner=async(command,args,timeoutMs=30000)=>{
  try{const result=await exec(command,args,{windowsHide:true,timeout:timeoutMs,maxBuffer:2*1024*1024,encoding:'utf8'});return result.stdout;}
  catch(error){const e=error as NodeJS.ErrnoException & {stderr?:string};const stderr=e.stderr||'';
    // 生の標準エラー（Standard Error）に資格情報が含まれる可能性があるため、理由だけを分類します。
    const reason=e.code==='ENOENT'?'実行ファイルが未導入':/unauthorized|authentication required|pull access denied/i.test(stderr)?'イメージ取得権限または認証を確認してください':/manifest unknown|not found|no such image/i.test(stderr)?'指定イメージまたは対象が存在しません':/no space left/i.test(stderr)?'空きディスクが不足しています':/cannot connect|failed to connect|connection refused/i.test(stderr)?'実行サービスに接続できません':/timed out|timeout/i.test(stderr)?'処理が期限切れです':'実行環境または設定を確認してください';
    throw new CloudError(`${command}の実行に失敗しました：${reason}。`,409);
  }
};

/** PC診断（Node Diagnostics）。GPUの認識とコンテナでの利用検証は別に報告します。 */
export async function diagnoseNode(run:CommandRunner=runCommand,proofRoot?:string):Promise<Capabilities>{
  const runtimes=await Promise.all((['docker','podman'] as const).map(async engine=>{try{
    const info=JSON.parse(await run(engine,['info','--format','json'],10000));
    const linux=String(info.OSType||info.host?.os||info.Host?.OS||'').toLowerCase()==='linux';
    return {engine,ready:linux,version:String(info.ServerVersion||info.version?.Version||info.version?.version||''),...(linux?{}:{reason:'Linuxコンテナ実行環境が必要です。'})};
  }catch{return {engine,ready:false,reason:'未導入または実行サービスが停止しています。Docker DesktopまたはPodman Machineを起動して再診断してください。'};}}));
  const proofs=proofRoot?await readGpuProofs(proofRoot):[];
  let gpus:Capabilities['gpus']=[];try{const memory=await observeMemory({ignoreNodeReservations:true});gpus=memory.gpus.map(g=>{const engines=proofs.filter(p=>p.index===g.index&&p.name===g.name&&g.vendor==='nvidia').map(p=>p.engine);return {index:g.index,name:g.name,freeBytes:g.freeBytes,totalBytes:g.totalBytes,verified:engines.length>0,engines};});}catch{/* 取得不能をRAMで代用しません。 */}
  const ai=await Promise.all([['ollama','http://127.0.0.1:11434/api/tags'],['lmstudio','http://127.0.0.1:1234/v1/models']].map(async([kind,url])=>{try{return {kind,ready:(await fetch(url,{signal:AbortSignal.timeout(2000)})).ok}}catch{return {kind,ready:false}}}));
  // VM側の上限をホスト資源と取り違えないよう、使用可能なランタイムの上限を再取得します。
  let memoryBytes=os.totalmem(),cpuCores=os.availableParallelism();
  for(const runtime of runtimes.filter(r=>r.ready)){try{const info=JSON.parse(await run(runtime.engine,['info','--format','json'],10000));const m=Number(info.MemTotal||info.host?.memTotal),c=Number(info.NCPU||info.host?.cpus);if(m>0)memoryBytes=Math.min(memoryBytes,m);if(c>0)cpuCores=Math.min(cpuCores,c);}catch{/* 再取得失敗は初回診断を維持します。 */}}
  return {os:process.platform,arch:process.arch,cpuCores,memoryBytes,freeMemoryBytes:Math.min(os.freemem(),memoryBytes),observedAt:iso(),runtimes,gpus,ai};
}

/** 管理ラベル（Managed Label）に一致するコンテナだけを操作するランタイムアダプターです。 */
export class ContainerRuntime {
  constructor(readonly engine:Engine,private run:CommandRunner=runCommand){}
  private async inspect(name:string){const rows=JSON.parse(await this.run(this.engine,['inspect',name]));return rows[0];}
  private async network(appId:string,create:boolean){const name='wentian-net-'+appId;
    const exists=(await this.run(this.engine,['network','ls','--format','{{.Name}}'])).trim().split(/\r?\n/).includes(name);
    if(exists){const record=JSON.parse(await this.run(this.engine,['network','inspect',name]))[0];if(record.Labels?.['io.wentian.app']!==appId&&record.labels?.['io.wentian.app']!==appId)throw new CloudError('管理外ネットワークとの名前競合です。');}
    else if(create)await this.run(this.engine,['network','create','--driver','bridge','--label','io.wentian.app='+appId,name]);return {name,exists};
  }
  async removeNetwork(appId:string){const network=await this.network(appId,false);if(network.exists)await this.run(this.engine,['network','rm',network.name]);}
  async find(name:string,appId:string):Promise<any|undefined>{
    // inspectの失敗を「不存在」と決めつけず、一覧で存在を先に照合します。
    const names=(await this.run(this.engine,['ps','-a','--format','{{.Names}}'])).trim().split(/\r?\n/);
    if(!names.includes(name))return undefined;
    const row=await this.inspect(name);if(row.Config?.Labels?.['io.wentian.app']!==appId)throw new CloudError('Wentian管理外のコンテナと名前が競合しています。',409);return row;
  }
  async deploy(appId:string,deploymentId:string,spec:AppSpec,gpuIndex?:number){
    if(spec.gpuMemoryBytes&&(!Number.isInteger(gpuIndex)||gpuIndex!<0))throw new CloudError('検証済みGPUの割当が必要です。');
    const name='wentian-'+deploymentId.replace(/[^a-zA-Z0-9_-]/g,'');let row=await this.find(name,appId);
    if(!row){
      const network=await this.network(appId,true);
      await this.run(this.engine,['pull',spec.image],600000);
      const image=JSON.parse(await this.run(this.engine,['image','inspect',spec.image]))[0];
      const desiredArch=spec.arch==='arm64'?'arm64':spec.arch==='x64'?'amd64':process.arch==='arm64'?'arm64':'amd64';
      if(image.Os!=='linux'||image.Architecture!==desiredArch)throw new CloudError('イメージのOSまたはCPUアーキテクチャが不一致です。',409);
      const digest=image.RepoDigests?.[0];if(typeof digest!=='string'||!/@sha256:[a-f0-9]{64}$/.test(digest))throw new CloudError('イメージのダイジェストを確定できません。',409);
      // ループバックだけに公開し、資源上限と権限の制限を常に付けます。ホストマウントは許可しません。
      const args=['run','-d','--name',name,'--label','io.wentian.app='+appId,'--label','io.wentian.deployment='+deploymentId,'--restart','unless-stopped','--cpus',String(spec.cpuCores),'--memory',String(spec.memoryBytes),'--pids-limit','256','--cap-drop','ALL','--security-opt','no-new-privileges','--publish','127.0.0.1::'+spec.containerPort];
      args.push('--network',network.name);
      if(spec.gpuMemoryBytes)args.push(...(this.engine==='docker'?['--gpus','device='+gpuIndex]:['--device','nvidia.com/gpu='+gpuIndex]));
      for(const [key,value] of Object.entries(spec.environment))args.push('--env',key+'='+value);
      args.push(digest);await this.run(this.engine,args,60000);row=await this.find(name,appId);
    }
    if(!row?.State?.Running)await this.run(this.engine,['start',name]);
    row=await this.find(name,appId);
    const binding=row?.NetworkSettings?.Ports?.[spec.containerPort+'/tcp']?.find((p:any)=>p.HostIp==='127.0.0.1');
    const port=Number(binding?.HostPort);if(!Number.isInteger(port)||port<1||port===8787)throw new CloudError('コンテナの安全な公開先を確認できません。',409);
    return {name,port,imageDigest:String(row.Config?.Image||row.Image)};
  }
  async stop(name:string,appId:string){if(await this.find(name,appId))await this.run(this.engine,['stop','--time','10',name],30000);}
  async start(name:string,appId:string,containerPort?:number){if(!await this.find(name,appId))throw new CloudError('コンテナが存在しません。',404);await this.run(this.engine,['start',name]);if(containerPort){const row=await this.find(name,appId);const binding=row?.NetworkSettings?.Ports?.[containerPort+'/tcp']?.find((p:any)=>p.HostIp==='127.0.0.1');const port=Number(binding?.HostPort);if(!Number.isInteger(port)||port<1||port===8787)throw new CloudError('再開後のアプリポートを確認できません。');return port;}return undefined;}
  async remove(name:string,appId:string){if(await this.find(name,appId))await this.run(this.engine,['rm','-f',name],30000);}
}

/** 正常性確認（Health Check）は連続3回成功を条件にし、転送を許可しないHTTPだけで検査します。 */
export async function waitHealthy(port:number,path:string,options:{timeoutMs?:number;intervalMs?:number;fetcher?:typeof fetch}={}){
  const until=Date.now()+(options.timeoutMs??120000);let successes=0;const fetcher=options.fetcher||fetch;
  do{try{const response=await fetcher('http://127.0.0.1:'+port+path,{redirect:'manual',signal:AbortSignal.timeout(2000)});await response.body?.cancel();successes=response.ok?successes+1:0;if(successes>=3)return;}catch{successes=0}
    await new Promise(resolve=>setTimeout(resolve,options.intervalMs??3000));
  }while(Date.now()<until);throw new CloudError('正常性確認が期限内に3回連続で成功しませんでした。',409);
}
