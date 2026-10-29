"""隔離画面検収サーバーを起動します。実モデルや本番知識庫へ接続しません。

新規出力先を明示し、server.jsonのループバックURLをブラウザーで開いてください。
終了はCtrl+Cまたは15分の期限です。証跡と一時知識庫の保存先はserver.jsonに記録します。
"""
import argparse
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True)
args = parser.parse_args()
node = shutil.which('node')
if not node:
    raise SystemExit('Node.jsが見つかりません。')
root = Path(__file__).resolve().parent.parent
# パスを配列で渡し、シェル文字列として解釈させません。
raise SystemExit(subprocess.run([node, '--import', 'tsx', str(root / 'scripts/verify-knowledge-screen.ts'),
    '--output', str(Path(args.output).resolve())], cwd=root, check=False).returncode)
