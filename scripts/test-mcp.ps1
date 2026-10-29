<#
.SYNOPSIS
MCPの初期化・ツール一覧・終了を読み取り専用で確認します。
.DESCRIPTION
PowerShell 7を使用します。タスク登録・外部ツール実行は行いません。
認証は環境変数から受け取り、取得したセッションIDを後続要求へ引き継ぎます。
#>
param([string]$BaseUrl = 'http://127.0.0.1:8787')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WentianEndpoint = "$($BaseUrl.TrimEnd('/'))/mcp"
$WentianHeaders = @{ Accept = 'application/json, text/event-stream' }
$WentianKey = $env:WENTIAN_MCP_API_KEY
if (-not $WentianKey) { $WentianKey = $env:WENTIAN_API_KEY }
if ($WentianKey) { $WentianHeaders.Authorization = "Bearer $WentianKey" }

function Send-WentianMcp([hashtable]$Message) {
    # JSONをUTF-8へ変換し、必要なAcceptヘッダーも送信します。
    $WentianJson = $Message | ConvertTo-Json -Depth 10
    Invoke-WebRequest -Uri $WentianEndpoint -Method Post -Headers $WentianHeaders `
        -ContentType 'application/json' -Body ([Text.Encoding]::UTF8.GetBytes($WentianJson)) -TimeoutSec 30
}

try {
    $WentianInit = Send-WentianMcp @{
        jsonrpc = '2.0'; id = 1; method = 'initialize'
        params = @{ protocolVersion = '2025-11-25'; capabilities = @{}; clientInfo = @{ name = 'wentian-check'; version = '1.0' } }
    }
    $WentianInfo = $WentianInit.Content | ConvertFrom-Json
    if ($WentianInfo.PSObject.Properties.Name -contains 'error') { throw 'MCP初期化に失敗しました。' }
    $WentianHeaders['Mcp-Session-Id'] = [string](@($WentianInit.Headers['Mcp-Session-Id'])[0])
    $WentianHeaders['Mcp-Protocol-Version'] = $WentianInfo.result.protocolVersion
    Send-WentianMcp @{ jsonrpc = '2.0'; method = 'notifications/initialized' } | Out-Null
    $WentianList = Send-WentianMcp @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} }
    $WentianList.Content
} finally {
    # 成否にかかわらず作成したセッションを終了します。
    if ($WentianHeaders.ContainsKey('Mcp-Session-Id')) {
        Invoke-WebRequest -Uri $WentianEndpoint -Method Delete -Headers $WentianHeaders -TimeoutSec 10 | Out-Null
    }
}
