<#
GooseのCodex連携のPowerShell入口です。
モデル・権限・標準入力の検査はPython版へ集約し、両方の入口で同じ制約を使います。
Pythonの場所は利用者設定WENTIAN_MAINTENANCE_PYTHON、またはpyランチャーから取得します。
プロンプトや認証値を引数やログへ展開しません。
#>
param()
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$pythonCommand = $env:WENTIAN_MAINTENANCE_PYTHON
if ($pythonCommand) {
    & $pythonCommand (Join-Path $PSScriptRoot 'run-goose-codex.py')
} else {
    & py -3 (Join-Path $PSScriptRoot 'run-goose-codex.py')
}
exit $LASTEXITCODE
