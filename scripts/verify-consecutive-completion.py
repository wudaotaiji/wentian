#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
実LLM連続完遂検証（Consecutive Completion Verification）
=========================================================

目的
----
「1回だけ応答が返った」ではなく、**稼働中のWentian Gateway（常駐サーバー / daemon）
経由で小さな仕事を連続N回まで完遂できるか**を実測する検証スクリプトです。
過去の連続試験は上流LLMのHTTP 429（利用制限 / rate limit）で停止しており、
連続完遂は未確認のままでした。このスクリプトは合否を推定せず、
次の4点だけを証拠として残します。

  1. 各ラウンドの終了コード（CLI exit code）と経過秒数
  2. 応答本文に指定マーカー（nonce相当）が含まれたか（＝完遂の判定根拠）
  3. 上流利用制限（HTTP 429 / 402 → Gateway HTTP 503 upstream_rate_limited）の発生
  4. ラウンド前後の `/health` に現れた冷却窗（Cool-down Window）とメトリクス

完遂の定義（厳密）
------------------
  exit code == 0 かつ 応答本文に `WENTIAN_LOOP<n>_DONE` が含まれる
応答が返ってもマーカーが無い場合は「完遂」に数えません（answered_without_marker）。
さらに `--model` を指定した場合、Gateway の `/v1/routing/recent` を読み、
**実際に応答したProviderが要求したProviderと一致するか**を取证します。
一致しなければ completed_other_provider（マーカーは出たが要求したLLMが答えていない）として
終了コード2に落とした上で台帳に残します。
（実測で起きた実例: 自動選択だと Planning summary がローカルLLM、
 本文応答がローカル lmstudio/minicpm5-1b になり得る。
  「ローカルLLMで連続完遂」とは別判定なので、ローカルLLM実測では --model 明示が必須。）
上流利用制限は失敗ではなく未完遂（verdict=limited）として分けて数えます。

使い方
------
  python scripts/verify-consecutive-completion.py                 # 既定3ラウンド（自動選択）
  python scripts/verify-consecutive-completion.py --rounds 5 --model lmstudio/local-model
  python scripts/verify-consecutive-completion.py --server http://127.0.0.1:8787
  python scripts/verify-consecutive-completion.py --allow-wait    # 制限時にCLI側待機を許可

終了コード契約（Task Outcome Contract）
--------------------------------------
  0   = 全ラウンド連続完遂
  2   = 未完遂または上流利用制限で停止（Wentian側の不具合とは限らない）
  1   = 検証実行そのものが失敗（Gateway未起動、CLI起動失敗など）
  124 = 全体が時間切れ
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# リポジトリ直下から実行される前提でパスを組み立てる（作業ディレクトリに依存させない）
REPO_ROOT = Path(__file__).resolve().parent.parent
CLI_ENTRY = REPO_ROOT / "bin" / "wentian.js"
DEFAULT_SERVER = "http://127.0.0.1:8787"
DEFAULT_REPORT_ROOT = REPO_ROOT / ".wentian" / "consecutive-completion"
# ラウンド当たりのCLI上限時間（Gateway側のタイムアウトへ渡す）。人が見守る前提の値。
DEFAULT_ROUND_TIMEOUT_MS = 120_000
# 全体時間切れ（秒）。ラウンド数 × ラウンド上限より必ず大きく取る。
DEFAULT_OVERALL_BUDGET_S = 900


