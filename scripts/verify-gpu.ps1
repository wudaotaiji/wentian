# GPU（Graphics Processing Unit）実機検証のPowerShell入口です。
# 専用Python環境だけを使用し、運用中の学習モデルは有効化しません。
# 引数はPythonへ配列として渡し、シェル文字列として解釈しません。
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
# Windowsの既定コードページによる日本語ログの文字化けを避けます。
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$Project = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Project '.wentian/planner-engine/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $Python)) { throw 'GPU試験用のPython環境がありません。' }
& $Python (Join-Path $PSScriptRoot 'verify-gpu.py') @Arguments
exit $LASTEXITCODE
