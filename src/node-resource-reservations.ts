import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface NodeReservation {appId:string;memoryBytes:number;gpuMemoryBytes:number;gpuIndex?:number}
/** 同じPCのアプリ予約をAIの入場判断（Admission Control）にも反映します。 */
export async function readNodeReservations(file=process.env.WENTIAN_NODE_RESERVATIONS_FILE||path.join(process.env.WENTIAN_NODE_HOME||path.join(os.homedir(),'.wentian','node'),'resources.json')):Promise<NodeReservation[]>{
  try{const data=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(data.reservations))throw new Error('形式が不正です。');return data.reservations.filter((r:NodeReservation)=>typeof r.appId==='string'&&Number.isSafeInteger(r.memoryBytes)&&r.memoryBytes>=0&&Number.isSafeInteger(r.gpuMemoryBytes)&&r.gpuMemoryBytes>=0);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw new Error('端末資源予約を読み込めません。予約台帳を確認してください。');}
}
