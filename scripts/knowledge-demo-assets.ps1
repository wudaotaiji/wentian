<#
.SYNOPSIS
配布用の架空PDF・画像・音声を再生成します。通常の機能確認には不要です。
.DESCRIPTION
Python環境にreportlab・Pillow・PyMuPDF、およびWindowsに日本語音声が二つ必要です。
Fontは日本語TrueType/TTCフォント、Outputは新規フォルダーを指定します。
#>
param(
  [Parameter(Mandatory=$true)][string]$Output,
  [Parameter(Mandatory=$true)][string]$Font,
  [string]$Python = 'python'
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$OutputEncoding=[System.Text.UTF8Encoding]::new($false)
& $Python (Join-Path $PSScriptRoot 'knowledge-demo-assets.py') --output $Output --font $Font
exit $LASTEXITCODE
