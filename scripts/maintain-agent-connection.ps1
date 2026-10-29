# 自動保守の接続設定ブリッジ（Bridge）をPowerShellから呼び出します。
# 既定は検査だけで、-Applyを指定した場合のみバックアップ（Backup）後に反映します。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Agent,
    [Parameter(Mandatory)][ValidateSet('free','local','native')][string]$Mode,
    [Parameter(Mandatory)][string]$Model,
    [string]$AgentHome = [Environment]::GetFolderPath('UserProfile'),
    [string]$ReportRoot = (Join-Path $PSScriptRoot '..\.wentian\connection-backups'),
    [switch]$Apply,
    [string]$BaseUrl = 'http://127.0.0.1:1234/v1',
    [switch]$Gateway,
    [string]$Rollback
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
# コマンド文字列の連結を避け、モデル名・パスを独立した引数として渡します。
$bridgeArgs = @((Join-Path $PSScriptRoot 'maintain-agent-connection.py'), '--agent', $Agent, '--mode', $Mode, '--model', $Model, '--home', $AgentHome, '--report-root', $ReportRoot)
# 内部モデルはGateway（ゲートウェイ / Gateway）経由で指定し、認証値はPython側の環境から取得します。
$bridgeArgs += @('--base-url', $BaseUrl)
if ($Gateway) { $bridgeArgs += '--gateway' }
if ($Apply) { $bridgeArgs += '--apply' }
# 応答検証に失敗した候補の設定だけを、並行変更がないことを確認して復元します。
if ($Rollback) { $bridgeArgs += @('--rollback', $Rollback) }
# Windowsのpython実行エイリアス（Execution Alias）ではなく、登録済みPythonをランチャー（Launcher）から起動します。
# 明示した実行ファイルがある場合は、その指定を優先します。
$projectPython = Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'
if ($env:WENTIAN_MAINTENANCE_PYTHON) {
    $pythonExecutable = $env:WENTIAN_MAINTENANCE_PYTHON.Trim()
    if ([IO.Path]::GetFileNameWithoutExtension($pythonExecutable) -eq 'py') { & $pythonExecutable -3 @bridgeArgs }
    else { & $pythonExecutable @bridgeArgs }
} elseif (Test-Path -LiteralPath $projectPython) { & $projectPython @bridgeArgs }
elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot '..\.wentian\planner-engine\Scripts\python.exe')) {
    # Gatewayが管理する導入済み環境にはPyYAMLがあり、システムPythonの依存不足を回避できます。
    & (Join-Path $PSScriptRoot '..\.wentian\planner-engine\Scripts\python.exe') @bridgeArgs
}
else { & py -3 @bridgeArgs }
if ($LASTEXITCODE -ne 0) { throw "接続設定の保守が失敗しました。終了コード: $LASTEXITCODE" }
