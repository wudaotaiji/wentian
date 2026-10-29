# Python版のブラウザ（Browser）確認を同じ作業フォルダーで起動します。
# 読み取り専用の確認で、認証情報やメール本文をログへ出力しません。
param([switch]$LocateBlocked)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
# 利用可能なPython（パイソン / Python）でPlaywrightを実行します。
# 停止メールの確認は明示された場合だけ行い、本文取得やメールサーバーの変更は行いません。
$taskArgs = @()
if ($LocateBlocked) { $taskArgs += '--locate-blocked' }
python (Join-Path $PSScriptRoot 'inspect-mail-live.py') @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'メール画面の読み取り確認に失敗しました。' }