def utc_now() -> str:
    """UTCのISO文字列。台帳（manifest）の時刻はすべてUTCで統一する。"""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def decode_stream(raw: bytes) -> str:
    """
    bun.exe は標準出力へパイプ接続時にCP932（日本語Windowsの既定）で書き込むことがある。
    utf-8 → cp932 の順で試み、どちらも失敗するなら損傷を可視化して復号する。
    復号失敗で検証を落ちないようにするのは、失敗理由をマーカー欠落として残すため。
    """
    for encoding in ("utf-8", "cp932"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def recent_routes(server: str) -> list[dict[str, Any]]:
    """
    `/v1/routing/recent`（無認証）から直近のルーティング記録を読む。
    完遂の判定はマーカーでやり、ここは **誰が答えたか**（Provider / 実モデル）の取证に使う。
    応答が返っても実LLM（ローカルLLM）でなければ「ローカルLLM連続完遂」とは数えないため、
    推定ではなくGateway自身の記録で区別する。
    """
    url = f"{server.rstrip('/')}/v1/routing/recent"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(decode_stream(response.read()))
        records = data.get("data")
        return records if isinstance(records, list) else []
    except Exception:
        return []


def health_snapshot(server: str) -> dict[str, Any]:
    """
    Gateway の /health を読む（実LLMを起動しないのでTokensを消費しない）。
    冷却窗 upstreamLimits とメトリクスだけを取り出し、読めなさは error として残す。
    """
    url = f"{server.rstrip('/')}/health"
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            body = decode_stream(response.read())
        data = json.loads(body)
        return {
            "url": url,
            "httpStatus": int(response.status),
            "status": data.get("status"),
            "upstreamLimits": data.get("upstreamLimits"),
            "metrics": data.get("metrics"),
        }
    except urllib.error.HTTPError as error:  # 401/404なども数値として残す
        return {"url": url, "httpStatus": int(error.code), "error": str(error)}
    except Exception as error:  # 接続不可（常駐が止まっている等）を失敗で落とさない
        return {"url": url, "httpStatus": None, "error": f"{type(error).__name__}: {error}"}


def run_round(node: str, server: str, round_index: int, timeout_ms: int, allow_wait: bool,
              model: str = "") -> dict[str, Any]:
    """
    1ラウンド = 小さな指示を1回、Wentian CLI 経由で Gateway に投げ、マーカー出現で完遂判定する。
    --execution-mode direct は外部エージェント（External Agent）へ委譲しない指定。
    実装能力検証が未合格のAgentを実作業に使わない方針と整合させ、ローカルLLM直接応答だけを見る。
    model を指定した場合は `--model` で固定する（既定の自動選択だとローカルモデルが
    応答した場合と区別できないため、ローカルLLM実測では明示指定を前提にする）。
    """
    marker = f"WENTIAN_LOOP{round_index}_DONE"
    prompt = (
        f"ファイル、コマンド、外部接続、ツールを一切操作しないでください。"
        f"次の文字列だけをそのまま1行で出力してください: {marker}"
    )
    argv = [
        node, str(CLI_ENTRY), "agent",
        "--server", server,
        "--execution-mode", "direct",
        "--timeout-ms", str(timeout_ms),
        "--json",
    ]
    if model:
        argv += ["--model", model]
    if allow_wait:
        # 既定オフのCLI側待機を明示的に有効化する（人の承認がある実行だけ）
        argv.append("--wait-on-limit")
    argv.append(prompt)

    # 作業者がそのまま再実行できる完全なコマンドラインを台帳に残す（省略表記は禁止）
    command_line = " ".join(argv[:-1] + [f'"{prompt}"'])
    started = time.monotonic()
    record: dict[str, Any] = {
        "round": round_index,
        "marker": marker,
        "commandLine": command_line,
        "requestedModel": model or "wentian-auto/all（自動選択）",
        "startedAt": utc_now(),
    }
    # ラウンド開始時のルーティング記録。終了後の差分＝このラウンドで発生した上流要求。
    routes_before = {str(r.get("requestId")) for r in recent_routes(server)}
    record["routeCountBefore"] = len(routes_before)
    try:
        process = subprocess.run(
            argv,
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=max(30, timeout_ms // 1000 + 30),  # CLI側の上限より常に長めに取り、時間切れを区別する
        )
        record["exitCode"] = int(process.returncode)
        record["output"] = decode_stream(process.stdout or b"")
    except subprocess.TimeoutExpired as error:
        record["exitCode"] = 124
        record["output"] = decode_stream(error.stdout or b"") if isinstance(error.stdout, bytes) else ""
        record["timeout"] = True
    except Exception as error:  # CLI起動失敗などは「検証実行の失敗」側
        record["exitCode"] = None
        record["output"] = ""
        record["launchError"] = f"{type(error).__name__}: {error}"

    record["elapsedMs"] = int((time.monotonic() - started) * 1000)
    output = record.get("output", "")

    # このラウンドで増えた上流要求だけを取り出す（Gateway自身の記録が最終証拠）
    new_routes = [r for r in recent_routes(server) if str(r.get("requestId")) not in routes_before]
    record["routes"] = [
        {
            "requestedModel": r.get("requestedModel"),
            "resolvedModel": r.get("resolvedModel"),
            "provider": r.get("provider"),
            "outcome": r.get("outcome"),
            "latencyMs": r.get("latencyMs"),
            "attempted": r.get("attempted"),
            "timestamp": r.get("timestamp"),
        }
        for r in new_routes
    ]
    record["servedProviders"] = sorted({str(r.get("provider")) for r in new_routes})
    record["servedModels"] = sorted({str(r.get("resolvedModel")) for r in new_routes})
    # ローカルLLM固定の実測でローカルProviderが混ざった場合は、完遂しても「ローカルLLM完遂」に数えない
    if model and record["servedProviders"]:
        wanted_provider = model.split("/")[0]
        record["servedByRequestedProvider"] = wanted_provider in record["servedProviders"]
    else:
        record["servedByRequestedProvider"] = None

    # 完遂判定: 終了コード0 かつ 応答本文にマーカーが含まれる。
    # ただしCLIは Planning summary で **依頼文をそのままオウム返し**するため、
    # 生出力への単純な部分一致では誤検知する（実測で確認: 上流429で回答が無いラウンドでも
    # 依頼文内のマーカーに一致してしまった）。そこで依頼文を含む行を落とした後の
    # 応答専有領域だけを「回答本文」として扱い、その中でマーカーを探す。
    answer_only = "\n".join(
        line for line in output.splitlines()
        if not (marker in line and ("出力してください" in line or "目的:" in line))
    )
    record["markerEchoLines"] = len(output.splitlines()) - len(answer_only.splitlines())
    record["markerFound"] = marker in answer_only
    record["completed"] = record.get("exitCode") == 0 and record["markerFound"]
    try:
        record["jsonParsed"] = True
        record["response"] = json.loads(output[output.find("{"):] if "{" in output else output)
    except Exception:
        record["jsonParsed"] = False
        record["response"] = None

    lowered = output.lower()
    record["upstreamLimited"] = any(token in lowered for token in ("upstream_rate_limited", "利用制限", "rate limit"))
    # strictCompleted = マーカー完遂 かつ 要求したProviderが実際に応答した。
    # 自動選択でローカルモデルが答えたラウンドは「ローカルLLM連続完遂」の証拠にしない。
    record["strictCompleted"] = bool(record["completed"] and record["servedByRequestedProvider"] is not False)
    if record["completed"]:
        record["outcome"] = "completed" if record["strictCompleted"] else "completed_other_provider"
    elif record["upstreamLimited"]:
        record["outcome"] = "limited"
    elif record.get("timeout"):
        record["outcome"] = "timeout"
    elif record.get("exitCode") == 0:
        record["outcome"] = "answered_without_marker"
    elif record.get("exitCode") is None:
        record["outcome"] = "launch_failed"
    else:
        record["outcome"] = "failed"
    return record


def verdict(exit_code: int) -> str:
    """終了コードの意味を1行で返す（契約と同じ意味に揃える）。"""
    return {
        0: "連続完遂: 全ラウンドがマーカー付きで完了しました。",
        2: "未完遂: 上流利用制限または未完遂のラウンドがあります（Wentian側の不具合とは限りません）。",
        124: "時間切れ: 検証が予算内で終わりませんでした。",
    }.get(exit_code, "検証実行の失敗: 実行そのものが完了していません。")


def write_reports(report_root: Path, rounds: list[dict[str, Any]], health: list[dict[str, Any]],
                  server: str, exit_code: int, overall_budget_s: int, model: str = "") -> tuple[Path, Path]:
    """実行台帳（JSON）と報告（Markdown）を .wentian 配下（Git除外）へ残す。"""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    report_root.mkdir(parents=True, exist_ok=True)
    manifest_path = report_root / f"{stamp}-consecutive-completion.json"
    report_path = report_root / f"{stamp}-consecutive-completion.md"

    completed = sum(1 for r in rounds if r["outcome"] == "completed")
    # 連続完遂長 = 先頭から続く completed の最長連続数ではなく、真の最長連続区間を数える
    streak = best = 0
    for r in rounds:
        streak = streak + 1 if r["outcome"] == "completed" else 0
        best = max(best, streak)
    manifest = {
        "version": 1,
        "observedAt": utc_now(),
        "repository": str(REPO_ROOT),
        "server": server,
        "requestedModel": model or "wentian-auto/all（自動選択）",
        "overallBudgetSeconds": overall_budget_s,
        "rounds": rounds,
        "health": health,
        "summary": {
            "plannedRounds": len(rounds),
            "completed": completed,
            "markerCompleted": sum(1 for r in rounds if r.get("markerFound") and r.get("exitCode") == 0),
            "otherProvider": sum(1 for r in rounds if r["outcome"] == "completed_other_provider"),
            "longestConsecutiveCompleted": best,
            "limited": sum(1 for r in rounds if r["outcome"] == "limited"),
            "failed": sum(1 for r in rounds if r["outcome"] in ("failed", "launch_failed")),
            "unmarked": sum(1 for r in rounds if r["outcome"] == "answered_without_marker"),
            "timeout": sum(1 for r in rounds if r["outcome"] == "timeout"),
        },
        "exitCode": exit_code,
        "verdict": verdict(exit_code),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# 実LLM連続完遂検証 報告（Consecutive Completion）",
        "",
        f"- 観測時刻（UTC）: {manifest['observedAt']}",
        f"- Gateway: {server}",
        f"- 結果: {manifest['verdict']}",
        f"- 終了コード: {exit_code}",
        "",
        "| ラウンド | 判定 | exit | 経過ms | マーカー | 応答Provider | 応答モデル |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in rounds:
        lines.append(
            f"| {r['round']} | {r['outcome']} | {r.get('exitCode')} | {r.get('elapsedMs')} "
            f"| {'はい' if r['markerFound'] else 'いいえ'} "
            f"| {', '.join(r.get('servedProviders') or []) or '不明'} "
            f"| {', '.join(r.get('servedModels') or []) or '不明'} |"
        )
    lines += [
        "",
        f"連続完遂した最長区間: **{best} / {len(rounds)}**",
        "",
        "## 実行コマンド（そのまま再実行できます）",
        "",
        "```powershell",
        "python scripts/verify-consecutive-completion.py --rounds 3"
        + (f" --model {model}" if model else ""),
        "```",
        "",
        "```text",
    ]
    for r in rounds:
        lines.append(r["commandLine"])
    lines.append("```")
    lines += ["", "## /health 実測（冷却窗とメトリクス）", "", "```json"]
    lines.append(json.dumps(health, ensure_ascii=False, indent=1))
    lines += ["```", "", "## 各ラウンド応答末尾（先頭400字）", ""]
    for r in rounds:
        lines.append(f"### ラウンド {r['round']}（{r['outcome']}）")
        lines.append("")
        lines.append("```text")
        lines.append((r.get("output") or "").strip()[:400])
        lines.append("```")
        lines.append("")
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return manifest_path, report_path


def main() -> int:
    parser = argparse.ArgumentParser(description="実LLM連続完遂検証（Wentian Gateway 経由）")
    parser.add_argument("--rounds", type=int, default=3, help="連続実行するラウンド数（既定3）")
    parser.add_argument("--server", default=DEFAULT_SERVER, help="Gateway URL（既定 http://127.0.0.1:8787）")
    parser.add_argument("--node", default="node", help="node 実行ファイル（既定 node）")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_ROUND_TIMEOUT_MS, help="1ラウンドのCLI上限ms")
    parser.add_argument("--budget-seconds", type=int, default=DEFAULT_OVERALL_BUDGET_S, help="全体の時間予算（秒）")
    parser.add_argument("--model", default="", help="応答モデルを固定（例 lmstudio/local-model。既定は自動選択）")
    parser.add_argument("--allow-wait", action="store_true", help="CLI側の上流制限待機を許可（--wait-on-limit）")
    parser.add_argument("--stop-on-incomplete", action="store_true", help="未完遂のラウンドで即時停止する")
    parser.add_argument("--report-root", default=str(DEFAULT_REPORT_ROOT), help="台帳と報告の出力先")
    args = parser.parse_args()

    if args.rounds < 1:
        print("--rounds は1以上を指定してください。", file=sys.stderr)
        return 1

    report_root = Path(args.report_root)
    health: list[dict[str, Any]] = []
    rounds: list[dict[str, Any]] = []
    started = time.monotonic()
    exit_code = 0

    before = health_snapshot(args.server)
    health.append({"when": "before", **before})
    # 常駐が読んでいない場合は検証実行の失敗（上流の問題ではなく手前の問題）
    if before.get("httpStatus") is None:
        print(f"Gateway に到達できません: {before.get('error')}", file=sys.stderr)
        manifest_path, report_path = write_reports(report_root, rounds, health, args.server, 1,
                                                   args.budget_seconds, args.model)
        print(f"実行台帳: {manifest_path}")
        print(f"報告: {report_path}")
        return 1

    for index in range(1, args.rounds + 1):
        if time.monotonic() - started > args.budget_seconds:
            exit_code = 124
            break
        print(f"▶ ラウンド {index}/{args.rounds}: ローカルLLM経由で完遂確認（マーカー WENTIAN_LOOP{index}_DONE）")
        record = run_round(args.node, args.server, index, args.timeout_ms, args.allow_wait, args.model)
        rounds.append(record)
        health.append({"when": f"after-round-{index}", **health_snapshot(args.server)})
        print(f"  └ {record['outcome']} / exit={record.get('exitCode')} / {record.get('elapsedMs')}ms"
              f" / マーカー={'あり' if record['markerFound'] else 'なし'}"
              f" / 応答={', '.join(record.get('servedModels') or []) or '不明'}")
        if record["outcome"] != "completed":
            exit_code = 2
            if args.stop_on_incomplete:
                break

    if not rounds:
        exit_code = 124
    if all(r["outcome"] == "completed" for r in rounds) and rounds:
        exit_code = 0

    manifest_path, report_path = write_reports(report_root, rounds, health, args.server, exit_code,
                                               args.budget_seconds, args.model)
    print()
    print(verdict(exit_code))
    print(f"実行台帳: {manifest_path}")
    print(f"報告: {report_path}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
