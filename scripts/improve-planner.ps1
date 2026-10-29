# 分類モデルの改善を段階ごとに実行するPowerShell入口です。
# 学習・評価は専用領域で行い、有効化は独立評価の合格後の操作に限定します。
# 引数を配列でPythonへ渡し、依頼文をシェルとして解釈しません。
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$Project = Split-Path -Parent $PSScriptRoot
& (Join-Path $Project '.wentian/planner-engine/Scripts/python.exe') (Join-Path $PSScriptRoot 'improve-planner.py') @Arguments
exit $LASTEXITCODE
