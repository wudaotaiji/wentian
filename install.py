"""Wentian Gateway Windows installer.

PowerShellを利用できない環境向けの同等インストーラーです。GitHubのmain
ブランチを一時領域へ取得し、npm ciと型検査を通過した内容だけをユーザー
領域へ配置します。既存の.envは更新時にも保持します。
"""
from __future__ import annotations

import os
import argparse
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import uuid
import zipfile
from pathlib import Path

ARCHIVE_URL = "https://github.com/wudaotaiji/wentian/archive/refs/heads/main.zip"


def run(command: list[str], cwd: Path | None = None) -> None:
    """コマンドを配列で安全に実行し、失敗時は直ちに停止します。"""
    subprocess.run(command, cwd=cwd, check=True)


def add_user_path(directory: Path) -> None:
    """PowerShell経由でユーザーPATHへランチャーディレクトリを追加します。"""
    escaped = str(directory).replace("'", "''")
    script = (
        f"$d='{escaped}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); "
        "$e=@($p -split ';' | Where-Object { $_ }); "
        "if($e -notcontains $d){[Environment]::SetEnvironmentVariable('Path',(($e+$d)-join ';'),'User')}"
    )
    run(["powershell.exe", "-NoProfile", "-Command", script])


def main() -> int:
    """検証済みのソースを配置し、wentian.cmdを公開します。"""
    if sys.platform != "win32":
        raise RuntimeError("このインストーラーはWindows専用です。")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-directory', type=Path)
    parser.add_argument('--install-root', type=Path)
    parser.add_argument('--no-path-update', action='store_true')
    args = parser.parse_args()
    local_app_data = os.environ.get("LOCALAPPDATA")
    if not local_app_data:
        raise RuntimeError("LOCALAPPDATAを確認できません。")

    node = shutil.which("node.exe") or shutil.which("node")
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not node or not npm:
        raise RuntimeError("Node.js 20以降とnpmが必要です: winget install OpenJS.NodeJS.LTS")
    major = int(subprocess.check_output([node, "--version"], text=True).strip().lstrip("v").split(".")[0])
    if major < 20:
        raise RuntimeError("Node.js 20以降が必要です。")

    install_root = (args.install_root or Path(local_app_data) / "Programs" / "wentian-gateway").resolve()
    launcher_dir = Path(local_app_data) / "Programs" / "wentian-gateway-bin"
    if args.no_path_update:
        launcher_dir = install_root.with_name(install_root.name + "-bin")
    backup_root = install_root.with_name(install_root.name + ".backup")

    with tempfile.TemporaryDirectory(prefix="wentian-install-") as temporary:
        temp_root = Path(temporary)
        archive = temp_root / "wentian-gateway.zip"
        extract_root = temp_root / "extract"
        staging_root = temp_root / ("staging-" + uuid.uuid4().hex)
        print("[Wentian] ソースをGitHubからダウンロードしています。")
        if args.source_directory:
            source = args.source_directory.resolve()
            run(['git', '-C', str(source), 'archive', '--format=zip', '--prefix=source/', f'--output={archive}', 'HEAD'])
        else:
            try:
                with urllib.request.urlopen(ARCHIVE_URL, timeout=120) as response, archive.open('wb') as output:
                    shutil.copyfileobj(response, output)
            except Exception as error:
                raise RuntimeError(f"ソースを取得できません: {ARCHIVE_URL}。公開状態・URL・接続を確認してください。Git取得済みの場合は --source-directory を指定できます。") from error
        with zipfile.ZipFile(archive) as source_zip:
            source_zip.extractall(extract_root)
        source_roots = [item for item in extract_root.iterdir() if item.is_dir()]
        if len(source_roots) != 1 or not (source_roots[0] / "package-lock.json").is_file():
            raise RuntimeError("ダウンロードしたアーカイブの構成が不正です。")
        shutil.move(str(source_roots[0]), staging_root)

        if args.source_directory:
            # 追跡済みの作業変更だけを反映し、秘密設定や実行時データを除外します。
            files = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-z']).decode('utf-8').split('\0')
            for name in filter(None, files):
                original = source / name
                if original.is_file():
                    target = staging_root / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(original, target)
        for required in ('package-lock.json', 'wentian.plugins.json', 'bin/wentian.js'):
            if not (staging_root / required).is_file():
                raise RuntimeError(f"必須ファイルがありません: {required}")
        print("[Wentian] 固定されたnpm依存関係をインストールしています。")
        run([npm, "ci", "--no-audit", "--no-fund"], cwd=staging_root)
        print("[Wentian] TypeScriptの型検査を実行しています。")
        run([npm, "run", "build"], cwd=staging_root)

        # 配置前に導入先外からCLIを実行し、設定のパス解決を確認します。
        run([node, str(staging_root / 'bin' / 'wentian.js'), 'skills', 'list'], cwd=temp_root)

        saved_environment = (install_root / ".env").read_bytes() if (install_root / ".env").is_file() else None
        if backup_root.exists():
            raise RuntimeError(f"以前のバックアップが残っています: {backup_root}")
        if install_root.exists():
            install_root.rename(backup_root)
        try:
            install_root.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(staging_root), install_root)
            if saved_environment is not None:
                (install_root / ".env").write_bytes(saved_environment)
            else:
                shutil.copy2(install_root / ".env.example", install_root / ".env")
        except Exception:
            if backup_root.exists() and not install_root.exists():
                backup_root.rename(install_root)
            raise

    launcher_dir.mkdir(parents=True, exist_ok=True)
    launcher = f'@echo off\r\nnode "{install_root}\\bin\\wentian.js" %*\r\n'
    (launcher_dir / "wentian.cmd").write_text(launcher, encoding="ascii", newline="")
    if not args.no_path_update:
        add_user_path(launcher_dir)
    if backup_root.exists():
        shutil.rmtree(backup_root)

    print("Wentian Gatewayのインストールが完了しました。")
    print(f"インストール先: {install_root}")
    print("新しいPowerShellで実行: wentian daemon start --port 8787")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
