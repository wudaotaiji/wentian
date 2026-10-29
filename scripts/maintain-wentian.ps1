<#
Wentianの保守（Maintenance）のPowerShell入口。
Python版と同じ管理領域・全件検査・停止宣言・変更拒否の仕様を使用する。
バックアップ/復元/版切替では、実際に停止を確認してRuntimeStoppedを指定する。
OverwriteDriftedは他の作業状態を上書きするため、復元対象を確認した場合だけ指定する。
実アプリの起動・停止・外部配備は行わず、Active-Entrypointは検証済み起動ファイルの場所を返す。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('backup','verify-backup','restore-backup','recover-publication','stage-release','verify-release','switch-release','rollback-release','active-entrypoint')][string]$Action,
    [string]$StateRoot,[string]$Workspace,[string]$ReleaseRoot,[string]$CandidateRoot,[string]$BackupId,[string]$VersionId,
    [switch]$RuntimeStopped,[switch]$OverwriteDrifted
)
$ErrorActionPreference = 'Stop'
$taskArguments = @('--action', $Action)
# 引数配列で渡し、パスや版名をシェル文字列として評価しない。
foreach ($taskPair in @(@('--state-root',$StateRoot),@('--workspace',$Workspace),@('--release-root',$ReleaseRoot),@('--candidate-root',$CandidateRoot),@('--backup-id',$BackupId),@('--version-id',$VersionId))) {
    if ($taskPair[1]) { $taskArguments += $taskPair }
}
if ($RuntimeStopped) { $taskArguments += '--runtime-stopped' }
if ($OverwriteDrifted) { $taskArguments += '--overwrite-drifted' }
& python (Join-Path $PSScriptRoot 'maintain-wentian.py') @taskArguments
exit $LASTEXITCODE
