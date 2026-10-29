import { mkdir } from 'node:fs/promises';
import { maintenanceWorkspaces } from './maintenance-workspaces.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { connectionStorePath, isFreeAgentModel, readAgentConnections, type ConnectionMode } from './agent-connection-policy.js';
import { configuredAgentModels, type NativeAgentModel } from './agent-native-models.js';

export interface AgentModelPreference {
  /** 明示的に有効にした場合だけ固定します。旧設定のモデル名だけでは固定しません。 */
  manual?: boolean;
  source: 'free' | 'wentian' | 'other'; mode: ConnectionMode; model: string;
  baseUrl?: string; selectedAt: string;
  provider?: string;
}
export function manualModelPreference(agent:string):AgentModelPreference|undefined {
  const preference=readModelPreferences()[agent];return preference?.manual===true?preference:undefined;
}
/** 切替時も以前のモデルと接続先を残し、自動復旧を選んでも秘密設定を消しません。 */
export function setManualModelSelection(agent:string,manual:boolean):void {
  const saved=readModelPreferences()[agent];
  const current=manual&&!saved?.model?readAgentConnections()[agent]:undefined;
  // 固定を有効にしただけで、表示中の選択済みモデルを空欄へ戻しません。
  const preference:AgentModelPreference=current?.model?{source:current.source||(current.mode==='free'?'free':'other'),mode:current.mode,model:current.model,provider:current.provider,baseUrl:current.baseUrl,selectedAt:''}:saved||{source:'other',mode:'native',model:'',selectedAt:''};
  saveModelPreference(agent,{...preference,manual,selectedAt:new Date().toISOString()});
}
export interface AgentModelChoice {
  id: string; source: AgentModelPreference['source']; mode: ConnectionMode; model: string; label: string;
  provider?: string;
}

/** モデル選択をCLI（コマンドライン / CLI）と常駐保守で共有し、再起動後も保持します。 */
export function modelPreferencePath(): string {
  return process.env.WENTIAN_AGENT_MODEL_PREFERENCES || path.join(path.dirname(connectionStorePath()), 'agent-model-preferences.json');
}
export function readModelPreferences(): Record<string, AgentModelPreference> {
  try { return JSON.parse(readFileSync(modelPreferencePath(), 'utf8')).agents || {}; } catch { return {}; }
}
export function saveModelPreference(agent: string, preference: AgentModelPreference): void {
  const target = modelPreferencePath();
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ version: 1, agents: { ...readModelPreferences(), [agent]: preference } }, null, 2) + '\n', 'utf8');
  renameSync(temporary, target);
}

/** モデルの完全IDを保ち、無料・Wentian・その他で同名モデルを混同しません。 */
export function buildModelChoices(agent: string, native: string[], internal: Array<{ id: string; name?: string }>, configured:NativeAgentModel[]=[]): AgentModelChoice[] {
  const values: AgentModelChoice[] = native.filter(model => /^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]{0,255}$/.test(model)).map(model => ({
    id: `${isFreeAgentModel(agent, model) ? 'free' : 'other'}:${model}`,
    source: isFreeAgentModel(agent, model) ? 'free' : 'other',
    mode: isFreeAgentModel(agent, model) ? 'free' : 'native', model, label: model,
  }));
  for(const item of configured){
    if(!/^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]{0,255}$/.test(item.model))continue;
    const free=isFreeAgentModel(agent,item.model);
    values.push({id:`${free?'free':'other'}:${item.provider?item.provider+':':''}${item.model}`,source:free?'free':'other',mode:free?'free':'native',model:item.model,provider:item.provider,label:item.provider?`${item.model} (${item.provider})`:item.model});
  }
  for (const model of internal) {
    // Codexのネイティブ接続はResponses APIを使うため、Chat Completions専用候補を混ぜません。
    if(agent==='codex'||agent==='ollama'||agent==='lmstudio')continue;
    if (model.id.startsWith('wentian-agent/')) continue;
    values.push({ id: `wentian:${model.id}`, source: 'wentian', mode: 'local', model: model.id, label: model.name && model.name !== model.id ? `${model.id} (${model.name})` : model.id });
  }
  return [...new Map(values.map(value => [value.id, value])).values()];
}

// 一覧取得でCLIを毎回起動しないよう、モデル候補だけを5分間キャッシュ（Cache）します。
const nativeCache = new Map<string, { expires: number; models: string[]; configured:NativeAgentModel[]; warning?: string }>();
export async function agentModelChoices(agent: string, internal: Array<{ id: string; name?: string }>, refresh=false) {
  let cached = nativeCache.get(agent);
  if(refresh)cached=undefined;
  if (!cached || cached.expires <= Date.now()) {
    try {
      const { discoverAgentModels } = await import('./agent-connection-maintenance.js');
      const workspace=maintenanceWorkspaces().connection;await mkdir(workspace,{recursive:true});
      const results=await Promise.allSettled([discoverAgentModels(agent, workspace),configuredAgentModels(agent)]);
      const models=results[0].status==='fulfilled'?results[0].value||[]:[];
      const configured=results[1].status==='fulfilled'?results[1].value:[];
      cached = { expires: Date.now() + 300_000, models, configured, ...(!models.length&&!configured.length?{warning:'Agent側のモデル候補を確認できませんでした。接続設定またはCLIの対応状況を確認してください。'}:{}) };
    } catch {
      cached = { expires: Date.now() + 60_000, models: [], configured:[], warning: 'Agent側のモデル一覧を取得できませんでした。接続設定を確認してください。' };
    }
    nativeCache.set(agent, cached);
  }
  return { choices: buildModelChoices(agent, cached.models, internal, cached.configured), warning: cached.warning };
}
