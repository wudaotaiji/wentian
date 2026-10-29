# 模擬データだけのローカルプレビュー（Local Preview）を起動します。
# 元の作業場所を保持し、終了や例外発生時にも戻します。
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    # 専用の識別応答だけを信頼し、別サービスのポート使用を成功扱いしません。
    # 再実行時は同じ検証画面を案内して終了し、既存プロセスを停止しません。
    try {
        $previewStatus = Invoke-RestMethod -Uri 'http://127.0.0.1:8799/api/commerce/preview-status' -TimeoutSec 2
        if ($previewStatus.kind -eq 'wentian-commerce-preview' -and $previewStatus.payments -eq 'disabled') {
            Write-Host '検証専用プレビューは起動済みです: http://127.0.0.1:8799/commerce'
            return
        }
    } catch {
        # 未起動・別サービス・旧版の場合は通常起動へ進み、元の診断を表示します。
    }
    # 本番とは異なるポート8799と検証専用台帳を利用します。
    node --import tsx src/commerce-preview.ts
    if ($LASTEXITCODE -ne 0) { throw "検証専用プレビューが終了コード $LASTEXITCODE で異常終了しました。直前のNode.jsエラーを確認してください。EADDRINUSEの場合は8799番ポートが使用中です。" }
} finally { Pop-Location }
