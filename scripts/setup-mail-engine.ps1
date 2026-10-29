# メール学習環境のPowerShell入口です。実際の環境作成は同名Python版へ委譲し、
# Windowsと他環境で依存関係や版の扱いがずれないようにします。
$ErrorActionPreference = 'Stop'
$mailSetupScript = Join-Path $PSScriptRoot 'setup-mail-engine.py'
& python $mailSetupScript
if ($LASTEXITCODE -ne 0) { throw 'メール学習環境の準備に失敗しました。' }
