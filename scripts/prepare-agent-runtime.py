"""公式Node.js LTSをWentian専用領域へ導入します。

既存のNode.jsやPATH設定は変更しません。公式HTTPSのチェックサムを照合し、
展開先の逸脱を拒否したうえで、呼出元が使う実行ファイルの台帳を保存します。
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import subprocess
import urllib.request
import zipfile


def main():
    """Windows用LTSの取得・検査・展開・実起動確認を順に実行します。"""
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    record = root / 'node-runtime.json'
    if record.exists():
        # 台帳だけを信用せず、保存領域内の実ファイルと版を再確認します。
        executable = Path(json.loads(record.read_text())['executable']).resolve()
        if executable.is_relative_to(root) and executable.exists():
            version = subprocess.check_output([str(executable), '--version'], text=True).strip()
            if re.fullmatch(r'v24\.(?:1[6-9]|[2-9]\d)\.\d+', version):
                print(json.dumps({'executable': str(executable), 'version': version}))
                return
    if os.name != 'nt':
        raise RuntimeError('この専用ランタイム導入はWindows対応です。Node.js 24 LTSを導入してください。')
    architecture = 'arm64' if os.environ.get('PROCESSOR_ARCHITECTURE', '').upper() == 'ARM64' else 'x64'
    base = 'https://nodejs.org/dist/latest-v24.x/'
    with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30) as response:
        checksums = response.read().decode()
    match = re.search(r'^([a-f0-9]{64})\s+(node-v24\.\d+\.\d+-win-' + architecture + r'\.zip)$', checksums, re.M)
    if not match:
        raise RuntimeError('公式のLTSチェックサム一覧に対応ファイルがありません。')
    checksum, filename = match.groups()
    archive = root / filename
    # ダウンロードは公式ドメインの固定されたファイル名だけに限定します。
    with urllib.request.urlopen(base + filename, timeout=120) as response:
        payload = response.read()
    if hashlib.sha256(payload).hexdigest() != checksum:
        raise RuntimeError('Node.jsのチェックサムが一致しません。展開しません。')
    archive.write_bytes(payload)
    with zipfile.ZipFile(archive) as package:
        for member in package.infolist():
            if not (root / member.filename).resolve().is_relative_to(root):
                raise RuntimeError('展開領域外のパスを拒否しました。')
        package.extractall(root)
    executable = root / filename.removesuffix('.zip') / 'node.exe'
    version = subprocess.check_output([str(executable), '--version'], text=True).strip()
    value = {'executable': str(executable), 'version': version, 'sha256': checksum}
    temporary = record.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    temporary.replace(record)
    print(json.dumps(value))


if __name__ == '__main__':
    main()
