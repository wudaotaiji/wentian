"""導入後のsetupを一時データで検証します。利用者の認証情報は変更しません。"""
import subprocess
import sys
from pathlib import Path

# 配列引数で入力を渡し、シェル文字列の解釈を行いません。
script=Path(__file__).with_suffix('.mjs')
raise SystemExit(subprocess.run(['node',str(script),*sys.argv[1:]],check=False).returncode)
