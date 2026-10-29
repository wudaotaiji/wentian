"""実時間試験の終了を監視し、実結果と再検査を改善台帳へ反映する。時計の短縮はしない。"""
import argparse
import json
import subprocess
import time
from pathlib import Path
from datetime import datetime, timezone


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--harness', required=True)
    parser.add_argument('--document', required=True, help='利用者が管理する私有検収台帳の既存Markdownファイル')
    args = parser.parse_args()
    workspace = Path(__file__).resolve().parents[1]
    harness_path = Path(args.harness).resolve()
    # 出力先はこの改善作業の既知領域に固定し、外部の文書や設定を書き換えない。
    evidence = workspace / 'docs/evidence/20261004_improvements'
    evidence.mkdir(parents=True, exist_ok=True)
    result_path = evidence / 'final-acceptance.json'
    # 内部台帳を公開docsへ再作成せず、利用者が明示した既存ファイルだけに追記します。
    document = Path(args.document).resolve()
    if not document.is_file() or document.suffix.lower() != '.md':
        parser.error('追記先の既存Markdownファイルを指定してください。')
    result = {'status': 'waiting_for_real_duration', 'startedAt': datetime.now(timezone.utc).isoformat()}

    def save():
        temporary = result_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        temporary.replace(result_path)

    def check(command, name):
        # シェル文字列を使わず、検査本体をホストの既知ファイルへ固定する。
        with (evidence / name).open('w', encoding='utf-8') as output:
            return subprocess.run(command, cwd=workspace, stdout=output, stderr=subprocess.STDOUT, timeout=600).returncode

    save()
    try:
        while True:
            harness = json.loads(harness_path.read_text(encoding='utf-8'))
            if harness['status'] != 'running':
                break
            # 子プロセスとして待機し、Codexの対話や利用者の作業はブロックしない。
            time.sleep(30)
        if harness['status'] != 'passed' or not harness['twoHoursPassed'] or not harness['twentyFourHoursPassed'] or harness['elapsedSeconds'] < 93600:
            raise RuntimeError('2時間＋24時間の実時間試験に合格していません。')
        probe_root = harness_path.parent / 'runtime/probes/durability-test'
        progress = json.loads((probe_root / 'progress.json').read_text(encoding='utf-8'))
        report = json.loads((probe_root / 'last-report.json').read_text(encoding='utf-8'))
        if not report['passed'] or progress['invariantChecks']['failed'] or progress['effectsApplied'] != 8 or progress['done'] != 8:
            raise RuntimeError('不変条件・成果物・二重反映検査が合格していません。')
        # スリープやPC停止による無観測時間を、稼働時間の合格へ混ぜない。
        previous = None
        first = None
        max_gap = 0
        with (probe_root / 'events.jsonl').open(encoding='utf-8') as events:
            for line in events:
                event = json.loads(line)
                raw = event.get('at') or event.get('timestamp')
                if not raw:
                    continue
                current = datetime.fromisoformat(raw.replace('Z', '+00:00'))
                if first is None:
                    first = current
                if previous is not None:
                    max_gap = max(max_gap, (current - previous).total_seconds())
                previous = current
        observation_span = (previous - first).total_seconds() if previous is not None else 0
        if previous is None or observation_span < 93500 or max_gap > 120 or progress['probes'] < 93600 * 0.8:
            raise RuntimeError('長い無観測時間または検査回数不足のため、継続稼働を合格にできません。')
        result.update(status='rechecking_current_source', elapsedSeconds=harness['elapsedSeconds'], observationSpanSeconds=observation_span, probes=progress['probes'], restarts=progress['starts'], maxObservationGapSeconds=max_gap)
        save()
        # tsconfigと試験を現在のソースで再検査する。候補のnpmスクリプトは実行しない。
        if check(['node', 'node_modules/typescript/bin/tsc', '--noEmit'], 'final-typecheck.log') != 0:
            raise RuntimeError('終了時の型検査が失敗しました。')
        tests = sorted(str(file) for file in (workspace / 'src').glob('*.test.ts'))
        if check(['node', '--import', 'tsx', '--import', './src/test-environment.ts', '--test', *tests], 'final-tests.log') != 0:
            raise RuntimeError('終了時の全体試験が失敗しました。')
        (evidence / 'durability-final-harness.json').write_text(json.dumps(harness, ensure_ascii=False, indent=2), encoding='utf-8')
        (evidence / 'durability-final-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        result.update(status='passed', finishedAt=datetime.now(timezone.utc).isoformat())
        save()
        # 合格した事実だけを追記。実ブラウザーの目視確認とは区別する。
        note = '\n\n## 実時間試験の最終検収（自動追記）\n\n'
        note += f"検収時刻: {result['finishedAt']}。実時間2時間＋24時間、不変条件・二重反映・再起動整合性、終了時の型検査・全体試験が合格。最大無観測間隔{max_gap:.2f}秒、検査回数{progress['probes']}、起動回数{progress['starts']}。\n\n"
        note += '証拠: [最終検収JSON](evidence/20261004_improvements/final-acceptance.json)、[型検査](evidence/20261004_improvements/final-typecheck.log)、[全体試験](evidence/20261004_improvements/final-tests.log)。実LLMの26時間判断精度・本番配備・実ブラウザー目視は、この試験の保証範囲に含めない。\n'
        with document.open('a', encoding='utf-8') as output:
            output.write(note)
        return 0
    except Exception as error:
        result.update(status='failed', error=str(error), finishedAt=datetime.now(timezone.utc).isoformat())
        save()
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
