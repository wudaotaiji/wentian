# Python初期導入のPowerShell（パワーシェル / PowerShell）用入口です。
# 仮想環境（Virtual Environment）の準備は共通のPython版へ委譲し、処理の差を防ぎます。
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
# 登録済みPythonをランチャー（Launcher）で解決し、実行エイリアスを避けます。
& py -3 (Join-Path $PSScriptRoot 'setup-python.py')
if ($LASTEXITCODE -ne 0) { throw "Python依存の一括導入に失敗しました。終了コード: $LASTEXITCODE" }
