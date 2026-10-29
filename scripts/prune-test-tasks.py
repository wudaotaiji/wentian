#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""工作台（Workbench）のタスク一覧に残った「試験残骸 Goal」の退避ランナー（Quarantine Runner）。

背景（なぜ必要か）:
  工作台の「タスク N件」は `.wentian/goals/*.json`（1タスク1ファイル / 1タスク1ファイル）を
  そのまま数えた値です。src/git-checkpoint.test.ts と src/memory-layer.test.ts が
  WENTIAN_GOAL_PATH を設定せずに createGoal() を呼んでいたため、試験のたびに
  実台帳へ空タスクを 7件（`g` ×6 + `phase2-test` ×1）書き込んでいました。
  goal-store.ts に削除APIは無く（できるのは requestGoalPause だけ）、
  整理するにはファイルシステム操作が必要です。削除は復元できないため、
  このスクリプトは **削除せず退避（Quarantine）する**設計です。

安全上の約束（IMPORTANT）:
  - 既定はドライラン（--apply を付けない限り1ファイルも動かしません）。
  - 退避対象は指紋（Fingerprint）で絞ります。条件を1つでも満たさないファイルは
    「保留（kept）」として残し、理由を報告します。実タスクを巻き込みません。
      1. title が既定の試験タイトル（g / phase2-test）の完全一致
      2. metrics.totalAttempts == 0（実行試行が一度もない）
      3. running == false（実行中フラグが立っていない）
      4. todos がすべて pending（検証待ち・完了・失敗が残っていない）
      5. 検証証拠（verification / artifact）を持っていない
      6. 中断要求マーカー（<id>.json.pause）が無い＝実行側が触っていない
  - 削除ではなく同一ボリューム内移動（shutil.move）なので、--restore で戻せます。
  - 秘密情報（APIキー・トークン）は一切読み取りません。読むのは Goal JSON とメタデータだけです。
  - 全対象の ID・タイトル・作成時刻・移動前後パスを実行台帳（Manifest）へ残します。

終了コード（Task Outcome Contract / 終了コード契約）:
  0   ... 正常完了（退避した、またはドライランで対象を特定した）
  2   ... 退避対象がありませんでした（失敗ではありません。 Already clean の意味）
  1   ... 実行そのものが失敗（台帳が壊れている、退避先へ動かせない 等）
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# リポジトリ直下（scripts/ の親）を基準にします。カレントディレクトリに依存しないためです。
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GOALS_ROOT = REPO_ROOT / ".wentian" / "goals"
DEFAULT_QUARANTINE_ROOT = REPO_ROOT / ".wentian" / "goals-quarantine"
# 試験が残したタイトル（`createGoalId()` がタイトルから slug を作るため、この2種類に収まります）。
DEFAULT_TEST_TITLES = ("g", "phase2-test")


def utc_now() -> str:
    """台帳へ書くUTC時刻（ISO 8601）。ローカル時刻のズレを記録に残さないためです。"""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def classify(path: Path, test_titles: tuple[str, ...]) -> tuple[bool, str]:
    """1ファイルを見て退避対象かを判定します。(対象か, 理由) を返します。

    判定は「消して良い根拠が揃ったときだけ true」です。読めない・条件が欠ける場合は
    保留にし、人が後で確認できる状態を残します。
    """
    try:
        goal = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:  # 壊れたJSONを勝手に捨てないため、必ず保留にします。
        return False, f"JSONを読み取れないため保留: {error}"
    if not isinstance(goal, dict):
        return False, "JSONの最上位がオブジェクトではないため保留"
    title = goal.get("title")
    if not isinstance(title, str) or title not in test_titles:
        return False, f"タイトルが試験残骸の指紋と違うため保留: {title!r}"
    if goal.get("running"):
        return False, "running=true（実行中）のため保留"
    metrics = goal.get("metrics") or {}
    attempts = metrics.get("totalAttempts") if isinstance(metrics, dict) else None
    if attempts not in (0, None):
        return False, f"実行試行が{attempts}回残っているため保留"
    todos = goal.get("todos") or []
    if not isinstance(todos, list):
        return False, "todosの形式が不正のため保留"
    statuses = {todo.get("status") for todo in todos if isinstance(todo, dict)}
    if statuses - {"pending"}:
        return False, f"実行済み・検証待ちのTODOがあるため保留: {sorted(map(str, statuses))}"
    # 成果物の検収証拠（Verification）を持っているタスクは、仕事の一部だった可能性があります。
    if any(isinstance(todo, dict) and todo.get("verification") for todo in todos):
        return False, "検証証拠（Verification）が残っているため保留"
    if goal.get("acceptance"):
        return False, "受入条件（Acceptance）が指定されているため保留"
    if path.with_suffix(path.suffix + ".pause").exists():
        return False, "中断要求マーカーがあり、実行側が触っている可能性があるため保留"
    return True, "試験残骸の指紋をすべて満たす"


