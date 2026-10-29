<#
ディスク容量調査のPowerShell呼出し版です。フォルダーの内容を書き換えません。
Python版へ調査対象と保存先をそのまま渡します。日本語ログはUTF-8で扱います。
例：-Root C:\Users\利用者,C:\mywork -Output C:\一時領域\capacity.json
個人パスを含む結果ファイルは公開しないでください。
#>
param(
    [Parameter(Mandatory = $true)][string[]]$Root,
    [Parameter(Mandatory = $true)][string]$Output
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'
$scanArguments = @()
foreach ($target in $Root) { $scanArguments += @('--root', $target) }
& python (Join-Path $PSScriptRoot 'investigate-disk-capacity.py') @scanArguments --output $Output
exit $LASTEXITCODE
