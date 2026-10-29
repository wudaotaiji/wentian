"""実Claudeの制限付き変更提案を検収する。新しい一時領域だけを変更する。"""
import argparse
import subprocess
from pathlib import Path

# テスト対象も検収文も固定し、任意のシェルや実行ファイルを引数から受け取らない。
PROBE = r'''
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildConfinedPlan,runConfinedExternalTask} from './src/confined-external-task.ts';
// 原本は新規の試験専用領域。利用者の既存プロジェクトには反映しない。
const root=await mkdtemp(path.join(tmpdir(),'wentian-confined-live-'));
await writeFile(path.join(root,'result.txt'),'変更前');
const plan=buildConfinedPlan('result.txtの全文をWENTIAN_CONFINED_OKにしてください。変更提案JSONだけ返してください。',['result.txt']);
plan.attachments=[{type:'local_file',path:'result.txt'}];
const result=await runConfinedExternalTask(plan,root,{model:process.argv[1],acceptanceChecks:[{path:'result.txt',contains:'WENTIAN_CONFINED_OK'}],timeoutMs:180000});
const passed=result.outcome.status==='success'&&(await readFile(path.join(root,'result.txt'),'utf8')).trim()==='WENTIAN_CONFINED_OK';
// 依頼・モデル応答本文・認証値を標準出力へ出さない。
console.log(JSON.stringify({passed,status:result.outcome.status,reason:result.outcome.reason,cliLaunchCount:result.cliLaunchCount,changes:result.changes.map(c=>({path:c.path,beforeHash:c.beforeHash,afterHash:c.afterHash}))}));
process.exitCode=passed?0:1;
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', default='local-model')
    args = parser.parse_args()
    # shell=Falseと引数配列で、モデル名をシェル命令として解釈させない。
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', PROBE, args.model],
                            cwd=Path(__file__).resolve().parents[1], timeout=240)
    return result.returncode


if __name__ == '__main__':
    raise SystemExit(main())
