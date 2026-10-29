"""既存のLM Studioモデルを一度だけロードし、資源を監視して終了後に解放する。

実行には --execute が必須。モデル・保存先・CLIは引数から受け取る。
保守の許可や閾値、利用者のモデル選択、モデルファイルは変更しない。
低負荷の基準値を確認してからロードし、90%・計測不能・時間超過で中断する。
中断時の強制終了は、開始後に発生したllama-serverのうち、作成時刻を
再確認できたものだけを対象とし、開始時に存在したプロセスを保護する。
"""
import argparse
import datetime
import json
import os
import pathlib
import queue
import subprocess
import threading
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--report-dir', required=True)
    parser.add_argument('--lms-command', default='lms')
    parser.add_argument('--context-length', type=int, default=4096)
    parser.add_argument('--timeout-seconds', type=int, default=60)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('実モデルを起動する場合は --execute を明示してください。')
    from urllib.parse import urlparse
    endpoint = urlparse(args.base_url)
    if endpoint.scheme != 'http' or endpoint.hostname not in ('127.0.0.1', 'localhost', '::1') or endpoint.username or endpoint.password:
        parser.error('この検証では認証情報をURLに含めないローカル接続先を指定してください。')
    if args.context_length < 512 or not 5 <= args.timeout_seconds <= 120:
        parser.error('文脈長または試験時間が範囲外です。')
    report = pathlib.Path(args.report_dir).resolve()
    report.mkdir(parents=True, exist_ok=True)
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    identifier = f'wentian-load-verification-{os.getpid()}'

    def models():
        headers = {}
        if os.getenv('LMSTUDIO_API_KEY'):
            headers['Authorization'] = 'Bearer ' + os.environ['LMSTUDIO_API_KEY']
        request = urllib.request.Request(args.base_url.rstrip('/') + '/api/v1/models', headers=headers)
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)['models']

    # 既存モデルを退避・終了することがないよう、ロード中のモデルがあると実行しません。
    catalog = models()
    selected = next((m for m in catalog if m.get('key') == args.model and m.get('type') == 'llm'), None)
    if selected is None or any(m.get('loaded_instances') for m in catalog):
        raise RuntimeError('対象が未確認、または既存モデルがロード中のため試験を開始しません。')
    samples = queue.Queue()
    sensor_error = (report / 'sensor-error.log').open('w', encoding='utf-8')
    sensor = subprocess.Popen(['powershell.exe', '-NoProfile', '-NonInteractive', '-File',
        str(pathlib.Path(__file__).with_suffix('.ps1')), '-Monitor'], stdout=subprocess.PIPE,
        stderr=sensor_error, encoding='utf-8', creationflags=flags)

    def collect():
        for line in sensor.stdout:
            try:
                samples.put(json.loads(line))
            except ValueError:
                samples.put({'error': '計測応答が不正です。'})
    threading.Thread(target=collect, daemon=True).start()
    records, child, new_engines = [], None, {}
    outcome, reason, loaded = 'not_started', '', False
    started = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        baseline = samples.get(timeout=15)
        records.append(baseline)
        if 'error' in baseline or not isinstance(baseline.get('usage'), dict):
            raise RuntimeError('開始前の資源計測に失敗しました。')
        if baseline.get('engines'):
            raise RuntimeError('既存のllama-serverがあるため試験を開始しません。')
        if max(baseline['usage'][key] for key in ('cpu', 'memory', 'disk', 'network')) >= 80:
            raise RuntimeError('開始前の資源使用率が80%以上のため試験を開始しません。')
        with (report / 'load.log').open('w', encoding='utf-8') as output:
            child = subprocess.Popen([args.lms_command, 'load', args.model, '--context-length',
                str(args.context_length), '--parallel', '1', '--ttl', '30', '--identifier', identifier, '--yes'],
                stdout=output, stderr=subprocess.STDOUT, creationflags=flags)
            deadline = time.monotonic() + args.timeout_seconds
            outcome = 'running'
            while True:
                if time.monotonic() >= deadline:
                    outcome, reason = 'aborted', '制限時間に到達しました。'
                    break
                try:
                    sample = samples.get(timeout=5)
                except queue.Empty:
                    outcome, reason = 'aborted', '資源監視の応答が5秒間ありません。'
                    break
                records.append(sample)
                for engine in sample.get('engines', []):
                    new_engines[engine['pid']] = engine
                # 既存の容量不足は記録のみ。保守の容量保護を解除せず、手動の読込みを検証します。
                if 'error' in sample or not isinstance(sample.get('usage'), dict) or max(sample['usage'][key] for key in ('cpu', 'memory', 'disk', 'network')) >= 90:
                    outcome, reason = 'aborted', '資源90%以上または計測不能のため中断しました。'
                    break
                if child.poll() is not None:
                    loaded = child.returncode == 0 and any(
                        i.get('id') == identifier for m in models() for i in m.get('loaded_instances', []))
                    outcome = 'loaded' if loaded else 'failed'
                    reason = '実モデルのロード完了をAPIで確認しました。' if loaded else 'ロード処理が失敗しました。'
                    break
    except Exception:
        # 未確認の状態を成功にせず、計測前の失敗も結果ファイルへ残します。
        outcome = 'aborted' if child else 'not_started'
        reason = '計測またはロード状態の確認に失敗したため、試験を中止しました。'
    finally:
        # 終了成功・中断の両方で、試験専用の識別子だけをアンロードします。
        if child and child.poll() is None:
            child.terminate()
            child.wait(timeout=5)
        if outcome == 'aborted':
            # 試験開始時にエンジンが0件であることを確認済みです。
            # PID再利用・同名の別プロセスを避けるため、名前と作成時刻を再検証します。
            for engine in new_engines.values():
                command = (f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={engine['pid']}'; "
                    f"if($p -and $p.Name -eq 'llama-server.exe' -and "
                    f"$p.CreationDate.ToUniversalTime().ToString('o') -eq '{engine['created']}') "
                    "{ Stop-Process -Id $p.ProcessId -Force }")
                subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, creationflags=flags)
        if child:
            try:
                subprocess.run([args.lms_command, 'unload', identifier], stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL, timeout=5, creationflags=flags)
            except subprocess.TimeoutExpired:
                # 後続のAPI確認で残存を検査し、応答しないアンロードを待ち続けません。
                pass
        # 負荷低下も同じ計測プロセスで記録します。
        for _ in range(3):
            try:
                records.append(samples.get(timeout=5))
            except queue.Empty:
                break
        sensor.terminate()
        sensor.wait(timeout=5)
        sensor_error.close()
        remaining = [i['id'] for m in models() for i in m.get('loaded_instances', []) if i.get('id') == identifier]
        result = {'startedAt': started, 'model': args.model, 'identifier': identifier,
            'contextLength': args.context_length, 'outcome': outcome, 'reason': reason,
            'loaded': loaded, 'cleanupConfirmed': not remaining, 'samples': len(records),
            'peak': {key: max(((r.get('usage') or {}).get(key, 0) for r in records), default=0)
                for key in ('cpu', 'memory', 'disk', 'network', 'diskCapacity')}}
        (report / 'samples.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding='utf-8')
        (report / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))
    return 0 if outcome in ('loaded', 'aborted') and not remaining else 1


if __name__ == '__main__':
    raise SystemExit(main())
