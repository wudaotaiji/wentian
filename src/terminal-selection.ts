import type {ExternalAgentStatus} from './external-agents.js';
import {conversationAllowsExecution} from './agent-connection-policy.js';
import {cliText} from './cli-language.js';
import {readAgentManagement,setForcedAgent} from './agent-management.js';
import {readReadySnapshot} from './external-agent-readiness.js';
import {loadExternalAgentSnapshot} from './external-agents.js';
import {conversationRunnerAgents} from './group-agent-responder.js';
import {explicitAgentAllowed} from './agent-exclusion-policy.js';
import {loadAgentSelectionConfig} from './agent-selection.js';
import {performanceScore} from './agent-performance.js';

export interface TerminalChoice {id:string;label:string;detail:string;disabled?:boolean}
export interface TerminalSelection {kind:'model'|'agent';choices:TerminalChoice[];index:number}
/** 一覧は表示用のプロトコル選択です。通常の質問文の意図分類には使用しません。 */
export function selectionMenu(kind:TerminalSelection['kind'],choices:TerminalChoice[],current?:string):TerminalSelection{
 const found=choices.findIndex(choice=>choice.id===current&&!choice.disabled);
 return{kind,choices,index:found>=0?found:choices.findIndex(choice=>!choice.disabled)};
}
export function navigateSelection(menu:TerminalSelection,direction:-1|1):string|null{
 if(!menu.choices.some(choice=>!choice.disabled))return null;
 for(let count=0;count<menu.choices.length;count++){
  menu.index=(menu.index+direction+menu.choices.length)%menu.choices.length;
  if(!menu.choices[menu.index].disabled)return`/${menu.kind} ${menu.choices[menu.index].id}`;
 }
 return null;
}
export function selectedChoice(menu:TerminalSelection,input:string):TerminalChoice{
 const choice=!input.trim()?menu.choices[menu.index]:/^\d+$/.test(input.trim())?menu.choices[Number(input.trim())-1]:menu.choices.find(item=>item.id===input.trim());
 if(!choice)throw Error(cliText('一覧にない選択です。番号またはIDを指定してください。'));
 if(choice.disabled)throw Error(cliText('この項目は選択できません: {0}',choice.detail));
 return choice;
}
export function formatSelection(menu:TerminalSelection,current?:string):string{
 return[cliText(menu.kind==='model'?'モデルを選択':'外部Agentを選択'),...menu.choices.map((choice,index)=>`${index+1}. ${choice.id===current?'●':'○'} ${choice.label} [${choice.id}] — ${choice.detail}`),cliText('↑↓で選択・Enterで確定。番号またはIDも入力できます。Ctrl+Cで取消。')].join('\n');
}
/** Gatewayが公開したモデルIDだけを受け取り、利用終了モデルは表示しても選択させません。 */
export async function modelChoices(server:string,fetcher:typeof fetch=fetch):Promise<TerminalChoice[]>{
 const response=await fetcher(`${server.replace(/\/$/,'')}/v1/models`,{headers:process.env.WENTIAN_API_KEY?{authorization:`Bearer ${process.env.WENTIAN_API_KEY}`}:{},signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error(cliText('モデル一覧の取得に失敗しました: HTTP {0}',response.status));
 const payload=await response.json() as {data?:Array<{id?:unknown;name?:unknown;available?:boolean;unavailableReason?:string}>};
 if(!Array.isArray(payload.data))throw Error(cliText('モデル一覧の形式が不正です。'));
 const seen=new Set<string>();
 return payload.data.filter(item=>typeof item.id==='string'&&item.id.length>0&&!seen.has(item.id)&&Boolean(seen.add(item.id))).map(item=>({id:item.id as string,label:typeof item.name==='string'?item.name:item.id as string,disabled:item.available===false,detail:item.available===false?item.unavailableReason||cliText('利用不可'):cliText('登録済み')}));
}
/** 会話可能性と業務検証を混同せず、接続が有効なAgentを優先指定できます。 */
export function agentChoices(agents:ExternalAgentStatus[]):TerminalChoice[]{
 const config=loadAgentSelectionConfig();
 return[{id:'auto',label:cliText('自動選択'),detail:cliText('外部Agentの優先指定を解除')},...agents.map(agent=>{
  const reason=!conversationRunnerAgents.has(agent.id)?cliText('会話コマンド未対応'):!explicitAgentAllowed(agent.id)||config.apiFallbackExcludedAgents.includes(agent.id)?cliText('設定で除外されています。'):!conversationAllowsExecution(agent)?cliText('接続未確認・期限切れ'):!Number.isFinite(performanceScore(agent.id,'conversation'))?cliText('会話失敗後の再試行待ち'):undefined;
  return{id:agent.id,label:agent.name||agent.id,disabled:Boolean(reason),detail:[agent.connection?.model||cliText('未確認'),reason||cliText('接続確認済み')].join(' · ')};
 })];
}

/** 対話・非TTY双方から同じ検証と保存処理を使用します。 */
export async function executeSelectionCommand(kind:TerminalSelection['kind'],argument:string,server:string,model:string){
 const currentAgent=readAgentManagement().forcedAgent;
 if(kind==='agent'&&argument==='auto'){if(currentAgent)await setForcedAgent(currentAgent,false);return{model,output:cliText('優先Agent: {0}',cliText('自動選択'))};}
 const choices=kind==='model'?await modelChoices(server):agentChoices((await readReadySnapshot())?.agents||(await loadExternalAgentSnapshot({probeLive:false})).agents);
 const menu=selectionMenu(kind,choices,kind==='model'?model:currentAgent||'auto');
 if(!argument)return{menu,model,output:formatSelection(menu,kind==='model'?model:currentAgent||'auto')};
 const choice=selectedChoice(menu,argument);
 if(kind==='model'){
  if(currentAgent)await setForcedAgent(currentAgent,false);
  return{model:choice.id,output:cliText('現在のモデル: {0}',choice.id)};
 }
 if(choice.id==='auto'){if(currentAgent)await setForcedAgent(currentAgent,false);}
 else await setForcedAgent(choice.id,true);
 return{model,output:cliText('優先Agent: {0}',choice.id==='auto'?cliText('自動選択'):choice.id)};
}
