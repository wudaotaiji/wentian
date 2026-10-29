"""Jupyterアダプターの隔離試験と、任意の実カーネル試験を実行します。

--live時もノートブックは一時領域へ保存し、利用者の成果物を変更しません。
"""
from pathlib import Path
import argparse
import os
import platform
import subprocess

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--live", action="store_true")
args = parser.parse_args()
commands = [
    ["npm.cmd" if os.name == "nt" else "npm", "run", "build"],
    ["node", "--import", "tsx", "--import", "./src/test-environment.ts", "--test", "src/study.test.ts", "src/navigation-ui.test.ts", "src/wentian-plugin-runtime.test.ts"],
]
if args.live:
    commands.append(["node", "--import", "tsx", "scripts/verify-study-jupyter-runtime.ts"])
    # Windowsの通常DaemonはBunを使うため、同じランタイムでも実カーネルを検証します。
    architecture = "aarch64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    bun = root / "node_modules" / "@oven" / ("bun-windows-" + architecture) / "bin" / "bun.exe"
    if os.name == "nt" and bun.is_file():
        commands.append([str(bun), "scripts/verify-study-jupyter-runtime.ts"])
for command in commands:
    print("書房の検証を実行します。", flush=True)
    subprocess.run(command, cwd=root, check=True)
