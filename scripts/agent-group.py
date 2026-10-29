"""AI会話グループ（Group）のCLIを起動する補助スクリプト（Script）。

名前・役割・モデルを含む引数を配列のまま渡し、空白を保持します。
起動した作業領域を変更せず、CLIの終了コードを呼び出し元に返します。
Node.jsとリポジトリの依存パッケージが必要です。
"""
from pathlib import Path
import subprocess
import sys


def main() -> int:
    """スクリプトの配置場所からCLIを特定し、シェルを使わず実行します。"""
    # 現在のフォルダーはグループの保存先として維持します。
    cli = Path(__file__).resolve().parent.parent / "bin" / "wentian.js"
    # 引数の境界を維持して、任意の名前・役割を安全に受け渡します。
    return subprocess.run(["node", str(cli), "group", *sys.argv[1:]], check=False).returncode


if __name__ == "__main__":
    sys.exit(main())
