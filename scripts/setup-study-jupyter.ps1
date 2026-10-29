# Jupyter専用モジュールの導入・更新・切り戻しをPython版へ委譲します。
# Python本体の指定は利用者設定から受け取り、組織固有の絶対パスを固定しません。
param(
    [string]$Python = '',
    [string]$Version = '',
    [string]$Root = '',
    [switch]$Rollback,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'setup-study-jupyter.py'
$pythonCommand = if ($Python) { $Python } elseif ($env:WENTIAN_MAINTENANCE_PYTHON) { $env:WENTIAN_MAINTENANCE_PYTHON } else { 'py' }
$arguments = @()
if ([IO.Path]::GetFileName($pythonCommand) -in @('py', 'py.exe')) { $arguments += '-3' }
$arguments += $scriptPath
if ($Version) { $arguments += @('--version', $Version) }
if ($Root) { $arguments += @('--root', $Root) }
if ($Rollback) { $arguments += '--rollback' }
if ($VerifyOnly) { $arguments += '--verify-only' }
Write-Host 'Wentianと分離したJupyter環境を検証・構成します。'
& $pythonCommand @arguments
if ($LASTEXITCODE -ne 0) { throw 'Jupyterモジュールの構成に失敗しました。有効版は維持されています。' }
