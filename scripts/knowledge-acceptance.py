"""実資料・実モデルを、本番データへ触れずに検収する入口です。

モデル接続先とキーは環境変数で渡します。Codex Agentを選ぶ場合は接続先URLを使わず、Wentianの検証済み接続を使います。引数やログへ秘密を出しません。
--output は本文を含む非公開の新規フォルダーを明示してください。
検収処理は共通のTypeScript実装を使い、二重実装による評価の差を防ぎます。
"""
import argparse
from pathlib import Path
import shutil
import subprocess


def main():
    """配列引数で起動し、パスをシェル式として実行しません。"""
    parser = argparse.ArgumentParser(description="知識庫の実資料・実モデル検収")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    node = shutil.which("node")
    if not node:
        print("Node.jsの準備を確認してください。")
        return 1
    # データセットの相対パスは呼出元で解決し、作業場所の変更による誤読を防ぎます。
    command = [node, "--import", "tsx", str(root / "scripts/knowledge-acceptance.ts"),
               "--dataset", str(Path(args.dataset).resolve(strict=True)),
               "--output", str(Path(args.output).resolve())]
    return subprocess.run(command, cwd=root, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
