<#
隔離画面検収サーバーのPowerShell入口です。新規出力先を明示してください。
Python版と同じTypeScript実装を使用し、実モデル・本番知識庫には接続しません。
出力先server.jsonのURLを開き、Ctrl+Cまたは15分の期限で終了します。
#>
param([Parameter(Mandatory = $true)][string]$Output)
$ErrorActionPreference = 'Stop'
$fixtureOutput = [System.IO.Path]::GetFullPath($Output)
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    & node --import tsx scripts/verify-knowledge-screen.ts --output $fixtureOutput
    exit $LASTEXITCODE
} finally { Pop-Location }
