<#
実時間の耐久試験（Durability Test）のPowerShell入口。
Python版と同じ検査本体を使い、判定・障害注入・証拠の仕様を統一する。
StateRootにはこの試験だけの新しいディレクトリを指定する。
既存の試験、本番の状態、外部サービスを変更しない。
Hoursを短く指定した場合は短時間の機能確認となり、長時間合格とは扱わない。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$StateRoot,
    [double]$Hours = 26,
    [double]$SegmentSeconds = 300
)
$ErrorActionPreference = 'Stop'
# 引数配列で渡し、利用者入力をコマンド文字列として評価しない。
$taskScript = Join-Path $PSScriptRoot 'verify-runtime-durability.py'
& python $taskScript --state-root $StateRoot --hours $Hours --segment-seconds $SegmentSeconds
exit $LASTEXITCODE
