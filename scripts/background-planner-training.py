"""Windowsタスクから既存学習を監視し、会話終了後も完了処理を維持する。

既存プロセスが生きている間は二重学習しない。会話終了に伴い停止した場合は、
元ジョブと途中ログを保持したまま、新ジョブで同じ条件の学習をやり直す。
"""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
TRAINING = ROOT / ".wentian" / "planner-training"
ORIGINAL = "b8bcaf2b-db5b-480a-8649-2ea456c6dfe4"


def alive(pid):
    """Windowsのプロセスハンドルで生存を確認し、PIDの信号送信はしない。"""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    handle = kernel.OpenProcess(0x1000, False, int(pid))
    if not handle:
        return False
    code = ctypes.c_ulong()
    try:
        return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
    finally:
        kernel.CloseHandle(handle)


def main():
    """監視状態をディスクへ残し、既存学習終了後に検収スクリプトを起動する。"""
    os.chdir(ROOT)
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"
    state_file = TRAINING / "background-status.json"
    directory = TRAINING / "runs" / ORIGINAL

    def state(status, **extra):
        state_file.write_text(json.dumps({"status": status, "pid": os.getpid(), "job": directory.name, "updatedAt": time.time(), **extra}, ensure_ascii=False, indent=2), encoding="utf-8")

    state("monitoring")
    try:
        while True:
            job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
            if job["status"] != "running":
                break
            if not alive(job["pid"]):
                # 親プロセス終了後に子だけ残った場合も、重複計算を起こさないよう確認する。
                # 初回確認した実学習PIDは同一実行のもの。存在する間は終了を待つ。
                if alive(12092) or alive(20836):
                    time.sleep(5)
                    continue
                # 学習本体が評価まで完了していれば、親の終了だけを理由に再学習しない。
                if (directory / "report.json").exists():
                    report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
                    job.update(status="succeeded" if report["passed"] else "rejected", report=report)
                    (directory / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
                    break
                state("restarting", reason="会話側の実行プロセスが終了。元の記録は保持。")
                program = """
import {PlannerTrainingService} from './src/planner-training.ts';
const service=new PlannerTrainingService();
const job=await service.start({steps:624,device:'cpu',allowDownload:false});
console.log(job.id);
while((await service.status()).running) await new Promise(resolve=>setTimeout(resolve,1000));
"""
                with (TRAINING / "background-training.stdout.log").open("w", encoding="utf-8") as out, (TRAINING / "background-training.stderr.log").open("w", encoding="utf-8") as err:
                    result = subprocess.run(["C:\\Program Files\\nodejs\\node.exe", "--import", "tsx", "--input-type=module", "-e", program], cwd=ROOT, stdout=out, stderr=err)
                if result.returncode:
                    raise RuntimeError("バックグラウンド学習の再実行に失敗しました。ログを確認してください。")
                identifier = (TRAINING / "background-training.stdout.log").read_text(encoding="utf-8").splitlines()[0].strip()
                directory = TRAINING / "runs" / identifier
                break
            time.sleep(5)
        # 初回不合格時だけ、同じ固定データで学習回数を増やした第二実験を行う。
        # 評価例や合格閾値は変更しない。再試行は一回で打ち切り、無期限に計算しない。
        job = json.loads((directory / "job.json").read_text(encoding="utf-8"))
        if directory.name == ORIGINAL and job["status"] == "rejected":
            state("retrying", steps=2000, reason="初回不合格。固定評価と閾値を維持して学習回数を増加。")
            program = """
import {PlannerTrainingService} from './src/planner-training.ts';
const service=new PlannerTrainingService();
const job=await service.start({steps:2000,device:'cpu',allowDownload:false});
console.log(job.id);
while((await service.status()).running) await new Promise(resolve=>setTimeout(resolve,1000));
"""
            with (TRAINING / "background-retry.stdout.log").open("w", encoding="utf-8") as out, (TRAINING / "background-retry.stderr.log").open("w", encoding="utf-8") as err:
                process = subprocess.Popen(["C:\\Program Files\\nodejs\\node.exe", "--import", "tsx", "--input-type=module", "-e", program], cwd=ROOT, stdout=out, stderr=err)
                # 起動したジョブIDを監視台帳にも反映する。標準出力はNode側で即時出力される。
                while process.poll() is None:
                    content = (TRAINING / "background-retry.stdout.log").read_text(encoding="utf-8").strip()
                    if content:
                        directory = TRAINING / "runs" / content.splitlines()[0]
                        state("training", steps=2000)
                        break
                    time.sleep(1)
                if process.wait() != 0:
                    raise RuntimeError("第二実験の学習に失敗しました。バックグラウンドログを確認してください。")
        state("finalizing")
        training_python = ROOT / ".wentian" / "planner-engine" / "Scripts" / "python.exe"
        with (TRAINING / "background-finalization.log").open("w", encoding="utf-8") as log:
            subprocess.run([str(training_python), str(ROOT / "scripts" / "finish-planner-training.py"), "--directory", str(directory)], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
        state("finished", finalization=str(TRAINING / (directory.name + "-finalization.json")))
    except Exception as error:
        state("failed", error=str(error))
        raise


if __name__ == "__main__":
    main()
