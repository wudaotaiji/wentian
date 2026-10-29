"""管理者アカウントを停止中に復旧するローカル専用ツール。

--store はサーバーの WENTIAN_USER_STORE と同じ台帳を明示指定する。
--list は管理者のID・ログイン名・有効状態だけを表示する読み取り操作。
パスワードは非表示で二度入力し、コマンド引数・環境変数・ログへ残さず
Node.js の復旧処理へ標準入力で渡す。ユーザーIDやDM履歴は作り直さない。
"""
import argparse
import getpass
import json
import pathlib
import subprocess
import sys

parser = argparse.ArgumentParser(description="Wentian管理者のローカル復旧")
parser.add_argument("--store", required=True, help="利用者台帳の絶対パス")
parser.add_argument("--list", action="store_true", help="管理者一覧だけを表示")
parser.add_argument("--user-id", help="復旧する既存管理者のID")
parser.add_argument("--username", help="新しいログイン名（省略時は維持）")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
command = ["node", "--import", "tsx", str(root / "src/user-recovery.ts"), str(pathlib.Path(args.store).resolve())]
if args.list:
    sys.exit(subprocess.run(command + ["--list"], cwd=root).returncode)
if not args.user_id:
    parser.error("--user-id を指定してください。")
password = getpass.getpass("新しいパスワード（12文字以上）: ")
if password != getpass.getpass("もう一度入力: "):
    sys.exit("確認用パスワードが一致しません。")
payload = {"userId": args.user_id, "password": password}
if args.username:
    payload["username"] = args.username
sys.exit(subprocess.run(command, cwd=root, input=json.dumps(payload), text=True, encoding="utf-8").returncode)
