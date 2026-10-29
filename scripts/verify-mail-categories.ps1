# Python Playwright（パイソン・プレイライト / Python Playwright）で分類操作を検証します。
# AI応答だけを固定した一時環境で、本番のメール・分類設定は変更しません。
$ErrorActionPreference = 'Stop'
python -X utf8 (Join-Path $PSScriptRoot 'verify-mail-categories.py')
if ($LASTEXITCODE -ne 0) { throw 'メール分類の画面検証に失敗しました。' }
