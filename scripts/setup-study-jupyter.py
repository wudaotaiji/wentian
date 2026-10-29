"""Jupyterモジュールを独立した仮想環境へ導入し、検証後に有効版を切り替えます。

既存のPython・Wentianのnpm依存・ノートブックは変更しません。
更新時は別のreleaseを作成し、失敗時はactive.jsonを維持します。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import uuid


def probe(python: Path, directory: Path) -> dict:
    """隔離した空の保存先でHTTP・Lab・カーネル登録を実際に確認します。"""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    token = secrets.token_hex(32)
    with tempfile.TemporaryDirectory(prefix="jupyter-probe-") as scratch:
        env = dict(os.environ, JUPYTER_TOKEN=token, JUPYTER_CONFIG_DIR=scratch,
                   JUPYTER_RUNTIME_DIR=scratch, IPYTHONDIR=scratch,
                   JUPYTER_PLATFORM_DIRS="1", PYTHONNOUSERSITE="1")
        args = [str(python), "-m", "jupyterlab", "--no-browser", "--ServerApp.ip=127.0.0.1",
                f"--ServerApp.port={port}", "--ServerApp.port_retries=0",
                "--ServerApp.base_url=/study/jupyter/", f"--ServerApp.root_dir={scratch}",
                "--ServerApp.allow_unauthenticated_access=False", "--ServerApp.log_level=ERROR"]
        # 認証トークンをコマンド引数や導入ログへ出力しません。
        with (directory / "probe.log").open("wb") as log:
            process = subprocess.Popen(args, env=env, stdout=log, stderr=log,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                base = f"http://127.0.0.1:{port}/study/jupyter/"
                headers = {"Authorization": "token " + token}
                for _ in range(120):
                    if process.poll() is not None:
                        raise RuntimeError("Jupyterの起動検証に失敗しました。probe.logを確認してください。")
                    try:
                        with urllib.request.urlopen(urllib.request.Request(base + "api/status", headers=headers), timeout=2) as response:
                            status = json.load(response)
                        break
                    except (OSError, ValueError):
                        time.sleep(0.5)
                else:
                    raise RuntimeError("Jupyterの接続確認が時間切れです。")
                with urllib.request.urlopen(urllib.request.Request(base + "api/kernelspecs", headers=headers), timeout=10) as response:
                    kernels = json.load(response)
                if "python3" not in kernels.get("kernelspecs", {}):
                    raise RuntimeError("Pythonカーネルを確認できません。")
                with urllib.request.urlopen(urllib.request.Request(base + "lab", headers=headers), timeout=10) as response:
                    if b"jupyter" not in response.read().lower():
                        raise RuntimeError("JupyterLab画面を確認できません。")
                try:
                    urllib.request.urlopen(base + "api/status", timeout=5)
                    raise RuntimeError("未認証のAPIが拒否されませんでした。")
                except urllib.error.HTTPError as error:
                    if error.code not in (401, 403):
                        raise
                return {"http": True, "lab": True, "pythonKernel": True, "authentication": True}
            finally:
                try:
                    urllib.request.urlopen(urllib.request.Request(base + "api/shutdown", headers=headers, data=b"", method="POST"), timeout=3).close()
                    process.wait(timeout=8)
                except (OSError, subprocess.TimeoutExpired):
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()


def main() -> None:
    # Windowsの既定CP932でも中国語のメニュー名を含むログが壊れないようにします。
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(os.environ.get("WENTIAN_JUPYTER_MODULE_ROOT", str(Path(__file__).resolve().parent.parent / ".wentian/modules/jupyter"))))
    parser.add_argument("--version", help="導入するJupyterLabの固定バージョン")
    parser.add_argument("--rollback", action="store_true", help="直前の有効版へ戻す")
    parser.add_argument("--verify-only", action="store_true", help="有効版を変更せず動作だけ確認する")
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    # 同時更新による台帳上書きを防ぎ、既存の有効版を途中で壊しません。
    lock = root / "install.lock"
    with lock.open("x", encoding="utf-8") as handle:
        handle.write(str(os.getpid()))
    try:
        active = root / "active.json"
        old = json.loads(active.read_text(encoding="utf-8")) if active.exists() else None
        if args.verify_only:
            if not old:
                raise RuntimeError("有効なJupyterモジュールがありません。")
            python = root / "releases" / old["release"] / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            print(json.dumps(probe(python, python.parent.parent), ensure_ascii=False), flush=True)
            return
        if args.rollback:
            if not old or not old.get("previous"):
                raise RuntimeError("切り戻し先がありません。")
            candidate = old["previous"]
            python = root / "releases" / candidate["release"] / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            probe(python, python.parent.parent)
            selected = dict(candidate, previous={key: value for key, value in old.items() if key != "previous"})
        else:
            if not args.version or not re.fullmatch(r"\d+\.\d+\.\d+", args.version):
                raise RuntimeError("--versionに導入する固定バージョンを指定してください。")
            release = args.version + "-" + uuid.uuid4().hex[:12]
            directory = root / "releases" / release
            print("Jupyter専用の仮想環境を作成します。", flush=True)
            subprocess.run([sys.executable, "-m", "venv", str(directory)], check=True)
            python = directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
            print("指定バージョンとPythonカーネルを専用環境へ導入します。", flush=True)
            subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "jupyterlab==" + args.version, "ipykernel"], check=True)
            # 全依存の固定リストを残し、バージョン更新の内容を再現できるようにします。
            freeze = subprocess.check_output([str(python), "-m", "pip", "freeze"], text=True)
            (directory / "requirements.lock.txt").write_text(freeze, encoding="utf-8")
            versions = json.loads(subprocess.check_output([str(python), "-c", "import json,jupyterlab,jupyter_server; print(json.dumps(dict(lab=jupyterlab.__version__,server=jupyter_server.__version__)))"], text=True))
            if versions["lab"] != args.version or not versions["server"].startswith("2."):
                raise RuntimeError("Wentianアダプターの対応バージョンを確認できません。")
            print("新しい環境の画面・HTTP・カーネル・認証を確認します。", flush=True)
            evidence = probe(python, directory)
            (directory / "verification.json").write_text(json.dumps(dict(versions=versions, checks=evidence), ensure_ascii=False, indent=2), encoding="utf-8")
            selected = {"contract": "wentian-jupyter/1", "release": release, "version": args.version}
            if old:
                selected["previous"] = {key: value for key, value in old.items() if key != "previous"}
        temporary = root / ("active-" + uuid.uuid4().hex + ".tmp")
        temporary.write_text(json.dumps(selected, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, active)
        print("検証に成功し、有効版を保存しました。我的书房で起動または再起動してください。", flush=True)
    finally:
        lock.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
