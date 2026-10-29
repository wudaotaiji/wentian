import { CloudError, type AppSpec, type CloudNode, type CloudApp } from './types.js';

/** 配置判断（Placement）はAIモデル評価と分離し、不適合ノードを採点前に除外します。 */
export function rankNodes(nodes:CloudNode[],apps:CloudApp[],spec:AppSpec,ownerId:string,now=Date.now()) {
  return nodes.filter(n=>n.ownerId===ownerId).map(node=>{
    const c=node.capabilities,reasons:string[]=[];
    if(!node.approved||node.revoked)reasons.push('未承認または失効済み');
    if(!node.lastSeenAt||now-Date.parse(node.lastSeenAt)>45000)reasons.push('接続状態が不明');
    if(!c?.runtimes.some(r=>r.engine===spec.engine&&r.ready))reasons.push('実行環境が未準備');
    if(spec.arch&&c?.arch!==spec.arch)reasons.push('CPUアーキテクチャが不一致');
    const reserved=apps.filter(a=>a.nodeId===node.id&&a.state!=='stopped'&&a.state!=='deleted');
    const memory=reserved.reduce((n,a)=>n+a.spec.memoryBytes,0),cpu=reserved.reduce((n,a)=>n+a.spec.cpuCores,0);
    // 空き実測値と論理予約の小さい方を採用し、RAMをGPUメモリへ代用しません。
    const freeMemory=Math.min(c?.freeMemoryBytes||0,Math.max(0,(c?.memoryBytes||0)-memory));
    if(spec.memoryBytes>freeMemory)reasons.push('予約可能なRAMが不足');
    if(spec.cpuCores>(c?.cpuCores||0)-cpu)reasons.push('予約可能なCPUが不足');
    const gpu=c?.gpus.find(g=>g.verified&&g.engines?.includes(spec.engine)&&g.freeBytes-reserved.filter(a=>a.gpuIndex===g.index).reduce((n,a)=>n+a.spec.gpuMemoryBytes,0)>=spec.gpuMemoryBytes);
    if(spec.gpuMemoryBytes&&!gpu)reasons.push('検証済みGPU資源が不足');
    return {nodeId:node.id,name:node.name,eligible:!reasons.length,reasons,freeMemoryBytes:freeMemory,gpuIndex:spec.gpuMemoryBytes?gpu?.index:undefined,score:reasons.length?0:freeMemory};
  }).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||b.score-a.score||a.nodeId.localeCompare(b.nodeId));
}

/** 配備仕様（Deployment Specification）を限定し、任意の実行オプションを受け付けません。 */
export function validateSpec(input:unknown):AppSpec {
  if(!input||typeof input!=='object')throw new CloudError('配備設定を入力してください。');
  const x=input as Record<string,unknown>;
  const allowed=['name','image','engine','containerPort','healthPath','cpuCores','memoryBytes','gpuMemoryBytes','arch','environment'];
  if(Object.keys(x).some(k=>!allowed.includes(k)))throw new CloudError('未対応の配備設定が含まれています。');
  if(typeof x.name!=='string'||!x.name.trim()||x.name.length>100)throw new CloudError('アプリ名は1～100文字です。');
  if(typeof x.image!=='string'||x.image.length>300||! /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(x.image))throw new CloudError('イメージ名が不正です。');
  const engine=x.engine||'docker';if(engine!=='docker'&&engine!=='podman')throw new CloudError('DockerまたはPodmanを指定してください。');
  const containerPort=Number(x.containerPort),cpuCores=Number(x.cpuCores??1),memoryBytes=Number(x.memoryBytes??536870912),gpuMemoryBytes=Number(x.gpuMemoryBytes??0);
  if(!Number.isInteger(containerPort)||containerPort<1||containerPort>65535||!Number.isFinite(cpuCores)||cpuCores<0.1||cpuCores>128||!Number.isSafeInteger(memoryBytes)||memoryBytes<16*1024*1024||memoryBytes>1024**4||!Number.isSafeInteger(gpuMemoryBytes)||gpuMemoryBytes<0)throw new CloudError('ポートまたは資源上限が不正です。');
  const healthPath=x.healthPath??'/health';if(typeof healthPath!=='string'||!/^\/[a-zA-Z0-9/_.?=&%-]*$/.test(healthPath)||healthPath.startsWith('//')||healthPath.length>300)throw new CloudError('正常性確認パスが不正です。');
  const environment=x.environment??{};
  if(!environment||typeof environment!=='object'||Array.isArray(environment)||Object.keys(environment).length>32)throw new CloudError('環境変数は32件以内です。');
  for(const [k,v] of Object.entries(environment))if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)||typeof v!=='string'||v.length>4096||/secret|token|password|credential|api_key/i.test(k))throw new CloudError('秘密情報は環境変数欄へ保存できません。');
  if(x.arch!==undefined&&!['x64','arm64'].includes(String(x.arch)))throw new CloudError('対応アーキテクチャはx64、arm64です。');
  return {name:x.name.trim(),image:x.image,engine,containerPort,healthPath,cpuCores,memoryBytes,gpuMemoryBytes,environment:environment as Record<string,string>,...(x.arch?{arch:String(x.arch)}:{})};
}
