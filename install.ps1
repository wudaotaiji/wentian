# ASCII entry point for Windows PowerShell 5.1 -File and irm | iex.
[CmdletBinding()]
param(
    [string]$SourceDirectory,
    [string]$InstallRoot,
    [switch]$NoPathUpdate
)
$ErrorActionPreference = 'Stop'
if ($SourceDirectory) {
    $core = Get-Content -LiteralPath (Join-Path $SourceDirectory 'install_core.ps1') -Raw -Encoding UTF8
} else {
    $core = Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/wudaotaiji/wentian/main/install_core.ps1'
}
& ([scriptblock]::Create($core.TrimStart([char]0xFEFF))) @PSBoundParameters
