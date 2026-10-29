# モデル取得や実学習なしで、分類データ分離・評価条件のPython試験を実行します。
# 利用者の会話や学習台帳を読み書きしません。
param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
& $Python (Join-Path $PSScriptRoot 'test-planner-training.py')
exit $LASTEXITCODE
