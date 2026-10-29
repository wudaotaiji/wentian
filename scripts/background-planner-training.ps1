# 会話ウィンドウに依存しないWindowsタスクの入口です。
# 既存学習を監視し、停止した場合は記録を保持して同条件で再学習します。
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
& '.\.wentian\planner-engine\Scripts\python.exe' '.\scripts\background-planner-training.py' *> '.\.wentian\planner-training\background-worker.log'
exit $LASTEXITCODE
