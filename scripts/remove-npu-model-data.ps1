<#
NPUモデルデータ整理のPython版を呼び出します。
対象と領域外の報告先を明示し、Executeなしでは計画のみ保存します。
モデル再取得に必要なコードや説明文を保持し、再解析ポイントは拒否します。
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Report,
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'
$cleanupArguments = @('--root', $Root, '--report', $Report)
if ($Execute) { $cleanupArguments += '--execute' }
& python (Join-Path $PSScriptRoot 'remove-npu-model-data.py') @cleanupArguments
exit $LASTEXITCODE
