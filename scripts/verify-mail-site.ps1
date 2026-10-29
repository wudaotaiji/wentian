<#
Python版プレイライト（Playwright）によるMail Solutionsの画面検証を実行します。
検証は専用の一時領域で行い、稼働中サイトや利用者の保存データを変更しません。
証跡はdocs/evidence/mail-site/20261008へ保存します。
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# スクリプト自身の位置からPython版を解決し、呼び出し元の場所に依存しないようにします。
$verificationScript = Join-Path $PSScriptRoot 'verify-mail-site.py'
& python $verificationScript
# Pythonの終了コードをそのまま返し、失敗を成功として扱わないようにします。
exit $LASTEXITCODE
