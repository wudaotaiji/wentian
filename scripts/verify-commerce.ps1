# 商取引の性能検証（Performance Verification）を合成データだけで実行します。
# 台帳はメモリー内、HTTPは一時的なローカルポートです。実決済は起動しません。
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
    node --import tsx src/commerce-verify.ts
    if ($LASTEXITCODE -ne 0) { throw '商取引の性能検証に失敗しました。' }
} finally { Pop-Location }
