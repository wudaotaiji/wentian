# 一時認証台帳と一時ブラウザーを使用するNode検証へ、引数を配列で渡します。
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InstallRoot,[string]$Output)
$ErrorActionPreference='Stop'
$verificationArguments=@((Join-Path $PSScriptRoot 'verify-public-install.mjs'),'--install-root',$InstallRoot)
if($Output){$verificationArguments+=@('--output',$Output)}
& node @verificationArguments
exit $LASTEXITCODE
