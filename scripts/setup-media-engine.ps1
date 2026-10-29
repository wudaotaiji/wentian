<#
.SYNOPSIS
音声制作エンジン（Media Engine）のPython版セットアップを起動します。
.DESCRIPTION
モデルはDownloadを明示したときだけ取得します。動画の本番モデルは取得しません。
CPU/GPUの専用環境と音声モデルの保存先を選び、秘密値をログや引数へ渡しません。
#>
param(
    [ValidateSet('music','sound','transcribe','all')][string]$Download,
    [ValidateSet('cpu','cuda')][string]$Device = 'cpu',
    [string]$Directory,
    [string]$ModelRoot
)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
# 引数配列（Argument Array）で渡し、パスをシェルの本文として実行しません。
$arguments = @((Join-Path $PSScriptRoot 'setup-media-engine.py'), '--device', $Device)
if ($Download) { $arguments += @('--download', $Download) }
if ($Directory) { $arguments += @('--directory', $Directory) }
if ($ModelRoot) { $arguments += @('--model-root', $ModelRoot) }
& python @arguments
if ($LASTEXITCODE -ne 0) { throw '音声制作環境の準備に失敗しました。' }
