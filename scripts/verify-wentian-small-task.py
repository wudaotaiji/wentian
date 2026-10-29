"""Wentian内部の直接実行で、小さな移行修正を繰り返し検収する実機検証です。

編集対象は専用フィクスチャー（Fixture）のapp.jsonだけです。既存アプリ・設定・
外部エージェントを直接操作しません。変更、受入、原本反映はWentianが実行します。
計測結果を.wentian/evaluation-validation以下へ、原本・台帳は専用一時領域へ保持します。
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import tempfile
import hashlib
import shutil
from datetime import datetime

# 受入プログラムは、モデルが書き換えられない保護ファイル（Protected File）にします。
PYTHON_CHECK = '''"""小さな移行修正を、Agentの自己申告によらず検収します。"""
import json
import sys
import urllib.request
from pathlib import Path
before = json.loads(Path("baseline.json").read_text(encoding="utf-8"))
after = json.loads(Path("app.json").read_text(encoding="utf-8"))
# 新接続先・有効モデル・有効/無効・独自設定の保存をまとめて検査します。
assert after["target"]["endpoint"] == "http://127.0.0.1:1234/v1"
assert after["target"]["model"] == "local-model"
assert after["target"]["enabled"] == before["target"]["enabled"]
assert after["target"]["note"] == before["target"]["note"]
assert after["custom"] == before["custom"]
assert "legacy-local-host" not in json.dumps(after)
assert after["target"]["model"] != "legacy-model"
if "--check-api" in sys.argv:
    # 承認済みのローカルLLMだけへ接続し、認証値を送信・出力しません。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open("http://127.0.0.1:1234/v1/models", timeout=15) as response:
        models = json.load(response)
    assert any(item["id"] == "local-model" for item in models["data"])
    request = urllib.request.Request("http://127.0.0.1:1234/v1/chat/completions", data=json.dumps({"model":"local-model","messages":[{"role":"user","content":"WENTIAN_API_OKだけを返してください。"}],"max_tokens":512,"reasoning_effort":"low"}).encode(), headers={"Content-Type":"application/json"})
    with opener.open(request, timeout=30) as response:
        answer = json.load(response)
    assert answer["choices"][0]["message"].get("content", "").strip()
print("受入検証に合格しました。")
'''

# 同じ受入条件をPowerShell版にも用意し、機械的な条件をレビュー可能にします。
POWERSHELL_CHECK = '''# Agentの自己申告ではなく、試験フィクスチャーの実内容を検査します。
$ErrorActionPreference = 'Stop'
$before = Get-Content -LiteralPath 'baseline.json' -Raw | ConvertFrom-Json
$after = Get-Content -LiteralPath 'app.json' -Raw | ConvertFrom-Json
# 接続先・モデル・利用可否・独自設定を、変更前と期待値へ照合します。
if ($after.target.endpoint -ne 'http://127.0.0.1:1234/v1' -or $after.target.model -ne 'local-model') { throw '新接続設定に不一致があります。' }
if ($after.target.enabled -ne $before.target.enabled -or $after.target.note -ne $before.target.note) { throw '既存設定が保全されていません。' }
if (($after.custom | ConvertTo-Json -Compress) -ne ($before.custom | ConvertTo-Json -Compress)) { throw '独自設定が変更されています。' }
if ((Get-Content -LiteralPath 'app.json' -Raw) -match 'legacy-local-host|legacy-model') { throw '旧接続先・旧モデルが残っています。' }
Write-Output '受入検証に合格しました。'
'''


def preserve_evidence(fixture: Path, destination: Path, outcome: dict) -> dict:
    """原資料を変更せず永続領域へ複製し、参照先とハッシュを記録します。"""
    destination.mkdir(parents=True, exist_ok=True)
    files = {}
    missing = []

    def copy_record(source: Path, relative: str, required: bool = True) -> None:
        # 任意の利用者ファイルや認証状態を収集せず、専用試験の既知資料だけをコピーします。
        if not source.is_file() or source.is_symlink():
            if required:
                missing.append(relative)
            return
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        files[relative] = {"sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "bytes": target.stat().st_size}

    for name in ("app.json", "baseline.json", "verify.py", "verify.ps1", "cli.json", "cli.log", ".wentian/acceptance.json"):
        copy_record(fixture / name, name)
    manifest_path = Path(outcome["manifestPath"]) if outcome.get("manifestPath") else None
    if manifest_path:
        # 台帳の参照はこのフィクスチャー内に限定し、モデル出力による任意収集を防ぎます。
        manifest_path.resolve().relative_to(fixture.resolve())
        copy_record(manifest_path, "manifest.json")
        if manifest_path.is_file():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            stage_name = manifest.get("result", {}).get("workspace", {}).get("directory")
            if stage_name:
                stage = Path(stage_name)
                if stage.parent.resolve() != Path(tempfile.gettempdir()).resolve() or not stage.name.startswith("wentian-task-"):
                    raise ValueError("隔離作業場所の参照が試験用一時領域外です。")
                for name in ("app.json", "baseline.json", "verify.py", "verify.ps1"):
                    copy_record(stage / name, "stage/" + name, required=False)
    index = {"version": 1, "sourceFixture": str(fixture), "originalManifestPath": str(manifest_path) if manifest_path else None, "manifest": "manifest.json" if "manifest.json" in files else None, "complete": not missing, "missing": missing, "files": files}
    (destination / "evidence.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"directory": str(destination), "index": str(destination / "evidence.json"), "complete": index["complete"], "manifestPath": str(destination / "manifest.json") if index["manifest"] else None}


def archive_existing(report: Path) -> int:
    """既存の試験記録から残存資料だけを退避します。消失資料を再生成しません。"""
    summary_path = report / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    for item in summary["results"]:
        fixture = Path(item["fixture"])
        if fixture.parent.parent.resolve() != Path(tempfile.gettempdir()).resolve() or not fixture.parent.name.startswith("wentian-evaluation-"):
            raise ValueError("既存資料の収集先は専用試験フィクスチャーに限定してください。")
        item["evidence"] = preserve_evidence(fixture, report / f"fixture-{item['trial']:02d}", item["outcome"])
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"既存原資料の退避結果: {summary_path}", flush=True)
    return 0 if all(item["evidence"]["complete"] for item in summary["results"]) else 1


def main() -> int:
    """既存Gatewayへ依頼し、CLI終了コードとホスト検収を独立に照合します。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default="http://127.0.0.1:8787")
    parser.add_argument("--model", default="lmstudio/local-model")
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--check-api", action="store_true")
    parser.add_argument("--interval-seconds", type=int, default=60)
    parser.add_argument("--archive-existing", type=Path)
    args = parser.parse_args()
    if args.archive_existing:
        return archive_existing(args.archive_existing.resolve())
    if not 1 <= args.repeat <= 5:
        raise ValueError("繰り返しは1～5回で指定してください。")
    if not 0 <= args.interval_seconds <= 300:
        raise ValueError("試験間隔は0～300秒で指定してください。")
    project = Path(__file__).resolve().parent.parent
    report = project / ".wentian/evaluation-validation" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    report.mkdir(parents=True, exist_ok=False)
    # リポジトリーの無視対象.wentian内ではGit列挙から試験入力が落ちるため、
    # 実行用フィクスチャーは独立した一時ディレクトリーへ作り、検収用に保持します。
    fixture_root = Path(tempfile.mkdtemp(prefix="wentian-evaluation-"))
    results = []
    for index in range(args.repeat):
        # 社内サービスの利用制限を尊重して、連続した試験の間に間隔を置きます。
        if index:
            print(f"次の試験まで{args.interval_seconds}秒の間隔を置きます。", flush=True)
            time.sleep(args.interval_seconds)
        fixture = fixture_root / f"fixture-{index + 1:02d}"
        fixture.mkdir()
        before = {"target": {"endpoint": "http://legacy-local-host:8080/v1", "model": "legacy-model", "enabled": bool(index % 2), "note": "既存値を維持"}, "custom": {"endpoint": "http://localhost:11434/v1", "model": "custom-model", "enabled": False}}
        serialized = json.dumps(before, ensure_ascii=False, indent=2)
        for name in ("app.json", "baseline.json"):
            (fixture / name).write_text(serialized, encoding="utf-8")
        (fixture / "verify.py").write_text(PYTHON_CHECK, encoding="utf-8")
        (fixture / "verify.ps1").write_text(POWERSHELL_CHECK, encoding="utf-8")
        acceptance = {"version": 1, "protectedFiles": ["baseline.json", "verify.py", "verify.ps1"], "commands": [{"id": "migration", "criterion": "旧URLなし・モデル有効・利用可否保全・独自設定保全" + ("・実API応答" if args.check_api else ""), "executable": sys.executable, "args": ["verify.py"] + (["--check-api"] if args.check_api else []), "timeoutMs": 60000}]}
        (fixture / ".wentian").mkdir()
        (fixture / ".wentian/acceptance.json").write_text(json.dumps(acceptance, ensure_ascii=False), encoding="utf-8")
        prompt = "再委譲は禁止です。app.jsonだけを編集して移行を実装してください。target.endpointをhttp://127.0.0.1:1234/v1、target.modelをlocal-modelへ変更してください。target.enabled、target.note、customの全設定を維持してください。read_fileとwrite_fileだけを使ってください。テストはWentianホストが実施するのでrun_commandは使用しないでください。最後に短く報告してください。"
        command = ["node", str(project / "bin/wentian.js"), "agent", "--server", args.server, "--model", args.model, "--execution-mode", "direct", "--allow-write", "app.json", "--timeout-ms", "120000", "--json", "--", prompt]
        env = dict(os.environ, WENTIAN_INSTALL_ROOT=str(project), WENTIAN_ENV_FILE=str(project / ".env"), WENTIAN_PLANNER_MODEL=args.model)
        started = time.monotonic()
        process = subprocess.Popen(command, cwd=fixture, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", start_new_session=os.name != "nt")
        try:
            output, log = process.communicate(timeout=150)
        except subprocess.TimeoutExpired:
            # 外側期限も親子を停止してから記録し、未停止のまま次の試験を始めません。
            if os.name == "nt":
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
            else:
                import signal
                os.killpg(process.pid, signal.SIGKILL)
            output, log = process.communicate(timeout=10)
            log += "\n外側の安全期限を超過したため試験を停止しました。"
        (fixture / "cli.json").write_text(output, encoding="utf-8")
        (fixture / "cli.log").write_text(log, encoding="utf-8")
        try:
            outcome = json.loads(output)
        except ValueError:
            outcome = {"status": "failed", "reason": "構造化結果を解析できませんでした。"}
        # 壊れた出力も検証失敗として残し、JSON解析例外で証拠退避を飛ばしません。
        validation_error = None
        try:
            after = json.loads((fixture / "app.json").read_text(encoding="utf-8"))
            passed = process.returncode == 0 and outcome.get("status") == "success" and after["target"]["endpoint"] == "http://127.0.0.1:1234/v1" and after["target"]["model"] == "local-model" and after["target"]["enabled"] == before["target"]["enabled"] and after["custom"] == before["custom"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            passed = False
            validation_error = f"原本の検収に失敗しました: {type(error).__name__}"
        result = {"trial": index + 1, "passed": passed, "elapsedSeconds": round(time.monotonic() - started, 2), "cliExitCode": process.returncode, "outcome": outcome, "fixture": str(fixture)}
        if validation_error:
            result["hostValidationError"] = validation_error
        # 成功・失敗にかかわらず一時領域から先に退避し、証拠不足も独立した失敗とします。
        result["evidence"] = preserve_evidence(fixture, report / f"fixture-{index + 1:02d}", outcome)
        result["passed"] = passed = passed and result["evidence"]["complete"]
        results.append(result)
        (report / "summary.json").write_text(json.dumps({"model": args.model, "apiChecked": args.check_api, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"試験{index + 1}: {'合格' if passed else '未完了'} / {result['elapsedSeconds']}秒 / 終了コード{process.returncode}", flush=True)
        if process.returncode in (124, 130) or process.returncode is None:
            break
        # 同じ失敗が続いた場合は、未確認候補や同じ接続先を際限なく試しません。
        if len(results) >= 2 and not passed and not results[-2]["passed"] and outcome.get("reason") == results[-2]["outcome"].get("reason"):
            print("同じ失敗が2回続いたため、原因確認まで再試行を停止します。")
            break
    print(f"検証記録: {report / 'summary.json'}")
    return 0 if len(results) == args.repeat and all(item["passed"] for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
