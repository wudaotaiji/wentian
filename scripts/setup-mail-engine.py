"""メール学習専用の仮想環境（Virtual Environment）を準備します。

既存Pythonやプランナーの依存関係を変更せず、プロジェクト内の
.wentian/mail-engineだけに、版を固定した学習ライブラリーを導入します。
"""
from pathlib import Path
import subprocess
import sys
import venv


def main():
    # スクリプト自身を基準にパスを決め、誤った場所への導入を防ぎます。
    root = Path(__file__).resolve().parents[1]
    directory = root / ".wentian/mail-engine"
    python = directory / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(directory)
    # パッケージの版は共通の要件ファイルで管理します。失敗は終了コードで伝えます。
    subprocess.run([str(python), "-m", "pip", "install", "-r",
                    str(root / "scripts/mail-training-requirements.txt")], check=True)
    subprocess.run([str(python), "-c", "import sklearn, joblib; print('メール学習環境の確認完了')"], check=True)


if __name__ == "__main__":
    main()
