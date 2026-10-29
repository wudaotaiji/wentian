# 実装能力検証（Work Capability Verification）のPowerShellブリッジ（Bridge）。
# 実処理はPython側（verify-agent-work.py）が行い、このスクリプトは引数の組み立てと終了コードの受け渡しに専念します。
#
# 終了コード（Task Outcome Contract / 終了コード契約）:
#   0   ... 検証対象がすべて合格
#   2   ... 実装能力検証が未合格（検収待ち。失敗ではありません）
#   1   ... 検証実行そのものの失敗
#   124 ... 時間切れ
#
# 例:
#   pwsh -NoProfile -File scripts/verify-agent-work.ps1                      # 管理対象すべてを検証
#   pwsh -NoProfile -File scripts/verify-agent-work.ps1 -Agent goose         # 1件だけ検証
#   pwsh -NoProfile -File scripts/verify-agent-work.ps1 -StatusOnly          # 検証せず状態報告のみ（Tokens消費なし）
[CmdletBinding()]
param(
    # 検証対象のAgent ID。省略または 'all' で管理対象すべてを対照にします。
    [string[]]$Agent = @(),
    # Health Check Cache（生存確認キャッシュ / Health Check Cache）のディレクトリ。
    [string]$CacheDir = '',
    # 検証を実行せず、保存済み記録からの状態報告だけを確認します。
    [switch]$StatusOnly,
    # 実行台帳（Manifest）と報告の出力先。
    [string]$ReportRoot = (Join-Path $PSScriptRoot '..\.wentian\work-verification'),
    # Node.js 実行ファイル。
    [string]$Node = 'node'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
# コマンド文字列の連結を避け、Agent ID・パスは独立した引数として渡します（引用符の崩れを防ぐため）。
$bridgeArgs = @((Join-Path $PSScriptRoot 'verify-agent-work.py'), '--report-root', $ReportRoot, '--node', $Node)
foreach ($id in $Agent) { $bridgeArgs += @('--agent', $id) }
if ($CacheDir) { $bridgeArgs += @('--cache-dir', $CacheDir) }
if ($StatusOnly) { $bridgeArgs += '--status-only' }
& python @bridgeArgs
$code = $LASTEXITCODE
# 0（合格）と2（未合格＝検収待ち）は正当な結果なので、そのまま終了コードとして返します。
if ($code -ne 0 -and $code -ne 2) { throw "実装能力検証が失敗しました。終了コード: $code" }
exit $code
