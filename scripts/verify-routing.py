"""ルーティング（Routing）改善の型検査と関連回帰テストを実行します。

PowerShell版と同じ対象を検証します。実モデルのロードや本番設定変更はせず、
既存のテスト環境初期化を利用します。検査失敗時は後続を実行せず終了します。
"""
from pathlib import Path
import shutil
import subprocess
import sys


def main() -> int:
    # Windowsの既定コードページでも、日本語ログをUTF-8で出力します。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    # スクリプトの位置からルートを決め、呼び出し元の作業場所に依存させません。
    workspace = Path(__file__).resolve().parent.parent
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    node = shutil.which("node")
    if not npm or not node:
        print("Node.jsとnpmが必要です。", file=sys.stderr)
        return 1
    print("型検査（Type Check）を実行します。", flush=True)
    result = subprocess.run([npm, "run", "build"], cwd=workspace)
    if result.returncode:
        return result.returncode
    # 一覧を明示し、PowerShell版と同じ回帰テストを再現可能にします。
    tests = ['manager', 'config', 'agent-planner', 'cli-inquiry', 'proxy', 'server', 'llm-fallback', 'team-gateway', 'external-orchestrator', 'runtime-control', 'runtime-routing-e2e', 'goal-loop', 'goal-store', 'storage', 'lifecycle', 'dashboard', 'navigation-ui', 'agent-session', 'agent-selection', 'agent-work-maintenance', 'task-workspace', 'workbench-e2e', 'control-plane-ui', 'chat-attachments', 'chat-agent']
    print("関連回帰テスト（Regression Test）を実行します。", flush=True)
    return subprocess.run(
        [node, "--import", "tsx", "--import", "./src/test-environment.ts", "--test", "--test-concurrency=2",
         *[f"src/{name}.test.ts" for name in tests]], cwd=workspace
    ).returncode


if __name__ == "__main__":
    sys.exit(main())
