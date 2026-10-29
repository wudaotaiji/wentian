"""実配信画面を一時ブラウザーと試験用EVMで検証します。秘密鍵は入力しません。"""
import subprocess
import sys
from pathlib import Path

# 配列引数を使い、利用者指定のWTC保存先・URL・出力先をシェル展開させません。
root = Path(__file__).resolve().parent.parent
raise SystemExit(subprocess.run(["node", str(root / "scripts/verify-wallet.mjs"), *sys.argv[1:]], cwd=root).returncode)
