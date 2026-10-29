<#
.SYNOPSIS
音声・動画制作の実検証（Verification）を隔離環境で実行します。
.DESCRIPTION
標準はOS読み上げ・FFmpegの実処理と関連試験です。AIは準備済みモデルで実推論します。
BrowserはEdgeで実認証・制作・再生・取得・削除を確認します。本番台帳は変更しません。
#>
param([switch]$AI,[switch]$Browser)
$ErrorActionPreference = 'Stop'
$verificationArguments = @()
if ($AI) { $verificationArguments += '--ai' }
if ($Browser) { $verificationArguments += '--browser' }
$env:PYTHONIOENCODING = 'utf-8'
& uv run --no-project --python 3.11 --with playwright python (Join-Path $PSScriptRoot 'verify-media-production.py') @verificationArguments
exit $LASTEXITCODE
