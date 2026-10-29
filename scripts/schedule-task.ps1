<#
.SYNOPSIS
Wentianのタスク予約コマンド（Command）を呼び出します。
.DESCRIPTION
残りの引数をそのままCLIへ渡します。シェル文字列の組み立てを避け、
依頼文やパス内の空白を保持します。現在の作業フォルダーは変更しません。
Node.jsと、このリポジトリの依存パッケージが必要です。
.EXAMPLE
pwsh -NoProfile -File scripts/schedule-task.ps1 add --every 30m --prompt "状態確認"
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ScheduleArguments)
$ErrorActionPreference = 'Stop'
# スクリプトの配置場所を基準にCLIの絶対パスを求めます。
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cliEntry = Join-Path $repositoryRoot 'bin/wentian.js'
# 引数は配列として渡し、CLIの終了コードを呼び出し元へ伝えます。
& node $cliEntry schedule @ScheduleArguments
exit $LASTEXITCODE
