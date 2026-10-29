import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {agentRegistrationStorePath} from './agent-exclusion-policy.js';
import {renameWithRetry} from './atomic-file.js';
import {validateManualAgent,type ManualAgentDefinition} from './manual-agent-registry.js';

interface Management {version:1;order:string[];uninstalled:Record<string,ManualAgentDefinition>;deleted:string[];forcedAgent?:string}
const validId=(id:string)=>/^[a-z0-9][a-z0-9_-]{1,39}$/.test(id);
export const agentManagementPath=()=>process.env.WENTIAN_AGENT_MANAGEMENT_FILE||path.join(path.dirname(agentRegistrationStorePath()),'agent-management.json');
/** 順位と解除済みの登録情報を保存し、CLI本体・認証情報は格納しません。 */
export function readAgentManagement():Management{
  try{const value=JSON.parse(readFileSync(agentManagementPath(),'utf8'));return {version:1,order:[...new Set<string>((value.order||[]).filter((id:unknown)=>typeof id==='string'&&validId(id)))],uninstalled:Object.fromEntries(Object.entries(value.uninstalled||{}).map(([id,item])=>[id,validateManualAgent(item)])),deleted:(value.deleted||[]).filter(validId),...(typeof value.forcedAgent==='string'&&validId(value.forcedAgent)?{forcedAgent:value.forcedAgent}:{})};}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,order:[],uninstalled:{},deleted:[]};throw error;}
}
async function save(value:Management){const target=agentManagementPath();await mkdir(path.dirname(target),{recursive:true});const temporary=target+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600});await renameWithRetry(temporary,target);}
/** 順位を設定するまでは既存の実測による選択を保ちます。 */
export function compareAgentPriority(left:string,right:string){const order=readAgentManagement().order;const rank=(id:string)=>{const index=order.indexOf(id);return index<0?Number.MAX_SAFE_INTEGER:index;};return rank(left)-rank(right);}
/** 一つだけ明示優先にし、解除時は別行の設定を消しません。接続や能力の検査は選択側で維持します。 */
export async function setForcedAgent(id:string,enabled:boolean){if(!validId(id))throw new Error('Agent IDが不正です。');const value=readAgentManagement();if(enabled)value.forcedAgent=id;else if(value.forcedAgent===id)delete value.forcedAgent;await save(value);}
export function compareForcedAgentPriority(left:string,right:string,forced=readAgentManagement().forcedAgent){return Number(right===forced)-Number(left===forced);}
export function orderAgents<T extends {id:string}>(agents:T[]):T[]{return [...agents].sort((a,b)=>compareAgentPriority(a.id,b.id));}
export async function moveAgentPriority(id:string,direction:'up'|'down',registered:string[]){
  const value=readAgentManagement();const order=orderAgents(registered.map(id=>({id}))).map(item=>item.id);const index=order.indexOf(id);if(index<0)throw new Error('登録されたエージェントが見つかりません。');const other=index+(direction==='up'?-1:1);if(other>=0&&other<order.length)[order[index],order[other]]=[order[other],order[index]];value.order=order;await save(value);
}
export async function archiveAgent(definition:ManualAgentDefinition){const value=readAgentManagement();value.uninstalled[definition.id]=validateManualAgent(definition);value.order=value.order.filter(id=>id!==definition.id);value.deleted=value.deleted.filter(id=>id!==definition.id);if(value.forcedAgent===definition.id)delete value.forcedAgent;await save(value);}
export async function restoreAgent(id:string){const value=readAgentManagement();delete value.uninstalled[id];value.deleted=value.deleted.filter(item=>item!==id);await save(value);}
export async function deleteArchivedAgent(id:string){const value=readAgentManagement();if(!value.uninstalled[id])throw new Error('解除済みの登録情報が見つかりません。');delete value.uninstalled[id];value.deleted=[...new Set([...value.deleted,id])];value.order=value.order.filter(item=>item!==id);await save(value);}
