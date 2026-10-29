# 保存済みの学習ログと評価結果から、PNG/SVG・HTML・再現パッケージを生成します。
# スコアや評価条件を書き換えず、Python版の固定処理へ引数を渡します。
param([Parameter(Mandatory)][string]$Directory, [string]$Python = '')
$ErrorActionPreference = 'Stop'
if (-not $Python) { $Python = Join-Path $PSScriptRoot '..\.wentian\planner-engine\Scripts\python.exe' }
$env:PYTHONUTF8 = '1'
& $Python (Join-Path $PSScriptRoot 'render-planner-training-report.py') --directory $Directory
exit $LASTEXITCODE
