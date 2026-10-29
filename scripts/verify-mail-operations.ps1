<#
メール業務のPython Playwright検証を実行します。
メールアプリとBusinessRecordsの保存先は一時領域へ分離され、実業務データを変更しません。
画面証跡と結果はdocs/evidence/mail-operations/20261008へ出力します。
#>
$ErrorActionPreference = 'Stop'
$mailVerificationScript = Join-Path $PSScriptRoot 'verify-mail-operations.py'
& python $mailVerificationScript
exit $LASTEXITCODE
