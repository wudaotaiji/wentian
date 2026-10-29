<#
Personal Cloudの隔離検証（Verification）をPython版と同じ引数・終了コードで実行します。
Dockerを指定すると専用アプリの配備・更新失敗・停止・削除を実機で検証します。
Browserは一時認証と一時SQLite台帳でEdgeの画面を検証します。本番の8787番は使用しません。
秘密情報はコマンドラインへ渡さず、呼出先でも証拠へ保存しません。
#>
[CmdletBinding()]
param([switch]$Docker, [switch]$Browser, [switch]$BrowserOnly)
$ErrorActionPreference = 'Stop'
$verificationArgs = @()
if ($Docker) { $verificationArgs += '--docker' }
if ($Browser) { $verificationArgs += '--browser' }
if ($BrowserOnly) { $verificationArgs += '--browser-only' }
# 実行ファイルと引数を分け、パスに空白があっても実行コードとして扱いません。
$previousEncoding = $env:PYTHONIOENCODING
try {
    $env:PYTHONIOENCODING = 'utf-8'
    & uv run --no-project --with playwright python (Join-Path $PSScriptRoot 'verify-personal-cloud.py') @verificationArgs
    $verificationExit = $LASTEXITCODE
} finally {
    $env:PYTHONIOENCODING = $previousEncoding
}
exit $verificationExit
