# Jupyterモジュールの型・認証・中継・Pluginを隔離試験で確認します。
# -Live時のみ専用環境の実Jupyterを起動し、一時ノートブックでセル実行まで検証します。
param([switch]$Live)
$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '型検査に失敗しました。' }
    & node --import tsx --import ./src/test-environment.ts --test src/study.test.ts src/navigation-ui.test.ts src/wentian-plugin-runtime.test.ts
    if ($LASTEXITCODE -ne 0) { throw '書房の隔離試験に失敗しました。' }
    if ($Live) {
        & node --import tsx scripts/verify-study-jupyter-runtime.ts
        if ($LASTEXITCODE -ne 0) { throw 'Jupyterの実カーネル検証に失敗しました。' }
        # Nodeだけでなく、Windowsの通常起動と同じBunでもHTTP・WebSocketを検証します。
        $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x64' }
        $bun = Join-Path (Get-Location) "node_modules/@oven/bun-windows-$architecture/bin/bun.exe"
        if (Test-Path -LiteralPath $bun) {
            & $bun scripts/verify-study-jupyter-runtime.ts
            if ($LASTEXITCODE -ne 0) { throw 'BunでのJupyter実カーネル検証に失敗しました。' }
        }
    }
} finally { Pop-Location }
