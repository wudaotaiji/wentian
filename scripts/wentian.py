"""Wentian CLI用Pythonラッパー。

引数をシェル文字列へ連結せず配列として渡し、安全にCLIを起動します。
"""
from __future__ import annotations
import subprocess
import sys
from pathlib import Path


def main() -> int:
    """プロジェクトルートでCLIを起動し、終了コードをそのまま返します。"""
    project_directory = Path(__file__).resolve().parent.parent
    executable = "npm.cmd" if sys.platform == "win32" else "npm"
    command = [executable, "run", "wentian", "--", *sys.argv[1:]]
    return subprocess.run(command, cwd=project_directory, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
