# 日中英の分類用データを準備するPowerShell入口です。
# 利用者の会話履歴は読み込まず、同梱Python内の確認済み正解だけを出力します。
param([Parameter(Mandatory)][string]$Directory, [string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
& $Python (Join-Path $PSScriptRoot 'prepare-planner-dataset.py') --directory $Directory
exit $LASTEXITCODE
