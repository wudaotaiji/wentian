<#
PythonのPlaywrightでPlan/Act・Web・実ファイルの検証を行うPowerShell入口です。
試験用一時ワークスペースのサーバーだけを対象にし、本番のファイルを変更しません。
認証値は環境変数を引き継ぎ、コマンド引数や実行ログには出しません。
#>
[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:8788', [string]$Model = 'lmstudio/local-model', [string]$LocalImage)
$ErrorActionPreference = 'Stop'
# uvの分離環境を使い、プロジェクトのPython依存や既存ブラウザーを変更しません。
$taskArguments = @((Join-Path $PSScriptRoot 'verify-chat-agent.py'), '--base-url', $BaseUrl, '--model', $Model)
if ($LocalImage) { $taskArguments += @('--local-image', $LocalImage) }
& uv run --no-project --with playwright python @taskArguments
exit $LASTEXITCODE
