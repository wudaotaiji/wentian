# 一時ブラウザー・一時チェーンを使い、Gatewayの利用者データと本番資金を変更しません。
# --wtc-project、--server、--outputをNode側の入力検証へそのまま渡します。
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$WalletArguments)
$ErrorActionPreference='Stop'
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try { & node (Join-Path $PSScriptRoot 'verify-wallet.mjs') @WalletArguments; exit $LASTEXITCODE } finally { Pop-Location }
