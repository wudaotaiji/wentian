<#
.SYNOPSIS
知識庫機能確認用の架空資料を準備・配信します。
.DESCRIPTION
Python版と共通の実装を呼び出します。本番の設定やデータは変更しません。
PrepareのDirectoryには、存在しない新規フォルダーを指定してください。
Serveはループバックだけで配信し、Ctrl+Cで停止します。
Revision2は更新同期、Expire/Activateは認証失効・復旧の確認に使用します。
#>
param(
  [Parameter(Mandatory=$true)][ValidateSet('prepare','serve','revision1','revision2','expire','activate','large','verify')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Directory,
  [ValidateRange(0,65535)][int]$Port = 0,
  [string]$Projects = 'demo-knowledge,demo-media',
  [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# パスや利用者設定をコマンド文字列として評価しないよう、配列引数で渡します。
& $Python (Join-Path $PSScriptRoot 'knowledge-demo.py') $Action --directory $Directory --port $Port --projects $Projects
exit $LASTEXITCODE
