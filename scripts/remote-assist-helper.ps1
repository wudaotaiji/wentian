<#
.SYNOPSIS
本人同意付きのWindows遠隔支援プラグインを起動します。
.DESCRIPTION
同梱Python版を通常権限で実行します。会議のOriginを明示し、ヘルパーの接続キーを
操作される側のブラウザーだけに入力してください。終了すると許可と押下状態を解放します。
Pythonの場所は利用者が指定でき、利用組織固有のパスを既定値にしません。
#>
param([Parameter(Mandatory=$true)][string]$Origin,[string]$Python='py',[int]$Port=8791,[string]$Certificate,[string]$PrivateKey,[ValidateSet('ja','en','zh')][string]$Language='ja')
$ErrorActionPreference='Stop'
$helperPath=Join-Path $PSScriptRoot 'remote-assist-helper.py'
$helperArguments=@($helperPath,'--origin',$Origin,'--port',[string]$Port,'--language',$Language)
if($Certificate -or $PrivateKey){if(!$Certificate -or !$PrivateKey){throw '証明書と秘密鍵を両方指定してください。'};$helperArguments+=@('--cert',$Certificate,'--key',$PrivateKey)}
if($Python -eq 'py'){& $Python -3 @helperArguments}else{& $Python @helperArguments}
exit $LASTEXITCODE
