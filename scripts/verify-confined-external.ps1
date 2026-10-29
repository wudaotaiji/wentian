<#
実Claudeの限定変更提案（Confined Proposal）検収のPowerShell入口。
Python版に固定された新規一時領域・固定受入条件を使う。
既存プロジェクトは変更しない。モデルはホストが利用を許可したIDを指定する。
失敗を成功として返さず、Pythonの終了コードをそのまま引き継ぐ。
#>
[CmdletBinding()]
param([string]$Model = 'local-model')
$ErrorActionPreference = 'Stop'
$taskScript = Join-Path $PSScriptRoot 'verify-confined-external.py'
& python $taskScript --model $Model
exit $LASTEXITCODE
