import path from 'node:path';
import os from 'node:os';
import { diagnoseNode } from './runtime.js';
import { enrollNode, runNodeAgent } from './agent.js';
import { verifyContainerGpu } from './gpu.js';

/** 利用者PCのAgent（Node Agent）を既存の作業用Agentと別コマンドで運用します。 */
export async function cloudNodeCommand(args:string[]){
  const value=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
  const root=path.resolve(value('--directory')||process.env.WENTIAN_NODE_HOME||path.join(os.homedir(),'.wentian','node'));
  if(args[0]==='diagnose'){console.log(JSON.stringify(await diagnoseNode(undefined,root),null,2));return;}
  if(args[0]==='verify-gpu'){const engine=value('--engine')||'docker';if(engine!=='docker'&&engine!=='podman')throw new Error('DockerまたはPodmanを指定してください。');console.log(JSON.stringify(await verifyContainerGpu(root,engine),null,2));return;}
  if(args[0]==='enroll'){
    const server=value('--server')||process.env.WENTIAN_CLOUD_URL,code=process.env.WENTIAN_NODE_ENROLL_CODE;
    if(!server||!code)throw new Error('接続先--serverと環境変数WENTIAN_NODE_ENROLL_CODEを指定してください。');
    console.log(JSON.stringify(await enrollNode(root,server,code),null,2));return;
  }
  if(args[0]==='run'){
    const controller=new AbortController(),stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    console.log('Wentian端末Agentを起動します。終了するにはCtrl+Cを押してください。');
    try{await runNodeAgent(root,controller.signal)}finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop)}return;
  }
  console.log('wentian node diagnose\nwentian node enroll --server URL [--directory DIR]\nwentian node run [--directory DIR]\n登録コードは環境変数WENTIAN_NODE_ENROLL_CODEへ設定してください。');
}
