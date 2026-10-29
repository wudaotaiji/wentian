<#
.SYNOPSIS
知識庫収集に使うログイン状態を、利用者のブラウザー操作で保存します。
.DESCRIPTION
接続先、保存先、必要ならブラウザー実行ファイルを明示してください。
パスワードや多要素認証の値は、このスクリプトの引数やログへ渡しません。
Node.jsの共通実行部が独立したブラウザーを開き、Enter入力後に状態を保存します。
#>
param(
    [Parameter(Mandatory=$true)][string]$Url,
    [Parameter(Mandatory=$true)][string]$Output,
    [string]$Executable,
    [switch]$Replace
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1の子プロセス出力もUTF-8として扱い、日本語の文字化けを防ぎます。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# 文字列をコマンドとして組み立てず、個別引数として共通実行部へ渡します。
$loginArguments = @((Join-Path $PSScriptRoot 'knowledge-login.mjs'), '--url', $Url, '--output', [System.IO.Path]::GetFullPath($Output))
if ($Executable) { $loginArguments += @('--executable', $Executable) }
if ($Replace) { $loginArguments += '--replace' }
& node @loginArguments
exit $LASTEXITCODE
