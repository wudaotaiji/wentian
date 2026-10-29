"""Wentian MCP stdioブリッジのPython版。

標準入力・標準出力を直接引き継ぎ、MCP以外の出力を混ぜません。
URLと認証キーは環境変数からNode側が読みます。Gatewayは別途起動します。
"""
from pathlib import Path
import shutil
import subprocess
import sys

# 固定スクリプトの絶対パスを使い、作業ディレクトリーへ依存しません。
node = shutil.which("node")
if not node:
    raise SystemExit("Node.jsが見つかりません。")
bridge = Path(__file__).resolve().with_name("mcp-wrapper.cjs")
process = subprocess.Popen([node, str(bridge)])
try:
    raise SystemExit(process.wait())
except KeyboardInterrupt:
    # 中断時も終了処理を通し、HTTPセッションを片付けます。
    process.terminate()
    process.wait(timeout=10)
    sys.exit(130)
