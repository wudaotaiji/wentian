"""メール連携の認証情報をWindows DPAPI（データ保護API）で暗号化して保管します。

暗号化された値は同じWindows利用者だけが復号できます。秘密値を引数に渡す方式は
設けず、対話入力または標準入力だけで受け取ります。一覧には変数名だけを返します。
getの標準出力はサーバー内のパイプ接続専用で、端末への表示には使用しないでください。
"""
import argparse
import base64
import ctypes
from ctypes import wintypes
import getpass
import json
import os
from pathlib import Path
import re
import sys
import time


class Blob(ctypes.Structure):
    # DATA_BLOBはDPAPIが要求する長さとバイト列の組です。バッファを呼び出し中保持します。
    _fields_ = [("length", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def protect(value: bytes, decrypt=False) -> bytes:
    if os.name != "nt":
        raise RuntimeError("DPAPI保管はWindowsで実行してください。")
    buffer = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    destination = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    # ユーザー確認画面を出さないフラグだけを付け、端末全体で復号可能なフラグは使いません。
    if decrypt:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(destination))
    else:
        ok = crypt.CryptProtectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(destination))
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(destination.data, destination.length)
    finally:
        kernel.LocalFree(ctypes.cast(destination.data, ctypes.c_void_p))


def main():
    parser = argparse.ArgumentParser(description="メール連携のWindows暗号化保管")
    parser.add_argument("action", choices=["set", "get", "list"])
    parser.add_argument("--name")
    parser.add_argument("--stdin", action="store_true")
    parser.add_argument("--file", type=Path, default=Path(__file__).resolve().parents[1] / ".wentian/mail-secrets.json")
    arguments = parser.parse_args()
    if arguments.action != "list" and not re.fullmatch(r"WENTIAN_MAIL_[A-Z0-9_]{1,90}", arguments.name or ""):
        raise ValueError("WENTIAN_MAIL_で始まる環境変数名を指定してください。")
    file = arguments.file.resolve()
    values = json.loads(file.read_text(encoding="utf-8")) if file.exists() else {}
    if arguments.action == "list":
        print(json.dumps(sorted(values)))
        return
    if arguments.action == "get":
        if arguments.name not in values:
            raise ValueError("指定した認証情報は保管されていません。")
        # 復号値は標準出力へだけ返し、ファイルや実行ログへ複製しません。
        sys.stdout.buffer.write(protect(base64.b64decode(values[arguments.name]), True))
        return
    value = sys.stdin.read().rstrip("\r\n") if arguments.stdin else getpass.getpass("認証情報（表示しません）: ")
    if not value or len(value) > 20000:
        raise ValueError("認証情報の長さが不正です。")
    encoded = base64.b64encode(protect(value.encode("utf-8"))).decode("ascii")
    file.parent.mkdir(parents=True, exist_ok=True)
    lock = file.with_suffix(".lock")
    # 別の設定処理と競合した場合も、既存の暗号化済み項目を消さないよう直列化します。
    descriptor = None
    for _ in range(50):
        try:
            descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            break
        except FileExistsError:
            time.sleep(0.1)
    if descriptor is None:
        raise RuntimeError("認証情報の保管処理が実行中です。")
    try:
        values = json.loads(file.read_text(encoding="utf-8")) if file.exists() else {}
        values[arguments.name] = encoded
        temporary = file.with_suffix(".tmp")
        temporary.write_text(json.dumps(values, indent=2), encoding="utf-8")
        os.replace(temporary, file)
    finally:
        os.close(descriptor)
        lock.unlink()
    print("認証情報をWindowsで暗号化して保管しました。")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # エラーには秘密の入力値を含めません。
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
