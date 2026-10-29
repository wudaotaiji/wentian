<#
.SYNOPSIS
    実LLM連続完遂検証（Consecutive Completion Verification）の PowerShell ブリッジ。
.DESCRIPTION
    実装は Python 版（scripts/verify-consecutive-completion.py）が本体で、
    このスクリプトは PowerShell 从業者向けの入口だけです。
    文字列連結でコマンドを作らず、引数配列（ArgumentList）でそのまま渡し、
    日本語出力の文字化けを防ぐため PYTHONIOENCODING を utf-8 に固定します。
    終了コードは Python 版の契約（0=連続完遂 / 2=未完遂・上流制限 / 1=実行失敗 / 124=時間切れ）を
    そのまま返します。2 は「失敗」ではなく「検収待ち」なので、throw しません。
.EXAMPLE
    pwsh -NoProfile -File scripts/verify-consecutive-completion.ps1 -Rounds 3
.EXAMPLE
    # ローカルLLMで連続完遂を実測する（自動選択だとローカルモデルが答えるため明示固定が必須）
    pwsh -NoProfile -File scripts/verify-consecutive-completion.ps1 -Rounds 5 -Model 'lmstudio/local-model'
#>
[CmdletBinding()]
param(
    # 連続実行するラウンド数（既定3）
    [int]$Rounds = 3,
    # Gateway URL（既定は稼働中の常駐サーバー）
    [string]$Server = 'http://127.0.0.1:8787',
    # 1ラウンドのCLI上限（ミリ秒）
    [int]$TimeoutMs = 120000,
    # 全体の時間予算（秒）
    [int]$BudgetSeconds = 900,
    # 上流利用制限時にCLI側待機を許可する（--wait-on-limit 相当。人の見守る実行のみ）
    [switch]$AllowWait,
    # 未完遂ラウンドで即時停止する
    [switch]$StopOnIncomplete,
    # 台帳と報告の出力先（既定は Git除外済みの .wentian/consecutive-completion）
    [string]$ReportRoot = '',
    # 応答モデルを固定（例 lmstudio/local-model）。空なら自動選択になる点に注意。
    [string]$Model = '',
    # python 実行ファイル
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
# このスクリプトの位置からリポジトリ直下を求める（作業ディレクトリに依存させない）
$repoRoot = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $PSScriptRoot 'verify-consecutive-completion.py'
if (-not (Test-Path -LiteralPath $bridge)) { throw "Python 本体が見つかりません: $bridge" }

# 引数を配列で組み立てる（文字列連結をしない = クォーティング事故を防ぐ）
$bridgeArgs = [System.Collections.Generic.List[string]]::new()
$bridgeArgs += @('--rounds', [string]$Rounds)
$bridgeArgs += @('--server', $Server)
$bridgeArgs += @('--timeout-ms', [string]$TimeoutMs)
$bridgeArgs += @('--budget-seconds', [string]$BudgetSeconds)
if ($AllowWait) { $bridgeArgs += '--allow-wait' }
if ($StopOnIncomplete) { $bridgeArgs += '--stop-on-incomplete' }
if ($Model) { $bridgeArgs += @('--model', $Model) }
if ($ReportRoot) { $bridgeArgs += @('--report-root', $ReportRoot) }

# 日本語出力をパイプでも化けさせない
$env:PYTHONIOENCODING = 'utf-8'
Write-Host "▶ 実LLM連続完遂検証を開始します（ラウンド $Rounds / Gateway $Server）"
& $Python $bridge @bridgeArgs
$code = $LASTEXITCODE

switch ($code) {
    0 { Write-Host '✔ 全ラウンド連続完遂。' }
    2 { Write-Warning '未完遂または上流利用制限で停止しました（検収待ち。失敗として扱いません）。' }
    124 { Write-Warning '時間切れです。' }
    default { throw "検証実行が失敗しました（exit=$code）。" }
}
exit $code
