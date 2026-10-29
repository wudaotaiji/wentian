"""WindowsのMicrosoft Officeで検収用コピーをPDFへ変換する入口です。

実処理はPowerShell版に集約します。原本は読取専用で開き、出力先は新規に限定します。
検収用コピーのパスを明示し、利用者の本番文書を指定しないでください。
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--input', action='append', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
if os.name != 'nt':
    raise SystemExit('Windows版Microsoft Officeが必要です。')
shell = shutil.which('powershell.exe')
if not shell:
    raise SystemExit('Windows PowerShellが見つかりません。')
# 配列のパスはJSONとして一時ファイルへ渡し、コマンド文字列へ埋め込みません。
import json
import tempfile
with tempfile.TemporaryDirectory(prefix='wentian-office-') as temp:
    manifest = Path(temp) / 'inputs.json'
    manifest.write_text(json.dumps([str(Path(item).resolve(strict=True)) for item in args.input]), encoding='utf-8')
    script = Path(__file__).with_suffix('.ps1')
    # PowerShellの配列引数はラッパーファイルから展開し、引用符を含むパスも安全に渡します。
    wrapper = Path(temp) / 'run.ps1'
    wrapper.write_text('param($Script,$Manifest,$Output)\n$ErrorActionPreference = "Stop"\n$items = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8)\n& $Script -InputFiles $items -Output $Output\n', encoding='utf-8-sig')
    raise SystemExit(subprocess.run([shell, '-NoProfile', '-File', str(wrapper), str(script), str(manifest), str(Path(args.output).resolve())], check=False).returncode)
