"""Wentianの状態・成果物・ローカル版の保守（Maintenance）。指定した管理領域だけを操作する。"""
import argparse
import json
import subprocess
from pathlib import Path

# 実行する機能はホスト側で固定。利用者がJavaScript・シェル・検証コマンドを注入する入口はない。
RUNNER = r'''
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {RuntimeMaintenance} from './src/runtime-maintenance.ts';
import {recoverPublication} from './src/task-publication.ts';
import {stageRelease,verifyRelease,switchRelease,rollbackRelease,readCurrentRelease} from './src/release-maintenance.ts';
const args=JSON.parse(fs.readFileSync(0,'utf8'));
// 更新の検証関数は、既存のTypeScriptコンパイラーを固定引数で実行する。
// 候補のpackage.jsonにある任意のスクリプトは実行しない。TSコンパイルはソースを実行しない。
const validator=async ({releaseRoot,versionId})=>{
  const directory=path.join(releaseRoot,'versions',versionId,'files');
  const packageFile=path.join(directory,'package.json');
  if(!fs.existsSync(packageFile)||JSON.parse(fs.readFileSync(packageFile,'utf8')).name!=='wentian-gateway')return false;
  if(!fs.existsSync(path.join(directory,'src','server.ts'))||!fs.existsSync(path.join(directory,'tsconfig.json')))return false;
  return await new Promise(resolve=>{
    const child=spawn(process.execPath,[path.resolve('node_modules/typescript/bin/tsc'),'--noEmit','--project',path.join(directory,'tsconfig.json')],{cwd:directory,windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();resolve(false)},120000);
    child.on('error',()=>{clearTimeout(timer);resolve(false)});
    child.on('close',code=>{clearTimeout(timer);resolve(code===0)});
  });
};
try{
  let result;
  const maintenance=args.state_root?new RuntimeMaintenance({stateRoot:args.state_root}):null;
  switch(args.action){
    case 'backup': if(!args.runtime_stopped)throw Error('バックアップ前に停止確認を明示してください。');result=await maintenance.createBackup();break;
    case 'verify-backup': result=await maintenance.verifyBackup(args.backup_id);break;
    case 'restore-backup': result=await maintenance.restoreBackup(args.backup_id,{runtimeStopped:args.runtime_stopped,overwriteDrifted:args.overwrite_drifted});break;
    case 'recover-publication': result=await recoverPublication(args.workspace);break;
    case 'stage-release': result=await stageRelease({releaseRoot:args.release_root,versionId:args.version_id,candidateRoot:args.candidate_root});break;
    case 'verify-release': result=await verifyRelease({releaseRoot:args.release_root,versionId:args.version_id});break;
    case 'switch-release': result=await switchRelease({releaseRoot:args.release_root,versionId:args.version_id,runtimeStopped:args.runtime_stopped,validator});break;
    case 'rollback-release': result=await rollbackRelease({releaseRoot:args.release_root,runtimeStopped:args.runtime_stopped,validator});break;
    case 'active-entrypoint': {
      const current=await readCurrentRelease(args.release_root);if(!current)throw Error('有効版が未設定です。');
      await verifyRelease({releaseRoot:args.release_root,versionId:current.activeVersionId});
      result={versionId:current.activeVersionId,entrypoint:path.join(args.release_root,'versions',current.activeVersionId,'files','src','server.ts')};break;
    }
    default:throw Error('未対応の保守操作です。');
  }
  console.log(JSON.stringify({status:'success',result}));
}catch(error){console.log(JSON.stringify({status:'failed',reason:error.message}));process.exitCode=1}
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--action', required=True, choices=['backup', 'verify-backup', 'restore-backup', 'recover-publication', 'stage-release', 'verify-release', 'switch-release', 'rollback-release', 'active-entrypoint'])
    for name in ['state-root', 'workspace', 'release-root', 'candidate-root', 'backup-id', 'version-id']:
        parser.add_argument('--' + name)
    parser.add_argument('--runtime-stopped', action='store_true')
    parser.add_argument('--overwrite-drifted', action='store_true')
    args = parser.parse_args()
    # 相対パスは利用者の現在地で解決し、スクリプト内部のcwd変更で意味を変えない。
    values = vars(args)
    for name in ['state_root', 'workspace', 'release_root', 'candidate_root']:
        if values[name]:
            values[name] = str(Path(values[name]).resolve())
    if 'backup' in args.action and not args.state_root:
        parser.error('--state-rootを指定してください。')
    if args.action in ['verify-backup', 'restore-backup'] and not args.backup_id:
        parser.error('--backup-idを指定してください。')
    if args.action == 'recover-publication' and not args.workspace:
        parser.error('--workspaceを指定してください。')
    if ('release' in args.action or args.action == 'active-entrypoint') and not args.release_root:
        parser.error('--release-rootを指定してください。')
    if args.action in ['stage-release', 'verify-release', 'switch-release'] and not args.version_id:
        parser.error('--version-idを指定してください。')
    if args.action == 'stage-release' and not args.candidate_root:
        parser.error('--candidate-rootを指定してください。')
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', RUNNER],
                            input=json.dumps(values), text=True, encoding='utf-8',
                            cwd=Path(__file__).resolve().parents[1], timeout=180)
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
