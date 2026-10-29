"""利用者が操作するブラウザーで、知識庫収集用のログイン状態を保存します。

収集先や保存先に組織固有の既定値を持たせません。パスワードは受け取らず、
ログイン操作と多要素認証は開いたブラウザー内で利用者自身が行います。
このスクリプトはNode.jsの共通実行部をシェルなしで呼び出します。
"""
import argparse
import subprocess
from pathlib import Path


def main():
    """明示された設定だけを共通実行部へ渡し、その終了コードを返します。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="ログイン対象のURL")
    parser.add_argument("--output", required=True, help="秘密のログイン状態ファイルの保存先")
    parser.add_argument("--executable", help="利用するブラウザーの実行ファイル")
    parser.add_argument("--replace", action="store_true", help="既存のログイン状態を更新する")
    args = parser.parse_args()
    command = ["node", str(Path(__file__).with_suffix(".mjs")), "--url", args.url,
               "--output", str(Path(args.output).resolve())]
    if args.executable:
        command.extend(["--executable", args.executable])
    if args.replace:
        command.append("--replace")
    # 認証情報をコマンドへ埋め込まず、利用者操作に必要な標準入出力を引き継ぎます。
    return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
