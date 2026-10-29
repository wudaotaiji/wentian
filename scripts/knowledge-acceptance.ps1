<#
.SYNOPSIS
知識庫の実資料・実モデル検収を、本番知識庫から隔離して実行します。
.DESCRIPTION
モデル・接続先・キーは環境変数で受け取り、引数やログへ公開しません。
Codex Agentを選ぶ場合は接続先URLを使わず、Wentianの検証済み接続を使います。
Python版と共通の処理を呼び出し、終了コードを保持します。
成果本文が含まれるため、Outputは非公開の新規フォルダーを指定してください。
#>
param(
  [Parameter(Mandatory=$true)][string]$Dataset,
  [Parameter(Mandatory=$true)][string]$Output,
  [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# 引数を個別に渡し、利用者のパスをコマンド文字列として評価しません。
& $Python (Join-Path $PSScriptRoot 'knowledge-acceptance.py') --dataset $Dataset --output $Output
exit $LASTEXITCODE