def scan(goals_root: Path, test_titles: tuple[str, ...]) -> tuple[list[dict], list[dict]]:
    """台帳一覧を「退避対象」と「保留」へ分け、理由付きで返します。"""
    targets: list[dict] = []
    kept: list[dict] = []
    for path in sorted(goals_root.glob("*.json")):
        try:
            stat = path.stat()
        except OSError as error:
            kept.append({"id": path.stem, "file": str(path), "reason": f"stat失敗のため保留: {error}"})
            continue
        eligible, reason = classify(path, test_titles)
        record = {
            "id": path.stem,
            "file": str(path),
            "bytes": stat.st_size,
            "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds"),
            "reason": reason,
        }
        try:
            goal = json.loads(path.read_text(encoding="utf-8"))
            record["title"] = goal.get("title")
            record["createdAt"] = goal.get("createdAt")
            record["status"] = goal.get("status")
            record["todos"] = len(goal.get("todos") or [])
            record["totalAttempts"] = (goal.get("metrics") or {}).get("totalAttempts")
        except Exception:
            pass  # classify側で理由を出しているので、ここでは詳細を詰めません。
        (targets if eligible else kept).append(record)
    return targets, kept


def write_reports(report_root: Path, stamp: str, mode: str, goals_root: Path, quarantine_dir: Path,
                  targets: list[dict], kept: list[dict], moved: list[dict], errors: list[str]) -> tuple[Path, Path]:
    """実行台帳（JSON）と人間向け報告（Markdown）を書きます。作業者が同じ判断をやり直せるようにするためです。"""
    report_root.mkdir(parents=True, exist_ok=True)
    manifest_path = report_root / f"{stamp}-task-quarantine.json"
    markdown_path = report_root / f"{stamp}-task-quarantine.md"
    manifest = {
        "version": 1,
        "observedAt": utc_now(),
        "mode": mode,
        "repository": str(REPO_ROOT),
        "goalsRoot": str(goals_root),
        "quarantineDir": str(quarantine_dir),
        "movedCount": len(moved),
        "targetCount": len(targets),
        "keptCount": len(kept),
        "movedBytes": sum(item.get("bytes", 0) for item in moved),
        "errors": errors,
        "moved": moved,
        "kept": kept,
        # 復元手順を台帳へ必ず残します。記憶に頼らなくて済むようにするためです。
        "restoreCommand": f'python scripts/prune-test-tasks.py --restore "{quarantine_dir}"' if moved else "",
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# 工作台タスク 試験残骸の退避 実行記録",
        "",
        f"- 観測時刻 (UTC): {manifest['observedAt']}",
        f"- モード: {mode}",
        f"- 台帳: `{goals_root}`",
        f"- 退避先: `{quarantine_dir}`",
        f"- 退避した件数: {len(moved)} / 対象と判定: {len(targets)} / 保留: {len(kept)}",
        f"- 退避した容量: {manifest['movedBytes']} bytes",
        "",
        "## 退避したタスク（先頭40件）",
        "",
    ]
    for item in moved[:40]:
        lines.append(f"- `{item['id']}` · title={item.get('title')!r} · createdAt={item.get('createdAt')} · attempts={item.get('totalAttempts')}")
    if len(moved) > 40:
        lines.append(f"- …他 {len(moved) - 40} 件（全件はJSON台帳に記録）")
    lines += ["", "## 保留したタスク（先頭40件）", ""]
    for item in kept[:40]:
        lines.append(f"- `{item['id']}` · {item['reason']}")
    if len(kept) > 40:
        lines.append(f"- …他 {len(kept) - 40} 件（全件はJSON台帳に記録）")
    lines += [
        "",
        "## 復元方法",
        "",
        "```powershell",
        manifest["restoreCommand"] or "（退避していないため不要）",
        "```",
        "",
    ]
    if errors:
        lines += ["## エラー", ""] + [f"- {error}" for error in errors]
    markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return manifest_path, markdown_path


