# 会議文字起こしのPowerShell入口です。同じPython処理を使用して結果を統一します。
# Pythonの場所は明示引数または既存の音声環境設定から受け取ります。
# 会議本文や秘密値をログに出さず、引数配列で起動してシェル展開を避けます。
param(
    [Parameter(Mandatory=$true)][string]$Directory,
    [ValidateSet('auto','ja','zh','en')][string]$Language = 'auto',
    [string]$Python = $env:WENTIAN_VIDEO_PYTHON
)
$ErrorActionPreference = 'Stop'
if (!$Python) { $Python = Join-Path (Split-Path $PSScriptRoot -Parent) '.wentian/video-engine/Scripts/python.exe' }
if (!(Test-Path -LiteralPath $Python -PathType Leaf)) { throw '音声用Pythonの場所を指定してください。' }
$target = (Resolve-Path -LiteralPath $Directory).Path
& $Python (Join-Path $PSScriptRoot 'meeting-transcribe.py') --directory $target --language $Language
if ($LASTEXITCODE -ne 0) { throw '会議の文字起こしに失敗しました。' }
