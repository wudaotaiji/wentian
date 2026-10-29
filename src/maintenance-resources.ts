import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface MaintenanceResources { cpu: number; memory: number; network: number; disk: number; diskCapacity?: number }
export type MaintenanceResourceState = 'normal' | 'warning' | 'paused' | 'unknown';
/** 資源停止後は最低1分待ち、連続停止時は最大15分まで延長します。利用者の長い待機設定は維持します。 */
export function resourceRetryDelay(failures: number, configuredMs = 30000): number {
  return Math.max(configuredMs, Math.min(900000, 60000 * 2 ** Math.min(4, Math.max(0, failures - 1))));
}
/** 80%で警告、90%で停止します。再開も全項目90%未満の共通判定を使います。 */
export function maintenanceResourceState(value: MaintenanceResources | undefined): MaintenanceResourceState {
  if (!value || ![value.cpu, value.memory, value.network, value.disk].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) return 'unknown';
  // 旧形式の模擬計測とも互換を保ちます。実計測では容量使用率を必ず取得します。
  if (value.diskCapacity !== undefined && (!Number.isFinite(value.diskCapacity) || value.diskCapacity < 0 || value.diskCapacity > 100)) return 'unknown';
  const maximum = Math.max(value.cpu, value.memory, value.network, value.disk, value.diskCapacity ?? 0);
  return maximum >= 90 ? 'paused' : maximum >= 80 ? 'warning' : 'normal';
}
export class MaintenanceResourcePause extends Error {
  constructor(public readonly state: MaintenanceResourceState, value?: MaintenanceResources) { super(state === 'unknown' ? '資源使用率を確認できないため保守を一時停止します。' : state === 'warning' ? '資源使用率が90%未満に回復するまで保守の停止を継続します。' : (value?.diskCapacity ?? 0) >= 90 ? 'ディスク容量使用率が90%以上のため保守を一時停止します。空き容量を確保してください。' : '資源使用率が90%以上のため保守を一時停止します。'); }
}

/** 開始前と実行中を監視し、停止を既存の子プロセス終了処理へ伝播します。計測は重複しません。 */
export async function withMaintenanceResources<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal,
  measure = measureMaintenanceResources, notify: (state: MaintenanceResourceState, value?: MaintenanceResources) => void = () => {}, intervalMs = 5000): Promise<T> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let sampling = false;
  let finished = false;
  const check = async () => {
    const value = await measure().catch(() => undefined);
    if (finished || signal?.aborted) return;
    const state = maintenanceResourceState(value);
    try { notify(state, value); } catch (error) { controller.abort(error); }
    if (state === 'paused' || state === 'unknown') controller.abort(new MaintenanceResourcePause(state, value));
  };
  combined.throwIfAborted();
  await check();
  combined.throwIfAborted();
  const timer = setInterval(() => {
    if (sampling || combined.aborted) return;
    sampling = true;
    void check().finally(() => { sampling = false; });
  }, intervalMs);
  timer.unref?.();
  try { const result = await run(combined); combined.throwIfAborted(); return result; }
  catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
  finally { finished = true; clearInterval(timer); }
}
export interface ResourceMeasurementInfo {checkedAt:string;elapsedMs:number;failure?:'timeout'|'execution'|'invalid'|'unsupported';reason?:string}
export const RESOURCE_MEASUREMENT_TIMEOUT_MS=30000;
/** 取得失敗を隠さず記録します。OSの生エラーやホスト情報は管理APIへ返しません。 */
export function createResourceCollector(dependencies:Partial<{
  platform:NodeJS.Platform;now:()=>number;
  run:(timeoutMs:number,done:(error:(Error&{killed?:boolean;code?:string})|null,output:string)=>void)=>void;
}>={}){
  const platform=dependencies.platform||process.platform,now=dependencies.now||Date.now;
  const run=dependencies.run||((timeout,done)=>{execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('../scripts/measure-maintenance-resources.ps1',import.meta.url))],{timeout,windowsHide:true},(error,stdout)=>done(error as (Error&{killed?:boolean;code?:string})|null,stdout));});
  let measurement:Promise<MaintenanceResources|undefined>|undefined,info:ResourceMeasurementInfo|undefined;
  const reasons={timeout:'資源計測が30秒の待機上限を超えました。',execution:'Windowsの資源計測コマンドに失敗しました。',invalid:'資源計測の結果が欠落または不正です。',unsupported:'このOSでは資源計測に対応していません。'};
  const measure=():Promise<MaintenanceResources|undefined>=>measurement ||= new Promise<MaintenanceResources|undefined>(resolve=>{
    const started=now();
    const finish=(value?:MaintenanceResources,failure?:ResourceMeasurementInfo['failure'])=>{info={checkedAt:new Date(now()).toISOString(),elapsedMs:now()-started,...(failure?{failure,reason:reasons[failure]}:{})};resolve(value);};
    if(platform!=='win32'){finish(undefined,'unsupported');return;}
    try{run(RESOURCE_MEASUREMENT_TIMEOUT_MS,(error,stdout)=>{
      if(error){finish(undefined,error.killed||error.code==='ETIMEDOUT'?'timeout':'execution');return;}
      try{const value=JSON.parse(stdout) as MaintenanceResources;
        if(value.diskCapacity===undefined||maintenanceResourceState(value)==='unknown'){finish(undefined,'invalid');return;}
        finish(value);
      }catch{finish(undefined,'invalid');}
    });}catch{finish(undefined,'execution');}
  }).finally(()=>{measurement=undefined;});
  return{measure,latest:()=>info};
}
const resourceCollector=createResourceCollector();
// 複数の保守・画面更新が同時に確認しても、計測用PowerShellは一つだけ起動します。
export const measureMaintenanceResources=resourceCollector.measure;
export const latestResourceMeasurement=resourceCollector.latest;
/** 保守は常に直列実行し、90%以上・未計測では新しい処理を開始しません。 */
export async function runResourceLimited<T>(items: T[], run: (item: T) => Promise<void>, signal?: AbortSignal,
  measure = measureMaintenanceResources): Promise<void> {
    for (const item of items) {
      signal?.throwIfAborted();
      const resources = await measure().catch(() => undefined);
      const state = maintenanceResourceState(resources);
      if (state === 'paused' || state === 'unknown') throw new MaintenanceResourcePause(state, resources);
      signal?.throwIfAborted();
      await run(item);
    }
}
