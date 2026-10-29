"""模擬データだけのローカルプレビュー（Local Preview）を起動します。"""
from pathlib import Path
import subprocess
import json
from urllib.request import urlopen
from urllib.error import URLError

# 本番サーバーとは異なるポートと台帳を使うTypeScriptの専用入口を呼び出します。
# シェルを介さず引数を渡し、パスの空白や引用符を安全に扱います。
root = Path(__file__).resolve().parents[1]
# 専用の識別応答と決済無効を確認してから、起動済みとして案内します。
# 他サービスや旧版の応答は採用せず、既存プロセスの停止も行いません。
try:
    with urlopen('http://127.0.0.1:8799/api/commerce/preview-status', timeout=2) as response:
        status = json.load(response)
except (URLError, TimeoutError, ValueError, OSError):
    status = {}
if isinstance(status, dict) and status.get('kind') == 'wentian-commerce-preview' and status.get('payments') == 'disabled':
    print('検証専用プレビューは起動済みです: http://127.0.0.1:8799/commerce')
else:
    # Node.jsの標準エラーを保持し、終了コードも呼び出し元へ返します。
    result = subprocess.run(['node', '--import', 'tsx', 'src/commerce-preview.ts'], cwd=root)
    if result.returncode:
        print(f'検証専用プレビューが終了コード {result.returncode} で異常終了しました。直前のNode.jsエラーを確認してください。EADDRINUSEの場合は8799番ポートが使用中です。')
    raise SystemExit(result.returncode)
