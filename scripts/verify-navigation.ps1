<#
初回案内と目的別メニューのブラウザー検証を実行します。
Python版と共通の検証手順を使い、本番認証や業務データに触れずに
日本語・中国語・狭い画面の表示と検索を確認します。
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# 呼び出し元に依存せず、同じ場所にあるPython版を起動します。
$verificationScript = Join-Path $PSScriptRoot 'verify-navigation.py'
& python $verificationScript
# 失敗を成功として扱わないよう、検証側の終了コードを返します。
exit $LASTEXITCODE
