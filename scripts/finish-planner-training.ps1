# 実行中の分類学習を監視し、終了後の検収・有効化・図表保存を継続します。
# 元の学習を停止せず、不合格モデルは有効化しません。監視結果は別台帳へ保存します。
param([Parameter(Mandatory)][string]$Directory, [string]$Python = '')
$ErrorActionPreference = 'Stop'
if (-not $Python) { $Python = Join-Path $PSScriptRoot '..\.wentian\planner-engine\Scripts\python.exe' }
$env:PYTHONUTF8 = '1'
& $Python (Join-Path $PSScriptRoot 'finish-planner-training.py') --directory $Directory
exit $LASTEXITCODE
