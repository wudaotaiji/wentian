<#
実モデル起動の資源監視付き検証です。通常はPython版へ引数を転送します。
Monitor指定はPython版から使う読み取り専用の継続計測モードです。
一回のPowerShell起動を使い続け、計測用プロセスの連続起動を避けます。
認証情報、モデル本体、利用者ファイルをログへ出力しません。
#>
param(
    [switch]$Monitor,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
if (!$Monitor) {
    & python (Join-Path $PSScriptRoot 'verify-model-load-resources.py') @Arguments
    exit $LASTEXITCODE
}
while ($true) {
    try {
        # 稼働率と容量使用率は別の項目です。容量も記録しますが変更しません。
        $resourceJson = & (Join-Path $PSScriptRoot 'measure-maintenance-resources.ps1')
        $usage = ConvertFrom-Json -InputObject $resourceJson
        if ($null -eq $usage) { throw '資源計測の応答が空です。' }
        $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
        $engines = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | ForEach-Object {
            @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; created = $_.CreationDate.ToUniversalTime().ToString('o') }
        })
        @{ time = [DateTime]::UtcNow.ToString('o'); usage = $usage; readBytesPerSec = [double]$disk.DiskReadBytesPersec;
           queue = [double]$disk.CurrentDiskQueueLength; engines = $engines } | ConvertTo-Json -Compress -Depth 5
    } catch {
        # 計測に失敗した場合はPython側で試験を停止します。例外本文の秘密情報は出しません。
        @{ time = [DateTime]::UtcNow.ToString('o'); error = '資源計測に失敗しました。' } | ConvertTo-Json -Compress
    }
    Start-Sleep -Milliseconds 500
}
