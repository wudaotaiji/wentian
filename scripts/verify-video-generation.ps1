<#
動画生成の隔離検証（Verification）をPython版と同じ条件で実行します。
既定は型検査と関連単体試験です。-Inferenceは小型モデルでCPUの実推論を確認します。
-BrowserはEdgeで実認証・生成・再生・ダウンロード・削除を確認します。
小型モデルは検証専用であり、生成画質やCUDAの動作を検証したことにはしません。
検証用サーバーは空きポートと一時保存先を使用し、本番8787番と本番動画を変更しません。
#>
[CmdletBinding()]
param([switch]$Inference,[switch]$Browser)
$ErrorActionPreference = 'Stop'
$verificationArguments = @()
if ($Inference) { $verificationArguments += '--inference' }
if ($Browser) { $verificationArguments += '--browser' }
$previousEncoding = $env:PYTHONIOENCODING
try {
    $env:PYTHONIOENCODING = 'utf-8'
    & uv run --no-project --python 3.11 --with playwright python (Join-Path $PSScriptRoot 'verify-video-generation.py') @verificationArguments
    $verificationExit = $LASTEXITCODE
} finally { $env:PYTHONIOENCODING = $previousEncoding }
exit $verificationExit
