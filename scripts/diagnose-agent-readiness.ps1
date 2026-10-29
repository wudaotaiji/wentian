# Gatewayの表示用APIだけをGETし、Agentの利用可否と保留理由を保存します。
# 接続先と保存先は明示指定とし、組織固有の接続先を既定値にしません。
param([Parameter(Mandatory=$true)][string]$Server,[Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
# refreshや保守実行APIは呼ばず、既存の状態を読み取ります。
$data = Invoke-RestMethod -Uri ($Server.TrimEnd('/') + '/v1/manager/external-agents') -Method Get -TimeoutSec 30
# 秘密設定、依頼本文、CLIの起動引数を含めず、原因説明に必要な項目だけを選びます。
$agents = @($data.agents | ForEach-Object {
    @{id=$_.id;state=$_.state;stateLabel=$_.stateLabel;liveState=$_.liveState;excluded=$_.excluded;
      # 一時停止と権限取消を区別し、期限なしの既定保守権限を証跡へ含めます。
      executionAccess=$_.executionAccess;connectionStatus=$_.connection.status;deferredKind=$_.connection.maintenanceDeferredKind;
      reason=$_.connection.reason;workStatus=$_.workEvidence.status;workExpiresAt=$_.workEvidence.expiresAt}
})
$result = @{summary=$data.summary;refreshedAt=$data.refreshedAt;pools=$data.pools;agents=$agents}
$target = [IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
[IO.File]::WriteAllText($target, ($result | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
Write-Output ('Agent診断の証跡を保存しました: ' + $target)
