<#
.SYNOPSIS
WentianのMCP標準入出力（stdio）ブリッジを起動します。
.DESCRIPTION
Gatewayは別途起動してください。標準出力はMCP専用です。
URL・認証はWENTIAN_MCP_BASE_URLとWENTIAN_MCP_API_KEY／WENTIAN_API_KEYで指定します。
秘密を引数やログへ出さず、スクリプトの配置からブリッジの絶対パスを解決します。
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WentianBridge = Join-Path $PSScriptRoot 'mcp-wrapper.cjs'
# シェル文字列を評価せず、Nodeへ固定スクリプトを渡します。
& node $WentianBridge
exit $LASTEXITCODE
