"""GooseのCodex連携を、Wentianが明示したモデル・権限で実行します。

Gooseの旧版は既知モデル以外のIDを子CLIへ渡しません。この入口はGooseからの
引数を転送せず、親プロセスが用意した引数配列だけを使用します。プロンプトは
標準入力をそのまま引き継ぎ、シェルへ展開しません。認証設定は既存CLIが扱います。
PowerShell版も同じ処理を呼び出します。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys


def main() -> int:
    """親が生成した非対話コマンドを検査し、同じプロセスツリーで完了を待ちます。"""
    try:
        command = json.loads(os.environ["WENTIAN_GOOSE_CODEX_COMMAND"])
        if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
            raise ValueError("実行引数の形式が不正です。")
        if not all(flag in command for flag in ("--no-daemon", "--ask-for-approval", "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "--cd", "--json", "--model")):
            raise ValueError("明示モデル・実行領域・権限の指定が不足しています。")
        if command[-1] != "-" or command[command.index("--ask-for-approval") + 1] != "never":
            raise ValueError("標準入力または非対話設定が不正です。")
        if command[command.index("--sandbox") + 1] not in ("read-only", "workspace-write"):
            raise ValueError("許可された実行権限ではありません。")
        if any(arg in command for arg in ("--yolo", "--dangerously-bypass-approvals-and-sandbox", "danger-full-access")):
            raise ValueError("無制限の実行権限を拒否しました。")
        # stdin/stdout/stderrを直結し、秘密値やプロンプトを補助ファイルへ保存しません。
        return subprocess.run(command, check=False).returncode
    except (KeyError, ValueError, IndexError, OSError) as error:
        print(f"Goose連携の起動条件を確認できませんでした: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
