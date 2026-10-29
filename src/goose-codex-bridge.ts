import {mkdtemp,writeFile,rm,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {maintenancePythonCommand} from './maintenance-python.js';

/** Gooseの旧版が省略するモデル・権限を、子CLIへ確実に渡す一時入口です。 */
export async function prepareGooseCodexBridge(command:{executable:string;args:string[]}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'wentian-goose-codex-'));
  const cleanup=()=>rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  try{
    const python=maintenancePythonCommand();
    const script=fileURLToPath(new URL('../scripts/run-goose-codex.py',import.meta.url));
    const entry=path.join(directory,process.platform==='win32'?'codex.cmd':'codex');
    const tokens=[python.executable,...python.args,script];
    // Gooseが渡す引数は転送しません。プロンプトは継承した標準入力だけから受け取ります。
    // Windowsの%展開も無効化し、設定されたパスを実行文へ混入させません。
    if(process.platform==='win32'){
      if(tokens.some(value=>/[\r\n"]/.test(value)))throw new Error('Pythonの実行パスが不正です。');
      await writeFile(entry,'@echo off\r\n'+tokens.map(value=>'"'+value.replace(/%/g,'%%')+'"').join(' ')+'\r\n');
    }else{
      await writeFile(entry,'#!/bin/sh\nexec '+tokens.map(value=>"'"+value.replace(/'/g,"'\\''")+"'").join(' ')+'\n');
      await chmod(entry,0o700);
    }
    return {env:{CODEX_COMMAND:entry,GOOSE_MODE:'chat',WENTIAN_GOOSE_CODEX_COMMAND:JSON.stringify([command.executable,...command.args])},cleanup};
  }catch(error){await cleanup();throw error;}
}
