<#
.SYNOPSIS
AI会話グループ（Group）のCLIを呼び出します。
.DESCRIPTION
名前・役割・モデルなどの引数を配列で渡し、空白を含む値を保持します。
現在の作業領域を変更せず、CLIの終了コードを返します。
Node.jsとリポジトリの依存パッケージが必要です。
.EXAMPLE
pwsh -NoProfile -File scripts/agent-group.ps1 create "開発相談室"
#>
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GroupArguments)
$ErrorActionPreference = 'Stop'
# スクリプト自身の配置先を基準としてCLIを特定します。
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cliEntry = Join-Path $repositoryRoot 'bin/wentian.js'
# シェル文字列を組み立てず、引数境界を保って実行します。
& node $cliEntry group @GroupArguments
exit $LASTEXITCODE
