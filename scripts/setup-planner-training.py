"""分類学習用の専用仮想環境だけを作成する。モデル重みは取得しない。

既存のPython環境は変更せず、同梱requirementsの版を使用する。
ネットワークが必要なインストール処理は利用者がこのスクリプトを起動した時だけ行う。
"""
from pathlib import Path
import argparse
import os
import subprocess
import sys
import venv


def main():
    """専用環境を準備し、利用する実行ファイルのパスを表示する。"""
    project = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="分類モデル学習用の専用環境を準備します。")
    parser.add_argument("--cpu", action="store_true", help="GPU用の大容量ライブラリを取得せず、CPU版PyTorchを導入します。")
    args = parser.parse_args()
    # 固定したPyTorch版に合わせ、未対応のPython版へ導入して半端な環境を作らない。
    if not (3, 10) <= sys.version_info[:2] < (3, 14):
        raise RuntimeError("学習環境の準備にはPython 3.10〜3.13を使用してください。推奨は3.11です。")
    root = project / ".wentian" / "planner-engine"
    venv.EnvBuilder(with_pip=True).create(root)
    python = root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    # PyPIの既定パッケージはWindowsでCPU版になるため、GPU版の取得先を明示します。
    # CPUのみで運用する場合は従来どおり --cpu を指定して取得量を抑えられます。
    index = "https://download.pytorch.org/whl/cpu" if args.cpu else "https://download.pytorch.org/whl/cu128"
    subprocess.run([str(python), "-m", "pip", "install", "--force-reinstall", "--no-deps", "torch==2.8.0", "--index-url", index], check=True)
    subprocess.run([str(python), "-m", "pip", "install", "-r", str(project / "scripts" / "planner-training-requirements.txt")], check=True)
    print(f"分類学習用Python環境を準備しました: {python}")


if __name__ == "__main__":
    main()
