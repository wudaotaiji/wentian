<#
.SYNOPSIS
ビデオ会議・録画・文字起こし・議事録・同意付き遠隔支援を隔離検証し、Markdownとログを保存します。
.DESCRIPTION
同梱Python版に処理をまとめ、PowerShellでも同じ試験と証跡を使います。
実際のカメラ・相手のPC・本番の群へ試験入力を送りません。
#>
param([string]$Python='py',[string]$OpenSSL,[string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
$verifyPath=Join-Path $PSScriptRoot 'verify-meetings.py'
$verifyArguments=@($verifyPath)
if($EvidenceDirectory){$verifyArguments+=@('--evidence-dir',$EvidenceDirectory)}
if($OpenSSL){$verifyArguments+=@('--openssl',$OpenSSL)}
if($Python -eq 'py'){& $Python -3 @verifyArguments}else{& $Python @verifyArguments}
exit $LASTEXITCODE
