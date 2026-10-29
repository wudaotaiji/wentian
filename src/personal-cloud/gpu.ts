import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CloudError, iso, type Engine } from './types.js';
import { runCommand, type CommandRunner } from './runtime.js';

export interface GpuProof {engine:Engine;index:number;name:string;at:string}
/** GPUの利用検証（GPU Verification）を実コンテナで行い、認識しただけのGPUと区別します。 */
export async function verifyContainerGpu(root:string,engine:Engine,run:CommandRunner=runCommand){
  if(!['docker','podman'].includes(engine))throw new CloudError('GPU検証の実行環境が不正です。');
  // 先にホストのNVIDIA認識を確認し、GPUがないPCではイメージ取得を開始しません。
  await run('nvidia-smi',['--query-gpu=index,name','--format=csv,noheader,nounits'],10000);
  const image='docker.io/nvidia/cuda:12.9.0-base-ubuntu22.04';await run(engine,['pull',image],600000);
  const device=engine==='docker'?['--gpus','all']:['--device','nvidia.com/gpu=all'];
  const output=await run(engine,['run','--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges',...device,image,'nvidia-smi','--query-gpu=index,name','--format=csv,noheader,nounits'],60000);
  const proofs:GpuProof[]=output.trim().split(/\r?\n/).map(line=>{const [index,...name]=line.split(',').map(v=>v.trim());return {engine,index:Number(index),name:name.join(','),at:iso()};}).filter(p=>Number.isInteger(p.index)&&p.index>=0&&!!p.name);
  if(!proofs.length)throw new CloudError('コンテナからGPUの利用を確認できませんでした。');
  await mkdir(root,{recursive:true,mode:0o700});const existing=await readGpuProofs(root);await writeFile(path.join(root,'gpu-verification.json'),JSON.stringify([...existing.filter(p=>p.engine!==engine),...proofs]),{mode:0o600});return {engine,proofs};
}
/** 24時間を超えた証拠は再検証を要求し、古いドライバー設定を永久に信頼しません。 */
export async function readGpuProofs(root:string):Promise<GpuProof[]>{try{const data=JSON.parse(await readFile(path.join(root,'gpu-verification.json'),'utf8'));return Array.isArray(data)?data.filter(p=>Date.now()-Date.parse(p.at)<86400000&&Date.parse(p.at)<=Date.now()&&Number.isInteger(p.index)&&['docker','podman'].includes(p.engine)):[];}catch{return [];}}
