# Generate a strong Gateway API key and persist it for the current Windows user.
[CmdletBinding()]
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$existing = [Environment]::GetEnvironmentVariable('WENTIAN_API_KEY', 'User')
if ($existing -and -not $Force) { throw 'WENTIAN_API_KEY is already configured. Use -Force to rotate it.' }
$bytes = [byte[]]::new(48)
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
$key = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
[Environment]::SetEnvironmentVariable('WENTIAN_API_KEY', $key, 'User')
[Environment]::SetEnvironmentVariable('WENTIAN_API_KEY', $key, 'Process')
Write-Output 'WENTIAN_API_KEY configured for the current Windows user. Restart Wentian to apply it.'
