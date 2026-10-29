<#
.SYNOPSIS
    Confluence ページを REST API（HTTP Basic 認証）で読み取り専用取得する PowerShell ブリッジ。
.DESCRIPTION
    実装は Python 版（scripts/fetch-confluence-rest.py）が本体で、このスクリプトは
    PowerShell 作業者向けの入口だけです。
    文字列連結でコマンドを作らず、引数配列（ArgumentList）でそのまま渡し、
    日本語出力の文字化けを防ぐため PYTHONIOENCODING を utf-8 に固定します。

    認証情報は環境変数 CONFLUENCE_USERNAME / CONFLUENCE_PASSWORD のみを受け取ります。
    パスワードをパラメータ化しないのは、コマンドライン引数に秘密を載せると
    プロセス一覧やシェル履歴・スクリプトブロックログへ残るためです（AGENTS の
    「秘密情報は読み取らない／自動コピーする仕様は採用しない」方針-aligned）。
    未設定の場合はここで停止し、Python 版へ渡しません。
.NOTES
    終了コードは Python 版の契約（0=全件取得 / 2=一部未取得＝検収待ち / 1=実行失敗）を
    そのまま返します。2 は「失敗」ではなく「検収待ち」なので throw しません。
.EXAMPLE
    $env:CONFLUENCE_USERNAME = 'xxx@example.com'
    $env:CONFLUENCE_PASSWORD = Read-Host 'パスワード'        # 画面入力のみ。履歴に残さない
    pwsh -NoProfile -File scripts/fetch-confluence-rest.ps1 -PageId 854280874
.EXAMPLE
    # 複数ページをまとめて取得（新環境・セキュリティ要件など）
    pwsh -NoProfile -File scripts/fetch-confluence-rest.ps1 -PageId 1199910731,1199919628 `
        -OutputDir .wentian/verification/20261003-confluence
#>
[CmdletBinding()]
param(
    # 取得するページ ID（複数可）
    [Parameter(Mandatory = $true)][int[]]$PageId,
    # 保存先（既定は Git 除外済みの .wentian/confluence-rest）
    [string]$OutputDir = '',
    # Confluence ベース URL
    [string]$BaseUrl = $env:WENTIAN_CONFLUENCE_BASE_URL,
    # REST の expand 指定
    [string]$Expand = 'body.storage,space,version,metadata.labels',
    # 1ページあたりの HTTP 上限秒数
    [int]$TimeoutSeconds = 30,
    # 本文を表示せず保存パスだけ出す
    [switch]$Quiet,
    # python 実行ファイル
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($BaseUrl)) { throw 'WENTIAN_CONFLUENCE_BASE_URLを環境変数またはBaseUrlで指定してください。' }
# このスクリプトの位置からリポジトリ直下を求める（作業ディレクトリに依存させない）
$repoRoot = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $PSScriptRoot 'fetch-confluence-rest.py'
if (-not (Test-Path -LiteralPath $bridge)) { throw "Python 本体が見つかりません: $bridge" }

# 認証情報は環境変数だけ。無い場合は秘密を扱う前に止める。
if (-not $env:CONFLUENCE_USERNAME -or -not $env:CONFLUENCE_PASSWORD) {
    throw '環境変数 CONFLUENCE_USERNAME / CONFLUENCE_PASSWORD が未設定です。対話入力（Read-Host）で設定してから再実行してください。'
}

# 出力先が相対指定ならリポジトリ直下から解く
if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot '.wentian\confluence-rest' }

# 引数を配列で組み立てる（文字列連結をしない = クォーティング事故を防ぐ）
$bridgeArgs = [System.Collections.Generic.List[string]]::new()
foreach ($id in $PageId) { $bridgeArgs += @('--page-id', [string]$id) }
$bridgeArgs += @('--base-url', $BaseUrl)
$bridgeArgs += @('--expand', $Expand)
$bridgeArgs += @('--timeout-seconds', [string]$TimeoutSeconds)
$bridgeArgs += @('--output-dir', $OutputDir)
if ($Quiet) { $bridgeArgs += '--quiet' }

# 日本語出力をパイプでも化けさせない
$env:PYTHONIOENCODING = 'utf-8'
Write-Host "▶ Confluence を REST で取得します（ページ $($PageId -join ', ') / $BaseUrl）"
& $Python $bridge @bridgeArgs
$code = $LASTEXITCODE

switch ($code) {
    0 { Write-Host '✔ 全ページ取得完了。' }
    2 { Write-Warning '一部ページが未取得です（権限・ID 不正の可能性。検収待ちで、失敗ではありません）。' }
    default { throw "取得が失敗しました（exit=$code）。" }
}
exit $code
