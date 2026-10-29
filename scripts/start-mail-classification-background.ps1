<#
分類学習ワーカーをブラウザーから独立した非表示プロセスで開始します。
人手確認済みメールを監視し、正解例が11件に達すると実学習を開始します。
ブラウザーやPowerShell画面を閉じても、サーバープロセスは動作を継続します。
#>
$ErrorActionPreference = 'Stop'
$mailWorkerLauncher = Join-Path $PSScriptRoot 'start-mail-classification-background.py'
& python $mailWorkerLauncher
if ($LASTEXITCODE -ne 0) { throw '分類学習ワーカーを起動できませんでした。' }
