import {execFile} from 'node:child_process';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import os from 'node:os';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {AGENT_CATALOG,probeAgentCli,resolveAgentExecutable} from './agent-marketplace.js';
import {agentNotExcluded} from './agent-exclusion-policy.js';
import {agentNodeExecutable,agentRuntimeEnvironment,agentRuntimeRoot} from './agent-runtime.js';
import {renameWithRetry} from './atomic-file.js';
import type {ExternalAgentStatus} from './external-agents.js';
import {terminateProcessTree} from './external-orchestrator.js';
import {maintenancePythonCommand} from './maintenance-python.js';

const run=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const activeInstallations=new Map<string,AbortController>();
export const isAgentInstalling=(id:string)=>activeInstallations.has(id);
/** 停止操作で対象の導入だけを中断します。親プロセスの保守は継続します。 */
export function cancelAgentInstallation(id:string){activeInstallations.get(id)?.abort(new Error('管理者が自動導入を停止しました。'));}
/** npmの子プロセスも停止確認し、残存が不明なまま次の導入へ進みません。 */
function runInstaller(executable:string,args:string[],signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    let stopping=false,settled=false;
    const child=execFile(executable,args,{windowsHide:true,maxBuffer:4*1024*1024,env:{...agentRuntimeEnvironment(),npm_config_offline:'false',UV_OFFLINE:'0',PIP_NO_INDEX:'0'}},error=>{
      if(stopping||settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve();
    });
    const stop=async()=>{if(stopping||settled)return;stopping=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);const termination=child.pid?await terminateProcessTree(child.pid):undefined;settled=true;reject(Object.assign(new Error(signal?.aborted?'導入を中断しました。':'CLI導入が期限を超過しました。'),{termination}));};
    const abort=()=>{void stop();};const timer=setTimeout(()=>{void stop();},600000);signal?.addEventListener('abort',abort,{once:true});child.stdin?.end();
    if(signal?.aborted)void stop();
  });
}
export interface AgentInstallation {status:'installing'|'verified'|'retry_wait'|'manual_required'|'disabled';checkedAt:string;retryAt?:string;attempts:number;reason:string;processBlocked?:boolean}
export const installationStorePath=()=>process.env.WENTIAN_AGENT_INSTALL_CACHE||path.join(process.env.WENTIAN_INSTALL_ROOT||root,'.wentian','agent-installations.json');
export function readAgentInstallations():Record<string,AgentInstallation>{try{return JSON.parse(readFileSync(installationStorePath(),'utf8')).agents||{};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}}
async function save(id:string,value:AgentInstallation){const store=readAgentInstallations();store[id]=value;const target=installationStorePath();await mkdir(path.dirname(target),{recursive:true});const temporary=target+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify({version:1,agents:store},null,2));await renameWithRetry(temporary,target);}
/** サーバー内の許可済みカタログだけから導入し、利用者入力を実行コマンドにしません。 */
export async function installCatalogAgent(id:string,signal?:AbortSignal):Promise<void>{
  const item=AGENT_CATALOG.find(agent=>agent.id===id);
  if(!item?.install||item.compatibility!=='windows')throw new Error('対応する自動導入方法がありません。');
  if(item.install.method==='github'){
    if(id!=='goose'||process.platform!=='win32'||process.arch!=='x64')throw new Error('この端末用の公式CLIアーカイブには対応していません。');
    const response=await fetch('https://api.github.com/repos/aaif-goose/goose/releases/tags/stable',{headers:{'user-agent':'wentian-maintenance'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('Goose公式リリース一覧: HTTP '+response.status);
    const release=await response.json() as {assets?:Array<{name:string;browser_download_url:string;digest?:string}>};
    const asset=release.assets?.find(asset=>asset.name==='goose-x86_64-pc-windows-msvc.zip');
    if(!asset?.digest?.match(/^sha256:[a-f0-9]{64}$/)||!asset.browser_download_url.startsWith('https://github.com/aaif-goose/goose/releases/download/'))throw new Error('公式CLIの配布元またはチェックサムを確認できません。');
    const download=await fetch(asset.browser_download_url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000)});
    if(!download.ok)throw new Error('Goose公式CLI取得: HTTP '+download.status);
    const bytes=new Uint8Array(await download.arrayBuffer());
    if('sha256:'+createHash('sha256').update(bytes).digest('hex')!==asset.digest)throw new Error('Gooseアーカイブのチェックサムが一致しません。');
    const files=unzipSync(bytes),target=path.join(process.env.USERPROFILE||os.homedir(),'.local/bin');await mkdir(target,{recursive:true});
    // 検証済みアーカイブのCLIと必要なDLLだけを展開し、パス付きファイル名をそのまま使いません。
    const binaries=Object.entries(files).filter(([name])=>/^(?:.*\/)?(?:goose\.exe|[^/]+\.dll)$/i.test(name));
    if(!binaries.some(([name])=>path.posix.basename(name).toLowerCase()==='goose.exe'))throw new Error('アーカイブにGoose CLIがありません。');
    const names=new Set<string>();for(const [name,content] of binaries){const filename=path.posix.basename(name);if(!/^[a-zA-Z0-9_.-]+$/.test(filename))throw new Error('CLIアーカイブのファイル名が不正です。');if(names.has(filename.toLowerCase()))throw new Error('CLIアーカイブのファイル名が重複しています。');names.add(filename.toLowerCase());await writeFile(path.join(target,filename),content);}
    return;
  }
  let executable=item.install.executable,args=[...item.install.arguments];
  if(item.install.method==='npm'){
    if(process.platform==='win32'){
      const python=maintenancePythonCommand();
      await run(python.executable,[...python.args,path.join(root,'scripts/prepare-agent-runtime.py'),'--root',agentRuntimeRoot()],{timeout:180000,windowsHide:true,signal});
    }
    const node=agentNodeExecutable();
    let npmCli=path.join(path.dirname(node),'node_modules/npm/bin/npm-cli.js');
    try{await access(npmCli);}catch{const npm=await resolveAgentExecutable('npm');if(!npm)throw new Error('npmを検出できません。');npmCli=path.join(path.dirname(npm),'node_modules/npm/bin/npm-cli.js');await access(npmCli);}
    executable=node;args=[npmCli,...args];
    // ユーザー領域へ導入し、管理者権限とPC全体のランタイム変更を不要にします。
    if(process.platform==='win32')args.push('--prefix',path.join(process.env.APPDATA||path.join(process.env.USERPROFILE||'','AppData/Roaming'),'npm'));
  }else{
    let resolved=await resolveAgentExecutable(executable);
    if(!resolved&&item.install.method==='uv'){
      const winget=await resolveAgentExecutable('winget.exe');if(!winget)throw new Error('uv導入用のWinGetを検出できません。');
      await runInstaller(winget,['install','--id','astral-sh.uv','--exact','--source','winget','--accept-package-agreements','--accept-source-agreements','--disable-interactivity'],signal);
      resolved=await resolveAgentExecutable(executable);if(!resolved)throw new Error('導入後のuvを検出できません。');
    }
    executable=resolved||executable;
    if(item.install.method==='winget')args.push('--disable-interactivity');
  }
  // この固定された導入経路だけ通信を許可します。通常のエージェント作業のオフライン制限は維持します。
  await runInstaller(executable,args,signal);
}
/** 導入待ちと再試行期限を保存し、導入直後の実CLI確認まで成功と表示しません。 */
export async function maintainAgentInstallation(agent:ExternalAgentStatus,onUpdate?:(agent:ExternalAgentStatus)=>Promise<void>,signal?:AbortSignal,deps:{install?:typeof installCatalogAgent;probe?:typeof probeAgentCli;now?:()=>number;repair?:boolean}={}):Promise<ExternalAgentStatus>{
  // AIによる修復も既存カタログ・停止設定・再試行期限を守り、正常なCLIの再導入は行いません。
  if(!agentNotExcluded(agent)||(agent.liveState!=='not_installed'&&!(deps.repair&&agent.liveState==='probe_failed')))return agent;
  const now=(deps.now||Date.now)(),previous=readAgentInstallations()[agent.id];
  const show=(installation:AgentInstallation):ExternalAgentStatus=>({...agent,installation,state:'needs_recheck',stateLabel:installation.status==='installing'?'CLI自動導入中':installation.status==='retry_wait'?'CLI導入失敗・再試行待ち':installation.status==='disabled'?'CLI自動導入停止':'CLI導入に対応が必要',note:installation.reason+(installation.retryAt?' 次回確認予定: '+installation.retryAt:'')});
  if(previous?.processBlocked)return show(previous);
  if(previous?.status==='retry_wait'&&Date.parse(previous.retryAt||'')>now)return show(previous);
  const item=AGENT_CATALOG.find(item=>item.id===agent.id);
  let entry:AgentInstallation={status:'installing',checkedAt:new Date(now).toISOString(),attempts:(previous?.attempts||0)+1,reason:'公式パッケージを自動導入しています。完了後に接続・実作業を確認します。'};
  if(process.env.WENTIAN_AGENT_AUTO_INSTALL==='false')entry={...entry,status:'disabled',reason:'自動導入が設定で無効です。WENTIAN_AGENT_AUTO_INSTALLを有効にしてください。'};
  else if(!item?.install||item.compatibility!=='windows')entry={...entry,status:'manual_required',reason:'この登録には自動導入手順がありません。公式の導入手順を追加するか、CLIを導入してください。'};
  if(entry.status!=='installing'){await save(agent.id,entry);await onUpdate?.(show(entry));return show(entry);}
  const controller=new AbortController();activeInstallations.set(agent.id,controller);
  const installSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  try{
    await save(agent.id,entry);await onUpdate?.(show(entry));
    signal?.throwIfAborted();if(!agentNotExcluded(agent))return agent;
    await (deps.install||installCatalogAgent)(agent.id,installSignal);
    const probe=await (deps.probe||probeAgentCli)({cli:agent.cli||agent.id});
    if(probe.liveState!=='healthy')throw new Error(probe.liveState==='not_installed'?'導入後のCLIを検出できません。':probe.probeError||'導入後のCLI起動確認に失敗しました。');
    entry={...entry,status:'verified',checkedAt:new Date((deps.now||Date.now)()).toISOString(),reason:'CLIの自動導入・起動確認に成功しました。接続設定と実作業を続けて確認します。'};await save(agent.id,entry);
    const updated={...agent,...probe,installation:entry,state:'needs_recheck' as const,stateLabel:'CLI導入済み・接続確認待ち',note:entry.reason,lastObservedAt:probe.checkedAt};await onUpdate?.(updated);return updated;
  }catch(error){
    if(signal?.aborted)throw error;
    const unsafe=(error as {termination?:{verifiedStopped?:boolean}})?.termination?.verifiedStopped===false;
    if(controller.signal.aborted&&!unsafe){entry={...entry,status:'disabled',reason:'管理者の停止操作により自動導入を中断しました。'};await save(agent.id,entry);return show(entry);}
    const completed=(deps.now||Date.now)();entry={...entry,status:'retry_wait',checkedAt:new Date(completed).toISOString(),retryAt:new Date(completed+Math.min(3600000,60000*2**Math.min(6,entry.attempts-1))).toISOString(),reason:'自動導入に失敗しました: '+String(error instanceof Error?error.message:error).slice(-1200)};
    if(unsafe)entry={...entry,status:'manual_required',processBlocked:true,retryAt:undefined,reason:'導入プロセスの停止を確認できません。重複導入を止め、プロセス確認を待ちます。'};
    await save(agent.id,entry);await onUpdate?.(show(entry));return show(entry);
  }finally{activeInstallations.delete(agent.id);}
}
