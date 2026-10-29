<#
.SYNOPSIS
制作能力の会話連携（Capability Context）をPython版と同じ条件で検証します。
.DESCRIPTION
既定は型検査と関連試験です。Liveは接続済みの実LLMへ元の質問を送ります。
実ファイルの制作やモデル取得は開始しません。検証ログは専用の証跡フォルダーへ保存します。
#>
param([switch]$Live)
$ErrorActionPreference = 'Stop'
$verificationArguments = @()
if ($Live) { $verificationArguments += '--live' }
$env:PYTHONIOENCODING = 'utf-8'
& python (Join-Path $PSScriptRoot 'verify-media-capabilities.py') @verificationArguments
exit $LASTEXITCODE
