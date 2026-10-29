<#
動画生成エンジン（Video Engine）のセットアップ入口です。
既定はGPU非搭載PC向けCPU版です。CUDA対応PCでは-Device cudaを指定します。
-DownloadModelを指定した時だけ、大容量のLTXモデルをダウンロードします。
既存環境を壊さず、専用の仮想環境（Virtual Environment）へ依存ライブラリを入れます。
モデルのライセンスは公式モデルカードを確認してください。
#>
[CmdletBinding()]
param([ValidateSet('cpu','cuda')][string]$Device='cpu', [string]$Directory, [switch]$DownloadModel, [string]$Revision)
$ErrorActionPreference = 'Stop'
$setupArgs = @('--device',$Device)
if ($Directory) { $setupArgs += @('--directory',$Directory) }
if ($DownloadModel) { $setupArgs += '--download-model' }
if ($Revision) { $setupArgs += @('--revision',$Revision) }
$env:PYTHONIOENCODING = 'utf-8'
& uv run --no-project --python 3.11 python (Join-Path $PSScriptRoot 'setup-video-engine.py') @setupArgs
exit $LASTEXITCODE
