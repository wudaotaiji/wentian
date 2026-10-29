# ローカル推論（Local Inference）の実測入口です。
# 同梱Python版へ明示引数を渡し、測定処理と後処理の差異を避けます。
# インストール済みローカルモデルだけを使用し、取得・クラウド実行はしません。
param(
    [string]$Model = 'qwen2.5:7b',
    [string]$Output = 'docs/evidence/20261006_control_plane/local-benchmark.json',
    [switch]$Gpu
)
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    # シェル文字列を組み立てず、引数配列でモデル名と報告先を渡します。
    $benchmarkArgs = @('-X', 'utf8', (Join-Path $PSScriptRoot 'benchmark-local.py'), '--model', $Model, '--output', $Output)
    if ($Gpu) { $benchmarkArgs += '--gpu' }
    & python @benchmarkArgs
    exit $LASTEXITCODE
} finally {
    # 測定の成否を問わず呼び出し元のディレクトリへ戻します。
    Pop-Location
}
