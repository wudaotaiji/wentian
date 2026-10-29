"""分類学習をブラウザーから独立したWindowsバックグラウンドで開始します。

ワーカーは管理者が人手で分類を確認したメールだけを学習例に追加します。
確認済み例が11件に達すると学習を始め、終了結果を専用ログへ記録します。
"""
from pathlib import Path
import json
import os
import shutil
import subprocess


def main():
    # パスをスクリプト位置から決め、メール本体や認証値を引数・ログへ載せません。
    root = Path(__file__).resolve().parents[1]
    directory = root / ".wentian/mail-operations"
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "classification-worker.lock"
    if lock.exists():
        print("分類学習ワーカーは既に実行中です。")
        return
    runtime = root / ".wentian/runtime"
    # Node.js with tsx matches the supported test/runtime entrypoint on Windows.
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.jsがPATHに見つかりません。")
    log_path = directory / "classification-worker.log"
    environment = {**os.environ, "WENTIAN_INSTALL_ROOT": str(root)}
    # Windowsの非表示プロセスとして起動し、このターミナルを閉じても処理を継続します。
    with log_path.open("ab") as log:
        process = subprocess.Popen([node, "--import", "tsx", str(root / "scripts/mail-classification-worker.ts")], cwd=root, env=environment, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW, close_fds=True)
    record = runtime / "mail-classification-worker.json"
    record.write_text(json.dumps({"pid": process.pid, "log": str(log_path)}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"started": True, "pid": process.pid, "log": str(log_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
