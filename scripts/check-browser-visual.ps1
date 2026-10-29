<#
人間向けの外観確認の準備をPython版へ委譲するPowerShell入口。
接続先ごとのHTTP応答を表示し、Open指定時だけ既定ブラウザで3画面を開く。
認証設定・拡張機能・稼働プロセスには変更を加えない。
終了コード0は通信完了であり、見た目の合格を意味しない。
#>
[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:8787', [switch]$Open)
$ErrorActionPreference = 'Stop'
# 引数配列で渡し、URLをシェルのコードとして解釈しない。
$taskArguments = @((Join-Path $PSScriptRoot 'check-browser-visual.py'), '--base-url', $BaseUrl)
if ($Open) { $taskArguments += '--open' }
& python @taskArguments
exit $LASTEXITCODE
