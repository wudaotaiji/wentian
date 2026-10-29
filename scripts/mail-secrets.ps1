<#
メール連携の認証情報をWindows DPAPI（データ保護API）で保管するPowerShell入口です。
秘密値をコマンドラインへ渡さず、Python版の非表示入力で受け取ります。
Get操作はサーバー内のパイプ専用です。端末で復号値を表示しないでください。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('set','get','list')][string]$Action,
    [string]$Name,
    [string]$File
)
$ErrorActionPreference='Stop'
# 引数は配列で渡し、認証情報名や保存先をシェルのコードとして解釈させません。
$secretArguments=@((Join-Path $PSScriptRoot 'mail-secrets.py'),$Action)
if($Name){$secretArguments+=@('--name',$Name)}
if($File){$secretArguments+=@('--file',$File)}
& python @secretArguments
exit $LASTEXITCODE
