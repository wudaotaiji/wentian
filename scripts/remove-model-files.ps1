<#
明示したGGUFの削除をPython版に委譲します。モデルの使用状況は事前に確認してください。
Root、Files、Reportは明示必須です。Executeなしでは計画のみ保存します。
対象の絶対パスと親リンクを検証し、他のファイルやディレクトリは削除しません。
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string[]]$Files,
    [Parameter(Mandatory = $true)][string]$Report,
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'
$removeArguments = @('--root', $Root, '--report', $Report)
foreach ($item in $Files) { $removeArguments += @('--file', $item) }
if ($Execute) { $removeArguments += '--execute' }
& python (Join-Path $PSScriptRoot 'remove-model-files.py') @removeArguments
exit $LASTEXITCODE
