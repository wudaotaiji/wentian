<#
実時間の耐久試験終了後に、改善台帳へ合否を反映するPowerShell入口。
Python版と同じ検査本体を使い、無観測時間・不変条件・二重反映・終了時の全体試験を確認する。
短縮時計や単なるプロセス生存で合格にしない。失敗時はfinal-acceptance.jsonへ理由を保存する。
通常は専用の背景プロセスで実行し、PCを停止・スリープさせず完了まで観測する。
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Harness, [Parameter(Mandatory = $true)][string]$Document)
$ErrorActionPreference = 'Stop'
# 移行済み私有台帳の保存先を必須引数で受け取り、公開docsへ内部資料を再生成しません。
& python (Join-Path $PSScriptRoot 'finalize-improvements.py') --harness $Harness --document $Document
exit $LASTEXITCODE
