import { mkdir } from 'node:fs/promises';
import { maintenanceWorkspaces } from './maintenance-workspaces.js';
import { MAINTENANCE_EXECUTION } from './maintenance-execution.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExternalCommand } from './external-orchestrator.js';
import { maintenancePythonCommand } from './maintenance-python.js';

export interface NativeAgentModel { model: string; provider?: string }
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
/** 設定を変更せず、秘密値を出力しないブリッジからモデル項目だけを受け取ります。 */
export async function configuredAgentModels(agent:string,signal?:AbortSignal,run:typeof runExternalCommand=runExternalCommand):Promise<NativeAgentModel[]> {
  const workspace=maintenanceWorkspaces().connection;
  await mkdir(workspace,{recursive:true});
  if (agent === 'lmstudio') {
    const output = await run({executable:'lms',args:['ls','--json']},{cwd:workspace,timeoutMs:15000,idleTimeoutMs:15000,agent,role:'model-settings-read',signal,maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION});
    const rows = JSON.parse(output);
    if (!Array.isArray(rows)) throw new Error('LM Studioのモデル一覧形式が不正です。');
    return rows.filter(item => item.type === 'llm' && typeof item.modelKey === 'string').map(item => ({model:item.modelKey}));
  }
  if (agent === 'ollama') {
    const output = await run({ executable: 'ollama', args: ['list'] }, { cwd: workspace, timeoutMs: 15000, idleTimeoutMs: 15000, agent, role: 'model-settings-read', signal,maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION });
    return output.trim().split(/\r?\n/).slice(1).map(line => ({ model: line.trim().split(/\s+/)[0] })).filter(item => /^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]{0,255}$/.test(item.model));
  }
  const python=maintenancePythonCommand();
  const output=await run({executable:python.executable,args:[...python.args,path.join(root,'scripts/list-agent-models.py'),'--agent',agent]},
    {cwd:workspace,timeoutMs:15000,idleTimeoutMs:15000,agent,role:'model-settings-read',signal,maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION});
  const value=JSON.parse(output);
  if(!Array.isArray(value.models))throw new Error('設定モデルの一覧形式が不正です。');
  const models:NativeAgentModel[]=value.models.filter((item:NativeAgentModel)=>typeof item.model==='string');
  if(agent==='goose'){
    // Goose公式のCLIプロバイダーで既存認証を再利用します。認証値のコピーや新規契約は行いません。
    // 未設定のモデルを作らず、利用者が実際に設定したCodexモデルだけを追加します。
    const codex=await configuredAgentModels('codex',signal,run).catch(()=>[]);
    for(const item of codex)if(!models.some(model=>model.provider==='codex'&&model.model===item.model))models.push({model:item.model,provider:'codex'});
  }
  return models;
}
