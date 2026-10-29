"""Wentianのタスク予約CLIを呼び出す補助スクリプト（Script）。

現在の作業フォルダーを保持し、登録対象のワークスペース（Workspace）に
影響を与えません。引数を配列で渡すため、空白や記号を含む依頼文も安全に
CLIへ渡せます。Node.jsとリポジトリの依存パッケージが必要です。
"""
from pathlib import Path
import subprocess
import sys


def main() -> int:
    """CLIを同期実行し、終了コードをそのまま返します。"""
    # 起動フォルダーではなく、スクリプト自身の場所からCLIを特定します。
    repository_root = Path(__file__).resolve().parent.parent
    cli_entry = repository_root / "bin" / "wentian.js"
    # シェル（Shell）を介さず、引数境界を保持して予約操作を実行します。
    return subprocess.run(["node", str(cli_entry), "schedule", *sys.argv[1:]], check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
