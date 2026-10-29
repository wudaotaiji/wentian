<#
.SYNOPSIS
モデル自動保守（Model Maintenance）をPython版と同じ設定で実行します。
.DESCRIPTION
Policyに明示的に有効化したモデルだけを取得します。正常なモデルは更新しません。
設定に秘密情報は不要です。専用Python環境を使用し、終了コードを呼出元へ返します。
#>
param([Parameter(Mandatory)][string]$Policy)
$ErrorActionPreference = 'Stop'
$modelPython = $env:WENTIAN_VIDEO_PYTHON
if (-not $modelPython) { $modelPython = Join-Path (Split-Path $PSScriptRoot -Parent) '.wentian/video-engine/Scripts/python.exe' }
$env:PYTHONIOENCODING = 'utf-8'
& $modelPython (Join-Path $PSScriptRoot 'maintain-media-models.py') --policy $Policy
exit $LASTEXITCODE
