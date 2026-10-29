<#
同一ファイルの照合・ハードリンク整理を行うPython版の呼出し口です。
Source、Duplicate、Reportは利用者が明示します。Executeなしでは変更しません。
モデルのパスを維持し、内容が違う場合や照合中に変わった場合は削除しません。
#>
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Duplicate,
    [Parameter(Mandatory = $true)][string]$Report,
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'
$dedupArguments = @('--source', $Source, '--duplicate', $Duplicate, '--report', $Report)
if ($Execute) { $dedupArguments += '--execute' }
& python (Join-Path $PSScriptRoot 'deduplicate-identical-file.py') @dedupArguments
exit $LASTEXITCODE
