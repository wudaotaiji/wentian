#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Wentian外部エージェントの実装能力検証ランナー（Work Capability Verification Runner）。

目的:
  「接続確認済み（HTTP応答が返る）」と「実作業を任せられる（小修正を完遂できる）」は別物です。
  このスクリプトは実Wentian CLI（bin/wentian.js）を1回だけ起動し、CLI側の実装検証
  （`wentian agents verify`）を走らせて合否を終了コードと台帳（Manifest）へ残します。

判定の受け取り方（CLIの実装能力検証と同じ終了コード契約 / Task Outcome Contract）:
  0   ... 検証対象がすべて合格（実作業を任せられる記録が台帳へ残った）
  2   ... 未合格が残った（検収待ち。再試行予定・対応待ちを台帳で確認する）
  1   ... 検証実行そのものが失敗（残存プロセス確認失敗など、人へ引き渡す）
  124 ... 時間切れ（待機が長引いた。上流利用制限の再試行可能時刻を確認する）

安全上の約束:
  - 秘密情報（APIキー・トークン）は読み取りません。読み取るのは設定と検証台帳だけです。
  - 検証が書き込むのは一時作業領域（Workspace）と `.wentian/` 配下の台帳だけです。
  - 削除・設定変更・常駐サーバー再起動は行いません（実施する場合は人間の明示承認が必要）。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# リポジトリ直下（scripts/ の親）を基準パスにします。カレントディレクトリに依存しないためです。
REPO_ROOT = Path(__file__).resolve().parent.parent
CLI_ENTRY = REPO_ROOT / "bin" / "wentian.js"
# 検証結果の台帳（Manifest）置き場。接続台帳・能力台帳とは分けて、実行履歴だけを残します。
DEFAULT_REPORT_ROOT = REPO_ROOT / ".wentian" / "work-verification"
# 検証は最大6分/Agentの想定（CLI側）。複数Agentを待つため既定は40分にします。
DEFAULT_TIMEOUT_SECONDS = 2400


def utc_now() -> str:
    """台帳へ書くUTC時刻（ISO 8601）を返します。ローカル時刻のズレを記録に残さないためです。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def decode_line(raw: bytes) -> str:
    """子プロセス出力を1行ずつ安全にデコードします。

    Windows上のBun/Nodeはコンソールコードページ（CP932）で書き出すことがあるため、
    UTF-8として読めなければCP932へ縮退します。誤デコードで判定文を化かさないためです。
    """
    for encoding in ("utf-8", "cp932"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def run_verification(node: str, agents: list[str], cache_dir: str | None, status_only: bool) -> tuple[int, str]:
    """実CLIを起動し、標準出力・標準エラー出力をそのまま画面へ流しながら全文を返します。

    stdioを継承せずパイプにするのは、レポート本文を台帳へ残す必要があるためです。
    代わりに行単位で読み直して即時出力し、待ち時間の体感を損なわないようにします。
    """
    command = [node, str(CLI_ENTRY), "agents"]
    # 能力検証（verify）は実CLIを複数回起動してTokensを消費するため、状態報告だけみたい場合は明示的に分けます。
    if not status_only:
        command.append("verify")
        command.extend(agents or ["all"])
    if cache_dir:
        command.extend(["--cache-dir", cache_dir])
    # 作業者がそのままコピーして再実行できる完全なコマンドラインを必ず残します。
    print("[cmd] " + " ".join(f'"{part}"' if " " in part else part for part in command), flush=True)
    process = subprocess.Popen(
        command,
        cwd=str(REPO_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    lines: list[str] = []
    started = time.monotonic()
    try:
        for raw in process.stdout or []:
            line = decode_line(raw if isinstance(raw, bytes) else bytes(raw, "utf-8", errors="replace"))
            lines.append(line)
            print(line, end="", flush=True)
            if time.monotonic() - started > DEFAULT_TIMEOUT_SECONDS:
                process.kill()
                return 124, "".join(lines) + "\n検証時間が上限を越えたため停止しました。\n"
        process.wait()
    except BaseException:
        # 割り込み（Ctrl+C）では残る可能性のある子プロセスを必ず止めます。
        process.kill()
        raise
    return process.returncode if process.returncode is not None else 1, "".join(lines)


def verdict(exit_code: int) -> str:
    """終了コードを、人が誤読しない一文の判定へ変換します。"""
    if exit_code == 0:
        return "合格: 検証対象の実装能力検証がすべて台帳へ合格として記録されました。"
    if exit_code == 2:
        return "未合格: 実装能力検証が未合格のままです。接続確認済みでも実作業は任せられません。"
    if exit_code == 124:
        return "時間切れ: 検証が上限时间内に終わりませんでした。上流の利用制限（HTTP 429）の再試行可能時刻を確認してください。"
    return f"失敗: 検証実行そのものが失敗しました（終了コード {exit_code}）。"


def write_reports(report_root: Path, exit_code: int, output: str, command_agents: list[str], status_only: bool) -> tuple[Path, Path]:
    """実行台帳（JSON）と人間向け報告（Markdown）を書きます。"""
    report_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    manifest_path = report_root / f"{stamp}-work-verification.json"
    markdown_path = report_root / f"{stamp}-work-verification.md"
    manifest = {
        "version": 1,
        "observedAt": utc_now(),
        "repository": str(REPO_ROOT),
        "commandAgents": command_agents or ["all"],
        "mode": "status" if status_only else "verify",
        "exitCode": exit_code,
        "verdict": verdict(exit_code),
        # 検証資料の本体（証跡）はCLI側がもつ evidenceDirectory を信じるため、ここには要約だけ置きます。
        "outputTail": output[-4000:],
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(
        "# 実装能力検証 実行記録\n\n"
        f"- 観測時刻 (UTC): {manifest['observedAt']}\n"
        f"- 対象: {', '.join(manifest['commandAgents'])}\n"
        f"- 終了コード: {exit_code}\n"
        f"- 判定: {manifest['verdict']}\n\n"
        "## CLI出力（末尾）\n\n```\n" + manifest["outputTail"] + "\n```\n",
        encoding="utf-8",
    )
    return manifest_path, markdown_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Wentian外部エージェントの実装能力検証を実CLIで実行し、台帳へ残します。")
    parser.add_argument("--agent", action="append", default=[], dest="agents",
                        help="検証対象のAgent ID（複数指定可）。省略または all で管理対象すべて。")
    parser.add_argument("--cache-dir", default=None, help="Health Check Cache（生存確認キャッシュ）のディレクトリ。")
    parser.add_argument("--status-only", action="store_true",
                        help="検証は実行せず、保存済みの記録からの状態報告だけ確認します（Tokensを消費しません）。")
    parser.add_argument("--report-root", default=str(DEFAULT_REPORT_ROOT), help="実行台帳と報告の出力先。")
    parser.add_argument("--node", default="node", help="Node.js 実行ファイルパス。")
    args = parser.parse_args()

    if not CLI_ENTRY.exists():
        print(f"Wentian CLIが見つかりません: {CLI_ENTRY}", file=sys.stderr)
        return 1
    agents = [agent for agent in args.agents if agent]
    exit_code, output = run_verification(args.node, agents, args.cache_dir, args.status_only)
    manifest_path, markdown_path = write_reports(Path(args.report_root), exit_code, output, agents, args.status_only)
    print(verdict(exit_code), flush=True)
    print(f"実行台帳: {manifest_path}", flush=True)
    print(f"報告: {markdown_path}", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
