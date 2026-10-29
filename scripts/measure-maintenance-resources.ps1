# システム全体を読み取り専用で計測します。失敗や未対応は呼出し側で未確認として扱います。
# CPUとディスクは稼働率、メモリは使用容量率、ネットワークはリンク速度に対する送受信合計です。
# ディスク容量は全固定ボリュームの最大使用率です。モデル取得先以外のシステム領域不足も検出します。
# 計測値のみ返し、ファイルの走査・削除やディスクへの試験書込みは行いません。
$ErrorActionPreference = 'Stop'
$cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
$memory = Get-CimInstance Win32_OperatingSystem
$disks = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object Name -ne '_Total')
$networks = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | Where-Object CurrentBandwidth -gt 0)
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')
if (!$volumes.Count) { throw '固定ディスクの空き容量を確認できません。' }
foreach ($volume in $volumes) {
    if (!$volume.Size -or $null -eq $volume.FreeSpace) { throw 'ディスクの容量使用率が未計測です。' }
}
$diskCapacity = ($volumes | ForEach-Object { 100 * (1 - [double]$_.FreeSpace / [double]$_.Size) } | Measure-Object -Maximum).Maximum
if ($null -eq $cpu.PercentProcessorTime -or !$memory.TotalVisibleMemorySize -or $null -eq $memory.FreePhysicalMemory) { throw 'CPUまたはメモリの使用率を確認できません。' }
if (!$disks.Count -or !$networks.Count) { throw 'ディスクまたはネットワークの使用率を確認できません。' }
foreach ($item in $disks) { if ($null -eq $item.PercentIdleTime) { throw 'ディスクの使用率が未計測です。' } }
foreach ($item in $networks) { if ($null -eq $item.BytesTotalPersec) { throw 'ネットワークの使用率が未計測です。' } }
$disk = ($disks | ForEach-Object { 100 - [double]$_.PercentIdleTime } | Measure-Object -Maximum).Maximum
$network = ($networks | ForEach-Object { 800 * [double]$_.BytesTotalPersec / [double]$_.CurrentBandwidth } | Measure-Object -Maximum).Maximum
@{ cpu = [double]$cpu.PercentProcessorTime; memory = 100 * (1 - [double]$memory.FreePhysicalMemory / [double]$memory.TotalVisibleMemorySize); network = [double]$network; disk = [Math]::Max(0, [double]$disk); diskCapacity = [double]$diskCapacity } | ConvertTo-Json -Compress
