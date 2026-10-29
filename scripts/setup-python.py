"""初期導入時にPythonの仮想環境（Virtual Environment）と必須依存を一括準備します。

システム全体のPythonへ追加せず、プロジェクトの.venvへrequirements.txtを導入します。
既存環境がある場合は再利用し、終了前に実行時依存の読み込みを検証します。
"""
from pathlib import Path
import os
import subprocess
import venv


def main() -> None:
    """配置済みのプロジェクトルート（Project Root）を基準に、同じ環境を再現します。"""
    root = Path(__file__).resolve().parent.parent
    environment = root / ".venv"
    interpreter = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not interpreter.is_file():
        print("Python仮想環境（Virtual Environment）を作成します。", flush=True)
        venv.EnvBuilder(with_pip=True).create(environment)
    # 引数配列を使い、スペースを含むパスもそのままpipへ渡します。
    print("requirements.txtから必須ライブラリを一括導入します。", flush=True)
    subprocess.run([str(interpreter), "-m", "pip", "install", "-r", str(root / "requirements.txt")], check=True, cwd=root)
    # 常駐サーバー（Daemon）が使用する同じ実行ファイルで、依存を実際に読み込みます。
    subprocess.run([str(interpreter), "-c", "import yaml; print('Python依存確認: 合格 / PyYAML ' + yaml.__version__)"], check=True, cwd=root)
    print(f"保守用Python: {interpreter}", flush=True)


if __name__ == "__main__":
    main()
