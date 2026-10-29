<#
PythonのPlaywrightによる管理サイト検証を同じ引数で実行するPowerShell入口です。
uvの分離環境を使い、プロジェクト依存関係と利用者の既存ブラウザーを変更しません。
認証値を引数へ展開せず、Python内で読み取り、画面と非機密の結果だけ保存します。
#>
[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:8787', [switch]$Attachments)
$ErrorActionPreference = 'Stop'
# 引数配列で渡すため、URL内の文字をPowerShellコードとして実行しません。
$taskArguments = @((Join-Path $PSScriptRoot 'verify-admin-browser.py'), '--base-url', $BaseUrl)
if ($Attachments) { $taskArguments += '--attachments' }
& uv run --no-project --with playwright python @taskArguments
exit $LASTEXITCODE
