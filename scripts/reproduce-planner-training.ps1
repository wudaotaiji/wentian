# 保存したジョブのデータ・設定・ソースを使い、別フォルダーへ学習を再現します。
# 元ジョブは上書きせず、モデル取得は -AllowDownload 指定時だけ許可します。
param([Parameter(Mandatory)][string]$Source, [string]$Output = '', [switch]$AllowDownload, [string]$Python = '')
$ErrorActionPreference = 'Stop'
if (-not $Python) { $Python = Join-Path $PSScriptRoot '..\.wentian\planner-engine\Scripts\python.exe' }
$reproduceArgs = @((Join-Path $PSScriptRoot 'reproduce-planner-training.py'), '--source', $Source)
if ($Output) { $reproduceArgs += @('--output', $Output) }
if ($AllowDownload) { $reproduceArgs += '--allow-download' }
$env:PYTHONUTF8 = '1'
& $Python @reproduceArgs
exit $LASTEXITCODE
