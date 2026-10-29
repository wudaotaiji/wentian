<#
Startup Forgeの型検査と隔離試験を実行し、工程別ログと結果JSONを保存します。
Pythonの導入状況に依存せず、Python版と同じNodeコマンドを実行します。
試験は一時領域を使用し、本番グループや実LLMを変更しません。
#>
[CmdletBinding()]
param([string]$EvidenceDir, [switch]$SkipTypecheck)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
if (-not $EvidenceDir) { $EvidenceDir = Join-Path $taskRoot ('docs/evidence/startup-forge/' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')) }
$evidence = [IO.Path]::GetFullPath($EvidenceDir)
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$report = [ordered]@{ status='running'; scope='型検査と隔離試験。実LLM・本番データ・外部サービスは使わない。'; startedAt=[DateTime]::UtcNow.ToString('o'); steps=@() }
$steps = @()
if (-not $SkipTypecheck) { $steps += @{ name='typecheck'; arguments=@('node_modules/typescript/bin/tsc','--noEmit') } }
$steps += @{ name='tests'; arguments=@('--import','tsx','--import','./src/test-environment.ts','--test','--test-concurrency=1','src/startup-forge.test.ts','src/startup-forge-ui.test.ts','src/startup-forge-room.test.ts','src/group-chat-ui.test.ts','src/workbench.test.ts','src/agent-group.test.ts') }
# 引数は配列で渡し、入力値をコマンドとして評価しません。
Push-Location $taskRoot
try {
    foreach ($step in $steps) {
        $taskArgs = $step.arguments
        & node @taskArgs *> (Join-Path $evidence ($step.name + '.log'))
        $code = $LASTEXITCODE
        $report.steps += @{ name=$step.name; command=@('node')+$taskArgs; exitCode=$code; log=$step.name+'.log' }
        Write-Output ($step.name + ': 終了コード=' + $code)
        if ($code -ne 0) { throw ($step.name + ' が失敗しました。') }
    }
    $report.status='passed'
} catch {
    $report.status='failed'; $report.error=$_.Exception.Message
} finally {
    # 中断や失敗も証跡へ残し、後から実ファイルで確認できるようにします。
    $report | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence 'result.json') -Encoding UTF8
    Pop-Location
}
Write-Output ('証跡: ' + $evidence)
if ($report.status -ne 'passed') { exit 1 }
