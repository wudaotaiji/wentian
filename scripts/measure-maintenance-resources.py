"""読み取り専用のWindowsリソース計測。稼働率と固定ディスク容量使用率を返します。

隣接するPowerShell版を使用するため、計測値や容量不足の扱いは両版で共通です。
モデルファイルの走査・削除・試験書込みは行いません。
"""
import pathlib
import subprocess
import sys

# 計測定義を二重管理せず、隣接するPowerShell版をプロファイルなしで呼び出します。
# 引数は配列で渡し、秘密設定の読取りや設定変更は行いません。
result = subprocess.run(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-File",
     str(pathlib.Path(__file__).with_suffix(".ps1"))],
    capture_output=True, timeout=30,
)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
