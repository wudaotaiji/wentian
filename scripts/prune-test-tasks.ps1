# 工作台タスク（Goal台帳 / Goal Store）の試験残骸を退避するPowerShellブリッジ（Bridge）。
# 実処理はPython側（prune-test-tasks.py）が行い、このスクリプトは引数の組み立てと終了コードの受け渡しに専念します。
#
# 重要な設計: ファイルを削除しません。同一ボリューム内の退避先（Quarantine）へ移動するだけなので
#           -Restore で元へ戻せます。既定はドライランで、-Apply を付けない限り1ファイルも動きません。
#
# 終了コード（Task Outcome Contract / 終了コード契約）:
#   0   ... 正常完了（退避した、またはドライランで対象を特定した）
#   2   ... 退避対象なし（Already clean。失敗ではありません）
#   1   ... 実行そのものの失敗（台帳が読めない、退避先へ動かせない 等）
#
# 例:
#   pwsh -NoProfile -File scripts/prune-test-tasks.ps1                    # ドライラン（何も動かさない）
#   pwsh -NoProfile -File scripts/prune-test-tasks.ps1 -Apply             # 実際に退避する
#   pwsh -NoProfile -File scripts/prune-test-tasks.ps1 -Restore '<退避先>' # 退避した分を実台帳へ戻す
[CmdletBinding()]
param(
    # Goal台帳ディレクトリ。省略時は リポジトリ/.wentian/goals。
    [string]$GoalsRoot = '',
    # 退避先の親ディレクトリ。実行時刻のサブフォルダを作ります。
    [string]$QuarantineRoot = (Join-Path $PSScriptRoot '..\.wentian\goals-quarantine'),
    # 実行台帳（Manifest）と報告の出力先。
    [string]$ReportRoot = (Join-Path $PSScriptRoot '..\.wentian\goals-quarantine'),
    # 退避対象のタイトル。省略時は g と phase2-test（試験が残したもの）。
    [string[]]$Title = @(),
    # 実際に退避を実行します。付けない場合はドライランです。
    [switch]$Apply,
    # 復元する退避ディレクトリ。指定すると復元モードで動きます。
    [string]$Restore = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
# コマンド文字列の連結を避け、パスとタイトルは独立した引数として渡します（引用符の崩れを防ぐため）。
$bridgeArgs = @((Join-Path $PSScriptRoot 'prune-test-tasks.py'), '--quarantine-root', $QuarantineRoot, '--report-root', $ReportRoot)
if ($GoalsRoot) { $bridgeArgs += @('--goals-root', $GoalsRoot) }
foreach ($name in $Title) { $bridgeArgs += @('--title', $name) }
if ($Restore) { $bridgeArgs += @('--restore', $Restore) }
elseif ($Apply) { $bridgeArgs += '--apply' }
& python @bridgeArgs
$code = $LASTEXITCODE
# 0（完了）と2（退避対象なし）は正当な結果なので、そのまま終了コードとして返します。
if ($code -ne 0 -and $code -ne 2) { throw "工作台タスクの退避が失敗しました。終了コード: $code" }
exit $code
