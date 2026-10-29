# 小さな修正の反復検証（Repeated Validation）をGateway内部の直接実行で行います。
# 既存アプリを変更せず、結果を.wentian、専用フィクスチャーを一時領域へ保持します。
[CmdletBinding()]
param(
    [string]$Server = 'http://127.0.0.1:8787',
    [string]$Model = 'lmstudio/local-model',
    [ValidateRange(1,5)][int]$Repeat = 3,
    [switch]$CheckApi,
    [ValidateRange(0,300)][int]$IntervalSeconds = 60,
    [string]$ArchiveExisting
)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
# PowerShellとPythonで同じ実行・判定を使用し、引数をシェル文字列へ連結しません。
$validationArgs = @((Join-Path $PSScriptRoot 'verify-wentian-small-task.py'), '--server', $Server, '--model', $Model, '--repeat', "$Repeat", '--interval-seconds', "$IntervalSeconds")
if ($CheckApi) { $validationArgs += '--check-api' }
# 既存試験の残存資料を退避する場合、新しいLLM試験は実行しません。
if ($ArchiveExisting) { $validationArgs += @('--archive-existing', $ArchiveExisting) }
& python @validationArgs
exit $LASTEXITCODE
