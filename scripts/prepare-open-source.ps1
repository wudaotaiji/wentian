<#
.SYNOPSIS
公開用ソースの検査とアーカイブ（Archive）作成を実行します。
.DESCRIPTION
Python版と同じ除外・検査ルールを使います。Git履歴、秘密設定、実行時データを
含めず、現在の作業ツリーから公開候補を作成します。自動で公開・プッシュしません。
docs配下はpublic_release_documents.jsonの完全一致リストだけを許可し、
未登録の文書や添付資料を既定で除外します。非配布文書への相対リンクも検査します。
.PARAMETER AuditOnly
検査だけを実行します。
.PARAMETER Python
使用するPython実行ファイルです。
.PARAMETER SelfTest
秘密設定の除外と企業接続先の検出の回帰試験（Regression Test）だけを実行します。
#>
param([switch]$AuditOnly, [switch]$SelfTest, [string]$Python = 'python')
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1でも日本語の検査結果をUTF-8で受け渡します。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# 引数を配列で渡し、利用者入力をコマンド文字列へ組み立てません。
$releaseArguments = @((Join-Path $PSScriptRoot 'prepare-open-source.py'))
if ($AuditOnly) { $releaseArguments += '--audit-only' }
if ($SelfTest) { $releaseArguments += '--self-test' }
& $Python @releaseArguments
if ($LASTEXITCODE -ne 0) { throw '公開用ソースの検査に失敗しました。検出箇所を確認してください。' }
