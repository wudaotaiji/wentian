import {existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** エージェント専用ランタイム（Runtime）の保存先。PC全体のNode.jsは置換しません。 */
export const agentRuntimeRoot=()=>path.join(process.env.WENTIAN_INSTALL_ROOT||process.cwd(),'.wentian','agent-runtime');
export function agentNodeExecutable():string{
  try{
    const entry=JSON.parse(readFileSync(path.join(agentRuntimeRoot(),'node-runtime.json'),'utf8'));
    const executable=path.resolve(entry.executable);
    if(executable.startsWith(path.resolve(agentRuntimeRoot())+path.sep)&&existsSync(executable))return executable;
  }catch{/* 未準備の場合は現在の実行環境を使います。 */}
  return process.execPath;
}
/** 常駐開始後に導入したCLIも、既知のユーザー単位の導入先から検出します。 */
export function agentSearchDirectories(env:NodeJS.ProcessEnv=process.env):string[]{
  const home=env.USERPROFILE||os.homedir();
  return [...new Set([...(env.PATH||'').split(path.delimiter),path.join(env.APPDATA||path.join(home,'AppData/Roaming'),'npm'),path.join(env.LOCALAPPDATA||path.join(home,'AppData/Local'),'Microsoft/WinGet/Links'),path.join(env.LOCALAPPDATA||path.join(home,'AppData/Local'),'Programs/Ollama'),path.join(home,'.lmstudio/bin'),path.join(home,'.local/bin'),path.join(home,'.cargo/bin')].filter(Boolean))];
}
export function agentRuntimeEnvironment():NodeJS.ProcessEnv{
  const node=agentNodeExecutable();
  return {...process.env,PATH:[...(node!==process.execPath?[path.dirname(node)]:[]),...agentSearchDirectories()].join(path.delimiter)};
}
