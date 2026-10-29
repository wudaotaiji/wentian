import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameWithRetry } from './atomic-file.js';

export type MaintenanceControlKey = 'connection' | 'media';
export type MaintenanceControls = Partial<Record<MaintenanceControlKey,boolean>>;
export function maintenanceControlsPath(): string {
  return process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(),'.wentian','maintenance-controls.json');
}
function validate(value: unknown): MaintenanceControls {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('保守の実行許可はオブジェクトで指定してください。');
  for (const [key,item] of Object.entries(value)) if (!['connection','media'].includes(key) || typeof item!=='boolean') throw new Error('保守の実行許可はconnection・mediaの真偽値で指定してください。');
  return value as MaintenanceControls;
}
function readControls(): MaintenanceControls {
  try { return validate(JSON.parse(readFileSync(maintenanceControlsPath(),'utf8'))); }
  catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return {}; throw error; }
}
/** 管理者が画面で明示した許可を優先します。環境変数は未設定項目の初期値です。 */
export function maintenanceControlStatus() {
  let saved: MaintenanceControls={},error: string|undefined;
  try { saved=readControls(); } catch { error='保守の実行許可ファイルを読み取れないため、実行を禁止しています。'; }
  const entry=(key:MaintenanceControlKey,env:string)=>({allowed:!error&&(saved[key]??process.env[env]!=='false'),
    source:error?'error':saved[key]!==undefined?'management':process.env[env]!==undefined?'environment':'default',
    environmentAllowed:process.env[env]!=='false'});
  return {connection:entry('connection','WENTIAN_AGENT_CONNECTION_MAINTENANCE'),media:entry('media','WENTIAN_MEDIA_MODEL_MAINTENANCE'),error};
}
let saving: Promise<unknown>=Promise.resolve();
export function saveMaintenanceControls(patch: unknown): Promise<ReturnType<typeof maintenanceControlStatus>> {
  const changes=validate(patch);
  if (!Object.keys(changes).length) return Promise.reject(new Error('変更する実行許可を指定してください。'));
  const job=saving.catch(()=>{}).then(async()=>{
    // 破損した設定を黙って上書きせず、既存の利用者設定を保護します。
    const next={...readControls(),...changes},target=maintenanceControlsPath();
    await mkdir(path.dirname(target),{recursive:true});
    const temporary=`${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify(next,null,2)+'\n','utf8');await renameWithRetry(temporary,target);
    return maintenanceControlStatus();
  });
  saving=job;return job;
}