def run(args: argparse.Namespace) -> int:
    goals_root = Path(args.goals_root).resolve()
    test_titles = tuple(args.title) or DEFAULT_TEST_TITLES

    # ---- 復元モード: 退避ディレクトリの中身を実台帳へ戻します（上書きはしません） ----
    if args.restore:
        source = Path(args.restore).resolve()
        if not source.is_dir():
            print(f"復元元ディレクトリが見つかりません: {source}", file=sys.stderr)
            return 1
        restored, skipped, errors = [], [], []
        for path in sorted(source.glob("*.json")):
            if "task-quarantine" in path.name:  # 台帳自身は戻しません。
                continue
            target = goals_root / path.name
            if target.exists():
                skipped.append({"id": path.stem, "reason": "実台帳に同名が既にあるため復元しません"})
                continue
            try:
                goals_root.mkdir(parents=True, exist_ok=True)
                shutil.move(str(path), str(target))
                restored.append({"id": path.stem, "file": str(target)})
            except Exception as error:
                errors.append(f"{path.name}: {error}")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        manifest_path, _ = write_reports(Path(args.report_root).resolve(), stamp, "restore", goals_root, source,
                                         [], skipped, restored, errors)
        print(f"復元: {len(restored)}件 / 既存のためスキップ: {len(skipped)}件 / 失敗: {len(errors)}件")
        print(f"残存退避ファイル: {len([p for p in source.glob('*.json') if 'task-quarantine' not in p.name])}件")
        print(f"実行台帳: {manifest_path}")
        return 1 if errors else 0

    # ---- 通常モード（スキャン → 判定 → 退避） ----
    if not goals_root.is_dir():
        print(f"タスク台帳ディレクトリが見つかりません: {goals_root}", file=sys.stderr)
        return 1
    targets, kept = scan(goals_root, test_titles)
    total = len(list(goals_root.glob("*.json")))
    mode = "apply" if args.apply else "dry-run"
    print(f"台帳: {goals_root}")
    print(f"総タスク数: {total}件 / 退避対象と判定: {len(targets)}件 / 保留: {len(kept)}件 / 指紋タイトル: {', '.join(test_titles)}")
    if not targets:
        print("退避対象がありませんでした（Already clean）。台帳には保留理由を記録します。")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        quarantine_dir = Path(args.quarantine_root).resolve() / stamp
        manifest_path, markdown_path = write_reports(Path(args.report_root).resolve(), stamp, mode, goals_root,
                                                     quarantine_dir, targets, kept, [], [])
        print(f"実行台帳: {manifest_path}")
        print(f"報告: {markdown_path}")
        return 2
    if not args.apply:
        print("ドライランです（1ファイルも動かしていません）。実行するには --apply を付けてください。")
        for item in targets[:5]:
            print(f"  例: {item['id']} · title={item.get('title')!r} · createdAt={item.get('createdAt')} · attempts={item.get('totalAttempts')}")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        quarantine_dir = Path(args.quarantine_root).resolve() / stamp
        manifest_path, markdown_path = write_reports(Path(args.report_root).resolve(), stamp, mode, goals_root,
                                                     quarantine_dir, targets, kept, [], [])
        print(f"実行台帳: {manifest_path}")
        print(f"報告: {markdown_path}")
        return 0

    # 退避先は実行時刻のディレクトリにし、同じ実行を繰り返しても混ざらないようにします。
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    quarantine_dir = Path(args.quarantine_root).resolve() / stamp
    quarantine_dir.mkdir(parents=True, exist_ok=True)
    moved: list[dict] = []
    errors: list[str] = []
    for item in targets:
        source_path = Path(item["file"])
        destination = quarantine_dir / source_path.name
        try:
            # 中断要求マーカーも一緒に退避します。置き去りにすると復元後に誤作動する可能性があるためです。
            shutil.move(str(source_path), str(destination))
            marker = source_path.with_suffix(source_path.suffix + ".pause")
            if marker.exists():
                shutil.move(str(marker), str(quarantine_dir / marker.name))
            moved.append({**item, "quarantinedTo": str(destination)})
        except Exception as error:
            errors.append(f"{source_path.name}: {error}")
            print(f"  退避に失敗: {source_path.name}: {error}", file=sys.stderr)
    remaining = len(list(goals_root.glob("*.json")))
    manifest_path, markdown_path = write_reports(Path(args.report_root).resolve(), stamp, mode, goals_root,
                                                 quarantine_dir, targets, kept, moved, errors)
    print(f"退避完了: {len(moved)}件 / 失敗: {len(errors)}件 / 退避後の残タスク: {remaining}件")
    print(f"退避先（復元可能）: {quarantine_dir}")
    print(f"実行台帳: {manifest_path}")
    print(f"報告: {markdown_path}")
    if errors:
        return 1
    print(f"復元する場合: python scripts/prune-test-tasks.py --restore \"{quarantine_dir}\"")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="工作台タスク（Goal台帳）に残った試験残骸を、削除ではなく退避で整理します。")
    parser.add_argument("--goals-root", default=str(DEFAULT_GOALS_ROOT), help="Goal台帳ディレクトリ（既定: .wentian/goals）。")
    parser.add_argument("--quarantine-root", default=str(DEFAULT_QUARANTINE_ROOT), help="退避先の親ディレクトリ（既定: .wentian/goals-quarantine）。")
    parser.add_argument("--report-root", default=str(DEFAULT_QUARANTINE_ROOT), help="実行台帳と報告の出力先。")
    parser.add_argument("--title", action="append", default=[], dest="titles",
                        help="退避対象のタイトル（複数指定可）。省略時は g と phase2-test。")
    parser.add_argument("--apply", action="store_true", help="実際に退避を実行します（既定はドライラン）。")
    parser.add_argument("--restore", default=None, metavar="DIR", help="指定した退避ディレクトリから実台帳へ戻します。")
    args = parser.parse_args()
    args.title = [title for title in args.titles if title]
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
