"""実時間の耐久試験（Durability Test）。専用状態だけを操作し、本番には接続しない。"""
import argparse
import json
import subprocess
import time
from pathlib import Path
from datetime import datetime, timezone


def main():
    # 短い試験は機能確認に限定し、2時間・24時間の合格と取り違えない。
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-root', required=True)
    parser.add_argument('--hours', type=float, default=26)
    parser.add_argument('--segment-seconds', type=float, default=300)
    args = parser.parse_args()
    if args.hours <= 0 or args.segment_seconds <= 0:
        parser.error('時間は正数を指定してください。')
    root = Path(args.state_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    report_path = root / 'harness.json'
    if report_path.exists():
        parser.error('既存の試験を上書きしません。新しい専用ディレクトリを指定してください。')
    workspace = Path(__file__).resolve().parents[1]
    report = {'status': 'running', 'startedAt': datetime.now(timezone.utc).isoformat(),
              'requestedHours': args.hours, 'scope': '実状態保存・固定成果物・文脈圧縮。実LLMの長時間精度試験ではない。',
              'segments': [], 'elapsedSeconds': 0, 'twoHoursPassed': False, 'twentyFourHoursPassed': False}
    started = time.monotonic()

    def save():
        # 台帳を原子的に更新し、途中中断でも進捗を読み取れるようにする。
        temporary = report_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(report_path)

    def probe(role, duration, fault, suffix, state_root=None):
        command = ['node', '--import', 'tsx', 'src/durability-probe.ts', '--role', role,
                   '--state-root', str(state_root or root / 'runtime'), '--run-id', 'durability-test', '--duration-ms', str(duration),
                   '--tick-ms', '1000', '--context-tokens', '4000', '--fault', fault, '--quiet']
        # 出力はファイルへ保存し、認証情報や外部サービスの設定を読み出さない。
        with (root / f'{suffix}.log').open('w', encoding='utf-8') as output:
            result = subprocess.run(command, cwd=workspace, stdout=output, stderr=subprocess.STDOUT,
                                    timeout=duration / 1000 + 120)
        return result.returncode

    save()
    try:
        # 成果物確定前後の障害を別々に注入し、再起動時の二重反映を検査する。
        for index, fault in enumerate(['after-artifact', 'after-journal']):
            fault_root = root / f'fault-state-{index}'
            code = probe('worker', 6000, fault, f'fault-{index}', fault_root)
            if code != 9:
                raise RuntimeError(f'障害注入試験が失敗しました: {code}')
            if probe('worker', 6000, 'none', f'fault-recovery-{index}', fault_root) != 0:
                raise RuntimeError('障害後の復旧試験が失敗しました。')
            report['segments'].append({'kind': fault, 'exitCode': code})
            save()
        # 実際にプロセスを終了・起動し直す。時計を進めて耐久時間を偽装しない。
        while time.monotonic() - started < args.hours * 3600:
            remaining = args.hours * 3600 - (time.monotonic() - started)
            duration = max(1, int(min(args.segment_seconds, remaining) * 1000))
            index = len(report['segments'])
            code = probe('worker', duration, 'none', f'segment-{index}')
            report['elapsedSeconds'] = time.monotonic() - started
            report['segments'].append({'kind': 'restart', 'exitCode': code, 'durationMs': duration})
            if code != 0:
                raise RuntimeError(f'再起動後の検査が失敗しました: {code}')
            report['twoHoursPassed'] = report['elapsedSeconds'] >= 7200
            report['twentyFourHoursPassed'] = report['elapsedSeconds'] >= 93600
            save()
        if probe('inspect', 1000, 'none', 'final-inspection') != 0:
            raise RuntimeError('最終検査が失敗しました。')
        report['status'] = 'passed'
        save()
        return 0
    except Exception as error:
        report.update(status='failed', error=str(error), elapsedSeconds=time.monotonic() - started)
        save()
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
