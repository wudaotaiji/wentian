<#
.SYNOPSIS
停止中のWentian管理者を、ユーザーIDを維持して復旧します。
.DESCRIPTION
StoreにはサーバーのWENTIAN_USER_STOREと同じ台帳を明示指定します。
Listは管理者一覧の読み取り専用操作です。変更時のパスワードは非表示で
二度入力し、コマンド引数や環境変数に入れず標準入力へ渡します。
DMや群履歴を削除せず、既存管理者以外を管理者へ昇格させません。
#>
param([Parameter(Mandatory=$true)][string]$Store, [switch]$List, [string]$UserId, [string]$Username)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $taskRoot 'src/user-recovery.ts'
$resolvedStore = (Resolve-Path -LiteralPath $Store).Path
Push-Location $taskRoot
try {
    if ($List) { & node --import tsx $entry $resolvedStore --list; exit $LASTEXITCODE }
    if (-not $UserId) { throw 'UserIdを指定してください。' }
    $first = Read-Host '新しいパスワード（12文字以上）' -AsSecureString
    $second = Read-Host 'もう一度入力' -AsSecureString
    # 平文は子プロセスへ渡す瞬間だけメモリに置き、出力しません。
    $password = [System.Net.NetworkCredential]::new('', $first).Password
    $confirmation = [System.Net.NetworkCredential]::new('', $second).Password
    if ($password -cne $confirmation) { throw '確認用パスワードが一致しません。' }
    $payload = @{ userId=$UserId; password=$password }
    if ($Username) { $payload.username=$Username }
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    $payload | ConvertTo-Json -Compress | & node --import tsx $entry $resolvedStore
    $result = $LASTEXITCODE
    $password=$confirmation=$null; $payload.Clear(); $first.Dispose(); $second.Dispose()
    exit $result
} finally { Pop-Location }
