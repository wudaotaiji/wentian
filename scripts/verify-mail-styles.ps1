# Python Playwright（パイソン・プレイライト / Python Playwright）による隔離検証を起動します。
# 本番データを変更せず、一時サーバーで画面操作・保存・再読込を確認します。
$ErrorActionPreference = 'Stop'
python -X utf8 (Join-Path $PSScriptRoot 'verify-mail-styles.py')
if ($LASTEXITCODE -ne 0) { throw 'メール画面のスタイル検証に失敗しました。' }
