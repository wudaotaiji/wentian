# 分類学習用の専用Python環境を準備する入口です。
# モデルは取得せず、同梱Python版が .wentian/planner-engine にだけ依存を導入します。
# 既定はCUDA 12.8版です。GPUを使わない場合は -Cpu でCPU版を選択します。
param([string]$Python = 'python', [switch]$Cpu)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$setupArgs = @((Join-Path $PSScriptRoot 'setup-planner-training.py'))
if ($Cpu) { $setupArgs += '--cpu' }
& $Python @setupArgs
exit $LASTEXITCODE
