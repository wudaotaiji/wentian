# Wentian Gateway の安全なE2E（エンドツーエンド / End-to-End）受入試験です。
# 状態変更APIは使用せず、既に起動しているGatewayに対する推論要求だけを実行します。
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8787',
    [int]$ClientTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

function Invoke-WentianChat {
    param([Parameter(Mandatory)][string]$Model)
    # ConvertTo-Jsonを使い、日本語や引用符を安全にJSONへ変換します。
    $Body = @{
        model = $Model
        messages = @(@{ role = 'user'; content = 'OKとのみ回答してください' })
        max_tokens = 64
        stream = $false
    } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" -Method Post -ContentType 'application/json' -Body $Body -TimeoutSec $ClientTimeoutSeconds
}

function Invoke-ClientWithTimeout {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    # Start-ProcessとWait-Processを組み合わせ、CLIの無期限再試行を試験失敗として止めます。
    $LogDirectory = Join-Path $PSScriptRoot '..\.e2e'
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    $SafeName = [IO.Path]::GetFileNameWithoutExtension($Executable)
    $OutputPath = Join-Path $LogDirectory "$SafeName.stdout.log"
    $ErrorPath = Join-Path $LogDirectory "$SafeName.stderr.log"
    $Process = Start-Process -FilePath $Executable -ArgumentList $Arguments -NoNewWindow -PassThru `
        -RedirectStandardOutput $OutputPath -RedirectStandardError $ErrorPath
    try {
        Wait-Process -Id $Process.Id -Timeout $ClientTimeoutSeconds -ErrorAction Stop
    } catch {
        # タイムアウトした当該CLIだけを停止し、別プロセスのGatewayには影響させません。
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        throw "$Executable が $ClientTimeoutSeconds 秒以内に完了しませんでした。"
    }
    Get-Content -LiteralPath $OutputPath -ErrorAction SilentlyContinue | Write-Host
    Get-Content -LiteralPath $ErrorPath -ErrorAction SilentlyContinue | Write-Host
    if ($Process.ExitCode -ne 0) { throw "$Executable が失敗しました。終了コード: $($Process.ExitCode)" }
}

function Test-SseDisconnect {
    # 最初のSSEデータ行を確認後に接続を破棄し、Gatewayが切断後も生存することを検証します。
    $Body = @{ model = 'wentian-auto/remote'; messages = @(@{ role = 'user'; content = '短く説明してください' }); max_tokens = 128; stream = $true } | ConvertTo-Json -Depth 5
    $Client = [Net.Http.HttpClient]::new()
    try {
        $Request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, "$BaseUrl/v1/chat/completions")
        $Request.Content = [Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json')
        # ResponseHeadersReadにより応答全体を待たず、最初のSSE行から読み始めます。
        $Response = $Client.SendAsync($Request, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $Response.EnsureSuccessStatusCode() | Out-Null
        $Stream = $Response.Content.ReadAsStream()
        $Reader = [IO.StreamReader]::new($Stream)
        $Line = $Reader.ReadLine()
        if ($Line -notmatch '^data:') { throw 'SSEのdata行を受信できませんでした。' }
        $Reader.Dispose()
        $Response.Dispose()
        $Request.Dispose()
    } finally {
        $Client.Dispose()
    }
    Start-Sleep -Milliseconds 500
    $PostDisconnectHealth = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 10
    if (-not $PostDisconnectHealth.ok) { throw 'SSE切断後にGatewayが停止しました。' }
}

function Test-McpEndpoint {
    # Streamable HTTP（ストリーマブルHTTP / Streamable HTTP）の必須入口へinitializeとtools/listを送り、
    # VS CodeなどのMCPクライアントが利用するJSON-RPC契約を実Gatewayで検証します。
    $Headers = @{ Accept = 'application/json, text/event-stream' }
    $InitializeBody = @{
        jsonrpc = '2.0'
        id = 1
        method = 'initialize'
        params = @{
            protocolVersion = '2025-06-18'
            capabilities = @{}
            clientInfo = @{ name = 'wentian-e2e-powershell'; version = '1.0' }
        }
    } | ConvertTo-Json -Depth 8
    $Initialized = Invoke-RestMethod -Uri "$BaseUrl/mcp" -Method Post -Headers $Headers -ContentType 'application/json' -Body $InitializeBody -TimeoutSec 10
    if ($Initialized.result.serverInfo.name -ne 'wentian-gateway') { throw 'MCP initialize応答が不正です。' }

    $ListBody = @{ jsonrpc = '2.0'; id = 2; method = 'tools/list'; params = @{} } | ConvertTo-Json -Depth 5
    $Listed = Invoke-RestMethod -Uri "$BaseUrl/mcp" -Method Post -Headers $Headers -ContentType 'application/json' -Body $ListBody -TimeoutSec 10
    if (-not $Listed.result.tools -or $Listed.result.tools.Count -lt 1) { throw 'MCP Tool一覧を取得できませんでした。' }
}

Write-Host '1. Health（ヘルス / Health）を確認します。'
$Health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 10
if (-not $Health.ok) { throw 'Gateway Healthが正常ではありません。' }

Write-Host '2. 外部自動ルーティングを確認します。'
$Remote = Invoke-WentianChat -Model 'wentian-auto/remote'
$Remote.wentian | ConvertTo-Json -Depth 5

Write-Host '3. ローカル自動ルーティングを確認します。'
$Local = Invoke-WentianChat -Model 'wentian-auto/local'
$Local.wentian | ConvertTo-Json -Depth 5

Write-Host '4. SSE途中切断後のGateway生存を確認します。'
Test-SseDisconnect

Write-Host '5. OpenCodeを制限時間付きで確認します。'
Invoke-ClientWithTimeout -Executable 'opencode.cmd' -Arguments @('run', '--model', 'wentian/wentian-auto/remote', 'OKとのみ回答してください')

Write-Host '6. Kiloを制限時間付きで確認します。'
Invoke-ClientWithTimeout -Executable 'kilo.cmd' -Arguments @('run', '--model', 'wentian/wentian-auto/remote', 'OKとのみ回答してください')

Write-Host '7. MCP Streamable HTTP入口を確認します。'
Test-McpEndpoint

Write-Host 'E2E受入試験が完了しました。'
