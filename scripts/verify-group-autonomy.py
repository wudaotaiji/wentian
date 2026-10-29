"""AI会話グループの自律討論（Group Autonomy）を検証します。

型検査と隔離済みの自動試験だけを実行し、本番サーバー・認証情報・
実データ・外部サービスには接続しません。試験は src/test-environment.ts が
一時領域へ隔離するため、実際のグループ台帳を変更しません。
各工程のログと結果JSONを証跡ディレクトリへ保存し、実ファイルで検収できます。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    """検証を順に実行し、失敗しても工程ごとのログを証跡として残します。"""
    # Windowsの既定コードページでも日本語の進捗・エラーが化けないよう出力をUTF-8に統一します。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')
        except Exception:  # noqa: BLE001 - 再設定できない環境では既定の出力をそのまま使います。
            pass
    parser = argparse.ArgumentParser(description=__doc__)
    # 証跡の保存先は既定で日時付きの専用フォルダーとし、既存の証跡を上書きしません。
    parser.add_argument('--evidence-dir', default=None, help='証跡の保存先。未指定なら docs/evidence/group-autonomy 配下。')
    parser.add_argument('--skip-typecheck', action='store_true', help='型検査を省略し、自動試験だけを実行します。')
    args = parser.parse_args()

    workspace = Path(__file__).resolve().parents[1]
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    evidence = Path(args.evidence_dir).resolve() if args.evidence_dir else workspace / 'docs' / 'evidence' / 'group-autonomy' / stamp
    evidence.mkdir(parents=True, exist_ok=True)
    report_path = evidence / 'result.json'
    report = {
        'status': 'running',
        'scope': '型検査と隔離試験。実LLM・本番データ・外部サービスは使わない。',
        'startedAt': datetime.now(timezone.utc).isoformat(),
        'steps': [],
    }

    def save() -> None:
        # 台帳と同様に一時ファイル経由で置換し、中断時も進捗を読み取れるようにします。
        temporary = report_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(report_path)

    steps = []
    if not args.skip_typecheck:
        # npx は Windows で解決されないことがあるため、TypeScript を直接起動します。
        steps.append(('typecheck', ['node', 'node_modules/typescript/bin/tsc', '--noEmit']))
    steps.append(('tests', ['node', '--import', 'tsx', '--import', './src/test-environment.ts',
                            '--test', '--test-concurrency=1', 'src/group-autonomy.test.ts',
                            'src/group-chat-ui.test.ts', 'src/group-human.test.ts', 'src/startup-forge-room.test.ts',
                            'src/startup-forge-social-ui.test.ts', 'src/workbench.test.ts', 'src/agent-group.test.ts']))

    save()
    try:
        for name, command in steps:
            log = evidence / f'{name}.log'
            with log.open('w', encoding='utf-8') as output:
                code = subprocess.run(command, cwd=workspace, stdout=output, stderr=subprocess.STDOUT).returncode
            report['steps'].append({'name': name, 'command': command, 'exitCode': code, 'log': log.name})
            save()
            print(f'{name}: exit={code}')
            if code != 0:
                raise RuntimeError(f'{name} が失敗しました。ログを確認してください: {log}')
        report['status'] = 'passed'
        save()
        print('検証が成功しました。証跡: ' + str(evidence))
        return 0
    except Exception as error:  # noqa: BLE001 - 失敗理由を必ず証跡へ残すため包括的に捕捉します。
        report.update(status='failed', error=str(error))
        save()
        print('検証が失敗しました。証跡: ' + str(evidence))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
