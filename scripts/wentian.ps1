# Wentian CLI（コマンドライン / Command Line Interface）用PowerShellラッパーです。
# 引数は配列のままnpmへ渡し、文字列連結による意図しないコマンド解釈を防ぎます。
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$WentianArguments)
$ErrorActionPreference = 'Stop'
$ProjectDirectory = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $ProjectDirectory
try {
    # `--` 以降をWentian CLIへそのまま引き渡します。
    & npm.cmd run wentian -- @WentianArguments
    exit $LASTEXITCODE
}
finally { Pop-Location }
