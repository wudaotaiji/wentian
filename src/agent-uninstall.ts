import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AGENT_CATALOG,resolveAgentExecutable} from './agent-marketplace.js';

const run=promisify(execFile);
interface Removal {executable:string;args:string[];target:string;source:string}
const approvals=new Map<string,{id:string;actor:string;expires:number;removal:Removal}>();
/** 実際のnpmシム（Shim）が指定パッケージを参照する場合だけ削除を許可します。 */
async function removalPlan(id:string):Promise<Removal|undefined>{
  const item=AGENT_CATALOG.find(agent=>agent.id===id);
  if(item?.install?.method!=='npm')return undefined;
  const source=await resolveAgentExecutable(item.cli);
  if(!source||!source.toLowerCase().endsWith('.cmd'))return undefined;
  const target=item.install.arguments[2].replace(/@latest$/,'');
  const shim=await readFile(source,'utf8');
  if(!shim.replace(/\\/g,'/').includes('node_modules/'+target+'/'))return undefined;
  const npmCli=path.join(path.dirname(source),'node_modules/npm/bin/npm-cli.js');
  await readFile(npmCli,'utf8');
  const manifest=JSON.parse(await readFile(path.join(path.dirname(source),'node_modules',target,'package.json'),'utf8'));
  if(manifest.name!==target)return undefined;
  return {executable:process.execPath,args:[npmCli,'uninstall','-g','--ignore-scripts','--prefix',path.dirname(source),target],target,source};
}
/** 削除対象を画面へ提示し、管理者と対象に紐付けた短期承認を発行します。 */
export async function prepareAgentUninstall(id:string,actor:string){
  const removal=await removalPlan(id).catch(()=>undefined);
  if(!removal)return {supported:false,reason:'CLIの導入元を安全に特定できません。Wentianの登録解除を選ぶか、CLI本体は導入元のアンインストーラーで削除してください。'};
  for(const [token,value] of approvals)if(value.expires<Date.now())approvals.delete(token);
  const token=randomUUID();approvals.set(token,{id,actor,expires:Date.now()+300000,removal});
  return {supported:true,token,target:removal.target,source:removal.source};
}
export async function executeAgentUninstall(id:string,actor:string,token:string){
  const approval=approvals.get(token);approvals.delete(token);
  if(!approval||approval.id!==id||approval.actor!==actor||approval.expires<Date.now())throw new Error('削除の確認が無効または期限切れです。');
  const current=await removalPlan(id);
  if(!current||JSON.stringify(current)!==JSON.stringify(approval.removal))throw new Error('導入元が変更されています。削除対象を再確認してください。');
  await run(current.executable,current.args,{timeout:120000,windowsHide:true,maxBuffer:1024*1024});
  if(await resolveAgentExecutable(AGENT_CATALOG.find(item=>item.id===id)!.cli))throw new Error('別のCLIが残っています。登録を維持しました。導入元を再確認してください。');
}
