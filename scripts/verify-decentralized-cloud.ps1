<#
分散CloudとAI最小内核の隔離検証をPython版と同じ手順で実行します。
Python未導入のPCでも使えるよう、この版はNode.jsを直接呼び出します。
本番の8787番や外部AIを使わず、試験内で一時台帳・試験鍵・模擬AIを生成します。
Outputを省略した場合、結果は一時フォルダーに保存されます。
コマンドを配列で管理し、利用者の秘密環境変数は記録しません。
#>
[CmdletBinding()]
param([string]$Output)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (!$Output) { $Output = Join-Path ([IO.Path]::GetTempPath()) ('wentian-federation-check-' + [guid]::NewGuid()) }
$evidencePath = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Path $evidencePath -Force | Out-Null
$checks = @(
    @{ Arguments = @('node_modules/typescript/bin/tsc', '--noEmit') },
    @{ Arguments = @('--import', 'tsx', '--import', './src/test-environment.ts', '--test', '--test-concurrency=1', 'src/cloud-federation.test.ts', 'src/cloud-federation-ui.test.ts', 'src/plugin-kernel.test.ts', 'src/plugin-config.test.ts', 'src/wentian-plugin-runtime.test.ts', 'src/personal-cloud.test.ts', 'src/server.test.ts', 'src/agent-group.test.ts', 'src/workbench.test.ts', 'src/group-chat-ui.test.ts') }
)
$results = @()
Push-Location $projectRoot
try {
    for ($index = 0; $index -lt $checks.Count; $index++) {
        $logName = "check-$index.log"
        $commandArgs = $checks[$index].Arguments
        Write-Output ('隔離検証を実行します：{0}/{1}' -f ($index + 1), $checks.Count)
        & node @commandArgs *> (Join-Path $evidencePath $logName)
        $resultCode = $LASTEXITCODE
        $results += @{ command = @('node') + $commandArgs; exitCode = $resultCode; log = $logName }
        if ($resultCode -ne 0) { break }
    }
} finally {
    Pop-Location
}
$passed = $results.Count -eq $checks.Count -and @($results | Where-Object { $_.exitCode -ne 0 }).Count -eq 0
@{ success = $passed; ai = '模擬AIのみ。実モデルの品質は未検証。'; checks = $results } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidencePath 'result.json') -Encoding utf8
Write-Output "検証結果：$passed。保存先：$evidencePath"
if (!$passed) { exit 1 }
exit 0
