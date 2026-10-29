"""実行中ジョブを監視し、終了後の評価確認・有効化・検収・図表保存を継続する。

元の学習プロセスは操作しない。不合格を合格へ変更しない。検収失敗時は有効化を解除する。
監視ログは成果物のSHA256を変えないようジョブフォルダーの外へ保存する。
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import time


def main():
    """既存ジョブの完了を待ち、既存サービスの有効化条件を使って成果を検収する。"""
    parser = argparse.ArgumentParser(description="実学習後の評価・検収・保存を自動継続します。")
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    directory = args.directory.resolve()
    repository = Path(__file__).resolve().parent.parent
    status_path = directory.parent.parent / (directory.name + "-finalization.json")

    def record(status, **details):
        """監視状態を別台帳へ保存し、終了・失敗を後から確認できるようにする。"""
        value = {"job": directory.name, "status": status, "updatedAt": datetime.now(timezone.utc).isoformat(), **details}
        status_path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

    record("waiting")
    # CPU学習の待機には期限を設け、終了したジョブの台帳だけを読み取る。
    deadline = time.monotonic() + 7 * 3600
    try:
        while time.monotonic() < deadline:
            job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
            if job["status"] != "running":
                break
            time.sleep(5)
        else:
            raise TimeoutError("学習完了待機の期限を超えました。元の学習は停止していません。")
        report_path = directory / "report.json"
        if not report_path.exists():
            raise RuntimeError(f"学習が評価結果を生成せず終了しました: {job['status']}")
        report = json.loads(report_path.read_text(encoding="utf-8"))
        record("verifying", accuracy=report["accuracy"], unsafeWrites=report["unsafeWrites"])
        if job["status"] == "succeeded" and report["passed"]:
            # 通常の計画検証も全評価出力へ適用する。分類だけを検収し、依頼の実作業は実行しない。
            program = """
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PlannerTrainingService,inferTrainedPlanner} from './src/planner-training.ts';
import {validateAgentPlan} from './src/agent-planner.ts';
const directory=process.argv[1];
const report=JSON.parse(await readFile(path.join(directory,'report.json'),'utf8'));
for(const row of report.results) validateAgentPlan(row.prediction,row.input);
const service=new PlannerTrainingService();
await service.activate(path.basename(directory));
try {
  const input='你好！';
  const raw=await inferTrainedPlanner('',input);
  if(!raw) throw new Error('学習済みモデルの実推論に失敗しました。');
  const plan=validateAgentPlan(JSON.parse(raw),input);
  if(plan.intent!=='chat'||plan.operation!=='answer') throw new Error('挨拶の実推論が不正です。');
  await writeFile(path.join(directory,'live-verification.json'),JSON.stringify({input,raw,plan,verifiedAt:new Date().toISOString()},null,2));
} catch(error) {await service.activate(null);throw error;}
"""
            result = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", program, str(directory)], cwd=repository, capture_output=True, text=True, encoding="utf-8", timeout=180)
            if result.returncode:
                (directory / "live-verification-error.txt").write_text(result.stderr, encoding="utf-8")
                raise RuntimeError("最終検収に失敗しました。実推論の記録を確認してください。")
        # 最終台帳が確定した後にSHA256とZIPを生成し、検収記録もまとめる。
        subprocess.run([sys.executable, str(repository / "scripts" / "render-planner-training-report.py"), "--directory", str(directory)], cwd=repository, check=True)
        record("completed" if report["passed"] else "rejected", accuracy=report["accuracy"], correct=report["correct"], evaluated=report["evaluated"], unsafeWrites=report["unsafeWrites"], activated=report["passed"], report=str(directory / "report.html"))
    except Exception as error:
        record("failed", error=str(error))
        # 検収失敗時も予測と失敗理由を図表・ZIPへ残し、原因調査できるようにする。
        if (directory / "report.json").exists():
            subprocess.run([sys.executable, str(repository / "scripts" / "render-planner-training-report.py"), "--directory", str(directory)], cwd=repository, check=False)
        raise


if __name__ == "__main__":
    main()
