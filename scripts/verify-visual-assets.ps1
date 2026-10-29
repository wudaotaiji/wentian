# 背景と人物制作の型検査と関連試験を実行します。
# 試験環境はtest-environment.tsで一時領域へ隔離します。
# 実際の画像生成サービスへの依頼や本番素材の変更は行いません。
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    Write-Host '型検査を実行します。'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw '型検査に失敗しました。' }
    Write-Host '隔離した素材制作・孵化器・AI会話の試験を実行します。'
    & node --import tsx --import ./src/test-environment.ts --test src/group-selection-ui.test.ts src/forge-scene.test.ts src/public-site.test.ts src/visual-assets.test.ts src/wentian-image-runtime.test.ts src/codex-image.test.ts src/external-agent-readiness.test.ts src/startup-forge-room.test.ts src/startup-forge-social-ui.test.ts src/startup-forge-motion-ui.test.ts src/group-human.test.ts src/group-chat-ui.test.ts src/group-management.test.ts src/group-agent-responder.test.ts src/agent-web-search.test.ts
    if ($LASTEXITCODE -ne 0) { throw '関連試験に失敗しました。' }
    Write-Host '背景と人物制作の検証が完了しました。'
} finally { Pop-Location }
