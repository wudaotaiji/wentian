param(
    [Parameter(Mandatory=$true)][string]$Database,
    [Parameter(Mandatory=$true)][string]$Output
)
# 入力台帳と出力先を絶対パスで検証し、既存の退避データを上書きしません。
$ErrorActionPreference = 'Stop'
$sourcePath = [System.IO.Path]::GetFullPath($Database)
$targetPath = [System.IO.Path]::GetFullPath($Output)
if (-not [System.IO.File]::Exists($sourcePath) -or [System.IO.File]::Exists($targetPath) -or $sourcePath -eq $targetPath) {
    throw '入力台帳が存在しないか、出力先が既に存在します。'
}
# 環境変数でパスを渡すため、引用符・空白・シェル文字をコードへ埋め込みません。
$env:WENTIAN_BACKUP_SOURCE = $sourcePath
$env:WENTIAN_BACKUP_TARGET = $targetPath
$backupCode = @'
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import path from 'node:path';
const source=process.env.WENTIAN_BACKUP_SOURCE,target=process.env.WENTIAN_BACKUP_TARGET;
if(!existsSync(source)||existsSync(target))throw new Error('台帳の入力と出力を確認してください。');
mkdirSync(path.dirname(target),{recursive:true});
const db=new DatabaseSync(source,{readOnly:true});
try{db.prepare('VACUUM INTO ?').run(target);}finally{db.close();}
const backup=new DatabaseSync(target,{readOnly:true});
try{if(backup.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('整合性検査に失敗しました。');}finally{backup.close();}
'@
try {
    $backupCode | node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw '取引台帳の退避に失敗しました。' }
    Write-Output "取引台帳を退避しました: $targetPath"
} finally {
    # 次の作業へ対象パスを残さないよう、専用環境変数を削除します。
    Remove-Item Env:WENTIAN_BACKUP_SOURCE -ErrorAction SilentlyContinue
    Remove-Item Env:WENTIAN_BACKUP_TARGET -ErrorAction SilentlyContinue
}
