# ルーティング（Routing）改善の型検査と関連回帰テストを実行します。
# 実モデルのロード、外部エージェントへの作業委譲、本番設定の変更は行いません。
# カレントディレクトリに依存しないよう、スクリプトの親を作業ルートにします。
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $workspace
try {
    Write-Host '型検査（Type Check）を実行します。'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    # テスト環境初期化を読み込み、対象モジュールとCLI接続の回帰を確認します。
    Write-Host '関連回帰テスト（Regression Test）を実行します。'
    & node --import tsx --import ./src/test-environment.ts --test --test-concurrency=2 src/manager.test.ts src/config.test.ts src/agent-planner.test.ts src/cli-inquiry.test.ts src/proxy.test.ts src/server.test.ts src/llm-fallback.test.ts src/team-gateway.test.ts src/external-orchestrator.test.ts src/runtime-control.test.ts src/runtime-routing-e2e.test.ts src/goal-loop.test.ts src/goal-store.test.ts src/storage.test.ts src/lifecycle.test.ts src/dashboard.test.ts src/navigation-ui.test.ts src/agent-session.test.ts src/agent-selection.test.ts src/agent-work-maintenance.test.ts src/task-workspace.test.ts src/workbench-e2e.test.ts src/control-plane-ui.test.ts src/chat-attachments.test.ts src/chat-agent.test.ts
    exit $LASTEXITCODE
} finally {
    # 成否を問わず、呼び出し元の作業ディレクトリへ戻します。
    Pop-Location
}
