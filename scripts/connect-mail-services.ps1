<#
調査済みIMAPとBusinessRecordsの接続を準備します。
停止しているBusinessRecordsを起動し、初期認証をWindows DPAPIへ暗号化保管します。
取り込みは受信トレイの直近5UIDだけで、外部の業務レコード登録は行いません。
#>
$ErrorActionPreference = 'Stop'
$mailConnectionScript = Join-Path $PSScriptRoot 'connect-mail-services.py'
& python $mailConnectionScript
exit $LASTEXITCODE
