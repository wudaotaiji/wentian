"""CodexのMXC互換性を検証し、既存の承認・隔離境界を維持して優先設定を保存します。

--applyなしでは検証だけを行います。変更前に設定全体をバックアップし、
常駐サーバーの再起動、ACLの手動変更、認証情報の表示は行いません。
"""
import argparse
from pathlib import Path
import subprocess


def main():
    """Python版は同じPowerShell手順へ引数を渡し、修復ロジックの差異を防ぎます。"""
    parser = argparse.ArgumentParser(description='Codexサンドボックスの検証・MXC優先設定')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    script = Path(__file__).with_suffix('.ps1')
    command = ['pwsh', '-NoProfile', '-File', str(script)]
    if args.apply:
        command.append('-Apply')
    # コマンドは配列で渡し、シェル文字列の組み立てや秘密情報の出力を避けます。
    raise SystemExit(subprocess.run(command, check=False).returncode)


if __name__ == '__main__':
    main()
