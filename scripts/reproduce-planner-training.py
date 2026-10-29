"""保存済みジョブを変更せず、新しいフォルダーへ同条件の学習を再現する。

アーカイブ内の学習ソース・固定データ・プロンプトを使う。重み取得は明示許可時だけ。
実行環境には元のrequirements.lock.txtを導入してから起動する。
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone


def verify_source(source):
    """保存台帳の全ファイルを検査し、変更されたデータや重みの再現実行を拒否する。"""
    manifest = json.loads((source / "model-manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        file = (source / entry["path"]).resolve()
        if not file.is_relative_to(source) or not file.is_file():
            raise ValueError(f"成果物が存在しないか、保存範囲外です: {entry['path']}")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if file.stat().st_size != entry["bytes"] or digest.hexdigest() != entry["sha256"]:
            raise ValueError(f"成果物のSHA256が一致しません: {entry['path']}")


def main():
    """固定された設定を読み込み、実コマンドと終了状態を新ジョブへ保存する。"""
    parser = argparse.ArgumentParser(description="分類モデルの実学習を保存済み条件で再現します。")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--allow-download", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve()
    verify_source(source)
    config = json.loads((source / "training-config.json").read_text(encoding="utf-8"))
    target = args.output.resolve() if args.output else source.parent / str(uuid.uuid4())
    target.mkdir(parents=True, exist_ok=False)
    job = {"id": target.name, "status": "running", "pid": os.getpid(), "createdAt": datetime.now(timezone.utc).isoformat(), "model": config["baseModel"], "revision": config["revision"], "steps": config["steps"], "seed": config["seed"], "device": config["device"], "reproducedFrom": source.name}
    (target / "job.json").write_text(json.dumps(job, indent=2), encoding="utf-8")
    for name in ["dataset.jsonl", "prompt.json"]:
        shutil.copy2(source / name, target / name)
    command = [sys.executable, str(source / "source" / "train-planner.py"), "train", "--directory", str(target), "--steps", str(config["steps"]), "--device", config["device"]]
    # 比較学習の設定も保存値から復元し、既定値へ戻って別の学習になることを防ぎます。
    command.extend(["--base-model",config["baseModel"],"--revision",config["revision"],
                    "--learning-rate",str(config.get("learningRate",0.0002)),
                    "--lora-rank",str(config.get("rank",8)),
                    "--evaluation-batch-size",str(config.get("evaluationBatchSize",1))])
    if config.get("targetModules")=="all-linear":command.append("--all-linear")
    if config.get("parentAdapterSha256"):
        # 親重みの保存がない旧成果物を、最初からの学習として誤って再現しません。
        parent=(source/config.get("parentAdapterPath","parent-adapter")).resolve()
        if not parent.is_relative_to(source) or hashlib.sha256((parent/"adapter_model.safetensors").read_bytes()).hexdigest()!=config["parentAdapterSha256"]:
            raise ValueError("補習開始時の親アダプターが一致しません。")
        command.extend(["--resume-adapter",str(parent)])
    if args.allow_download:
        command.append("--allow-download")
    (target / "reproduction-command.json").write_text(json.dumps({"argv": command, "source": str(source)}, ensure_ascii=False, indent=2), encoding="utf-8")
    environment = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    with (target / "stdout.log").open("w", encoding="utf-8") as out, (target / "stderr.log").open("w", encoding="utf-8") as err:
        result = subprocess.run(command, stdout=out, stderr=err, env=environment)
    if result.returncode:
        job.update(status="failed", error="再現学習に失敗しました。stderr.logを確認してください。")
        (target / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        raise RuntimeError(f"再現学習に失敗しました。ログを確認してください: {target}")
    report = json.loads((target / "report.json").read_text(encoding="utf-8"))
    job.update(status="succeeded" if report["passed"] else "rejected", report=report, finishedAt=datetime.now(timezone.utc).isoformat())
    (target / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    renderer = source / "source" / "render-planner-training-report.py"
    subprocess.run([sys.executable, str(renderer), "--directory", str(target)], check=True, env=environment)
    print(f"再現学習と評価を保存しました: {target}")


if __name__ == "__main__":
    main()
