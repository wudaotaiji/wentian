# Codexの旧Windowsサンドボックス初期化失敗を、公式推奨のMXC優先設定で修復します。
# 既存の承認ポリシーとファイル境界は維持し、常駐サーバーを強制終了しません。
# 設定変更前に公式の互換性検証を実行し、失敗した端末では変更しません。
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskConfig = Join-Path $env:USERPROFILE '.codex/config.toml'
& codex -c windows.sandbox=mxc sandbox -C $taskRoot --include-managed-config --permission-profile :workspace -- cmd.exe /d /c echo MXC_OK
if ($LASTEXITCODE -ne 0) { throw 'MXCの互換性検証に失敗したため設定を変更しません。' }
if (-not $Apply) { Write-Output '互換性検証成功。設定反映には -Apply を指定してください。'; exit 0 }
# UTF-8で読み、既存features節があればそこへ追加、なければ末尾に新設します。
$taskText = [IO.File]::ReadAllText($taskConfig)
if ($taskText -match '(?m)^prefer_mxc\s*=') { throw '既存のprefer_mxc設定を確認してください。自動上書きはしません。' }
$taskBackup = "$taskConfig.before-mxc-$(Get-Date -Format yyyyMMddHHmmss).bak"
[IO.File]::Copy($taskConfig, $taskBackup, $false)
if ($taskText -match '(?m)^\[features\]\s*$') {
    $taskText = [regex]::Replace($taskText, '(?m)^\[features\]\s*$', "[features]`nprefer_mxc = true", 1)
} else { $taskText += "`n[features]`nprefer_mxc = true`n" }
[IO.File]::WriteAllText($taskConfig, $taskText, [Text.UTF8Encoding]::new($false))
Write-Output "MXC優先設定を保存しました。退避先: $taskBackup"
