<#
実Edgeで外観確認用の画像を取得するPython版の入口。
専用仮想環境（Virtual Environment）にPlaywrightを導入してから実行する。
認証はPython版が既存設定から読み取り、値を画面やログへ出力しない。
終了コード0は画面応答とスクリプトエラーなしの確認であり、画像の目視検収は別に行う。
#>
[CmdletBinding()]
param([string]$BaseUrl='http://127.0.0.1:8787', [string]$EnvFile='.env', [string]$Output='docs/evidence/browser-visual', [switch]$Headed, [switch]$ManualLogin)
$ErrorActionPreference='Stop'
# 専用Pythonの絶対パスをスクリプト位置から解決し、シェル文字列を組み立てない。
$taskPython=Join-Path (Split-Path $PSScriptRoot) '.wentian/browser-venv/Scripts/python.exe'
$taskArguments=@((Join-Path $PSScriptRoot 'verify-browser-visual.py'),'--base-url',$BaseUrl,'--env-file',$EnvFile,'--output',$Output)
if($Headed){$taskArguments+='--headed'}
if($ManualLogin){$taskArguments+='--manual-login'}
& $taskPython @taskArguments
exit $LASTEXITCODE
