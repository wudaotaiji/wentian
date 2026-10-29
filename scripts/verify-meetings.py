#!/usr/bin/env python3
"""会議機能を本番データや実カメラ・マウス入力なしで検証し、証跡を保存します。

Pythonはこのスクリプトを実行した環境を使います。Nodeと依存関係は導入済みのものを使い、
外部サービスへログインしたり、証明書をOSへ登録したりしません。
"""
import argparse
from datetime import datetime
import os
from pathlib import Path
import subprocess
import sys


def main():
    # Windowsの既定コードページでも日本語と試験記号を安全に表示します。
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description='Wentianのビデオ会議・遠隔支援を隔離検証します。')
    parser.add_argument('--openssl', help='試験用の一時TLS証明書を生成するOpenSSL。未指定時はPATHから検索。')
    parser.add_argument('--evidence-dir', help='検証ログの保存先。未指定時は非公開の実行時領域へ保存します。')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    evidence = Path(args.evidence_dir).resolve() if args.evidence_dir else root / '.wentian' / 'verification' / 'meetings' / datetime.now().strftime('%Y%m%d-%H%M%S')
    evidence.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
    if args.openssl: env['WENTIAN_TEST_OPENSSL'] = args.openssl
    steps = [
        ('node-tests', ['node', '--import', 'tsx', '--import', './src/test-environment.ts', '--test', '--test-concurrency=1', 'src/meetings.test.ts', 'src/meetings-ui.test.ts', 'src/meeting-recordings.test.ts', 'src/meetings-tls.test.ts', 'src/navigation-ui.test.ts', 'src/menu-policy.test.ts', 'src/startup-forge-social-ui.test.ts']),
        ('recording-python-syntax', [sys.executable, '-c', 'import ast,pathlib; ast.parse(pathlib.Path("scripts/meeting-transcribe.py").read_text(encoding="utf-8")); print("会議文字起こしPythonの構文検査に成功しました。")']),
        ('helper-tests', [sys.executable, 'scripts/test_remote_assist_helper.py']),
        ('typecheck', ['node', 'node_modules/typescript/bin/tsc', '--noEmit']),
    ]
    results = []
    for label, command in steps:
        print('検証を実行: '+label, flush=True)
        result = subprocess.run(command, cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace')
        (evidence / (label+'.log')).write_text(result.stdout, encoding='utf-8')
        print(result.stdout, flush=True)
        results.append((label, result.returncode))
    (evidence / 'summary.md').write_text('# 会議機能の検証\n\n'+'\n'.join('- '+label+': '+('成功' if code == 0 else '失敗') for label, code in results)+'\n\n実カメラ・OS入力・外部TURNでの実機試験は含みません。\n', encoding='utf-8')
    print('証跡: '+str(evidence), flush=True)
    return 1 if any(code for _, code in results) else 0


if __name__ == '__main__': sys.exit(main())
