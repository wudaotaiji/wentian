"""ローカル推論（Local Inference）の冷起動・温起動と文脈長別メモリを実測します。

インストール済みの明示モデルだけを使い、ダウンロードやクラウド呼び出しをしません。
初期状態でロードされていなかったモデルだけを終了時にアンロードします。
GPUを要求しても実行エンジンがCPUへ移す場合があるため、実配置はsize_vramで記録します。
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def request(base: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    with urlopen(Request(base + path, data=data, headers={"Content-Type": "application/json"}), timeout=120) as response:
        return json.load(response)


def hardware():
    # Windowsの観測だけを実行し、設定やプロセスの状態は変更しません。
    command = "$o=Get-CimInstance Win32_OperatingSystem; $g=Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM; @{ramTotalBytes=$o.TotalVisibleMemorySize*1024;ramFreeBytes=$o.FreePhysicalMemory*1024;gpus=@($g)} | ConvertTo-Json -Depth 4 -Compress"
    result = subprocess.run(["pwsh", "-NoProfile", "-Command", command], capture_output=True, encoding="utf-8", check=True)
    return json.loads(result.stdout)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="ローカル性能の実測（Local Benchmark）")
    parser.add_argument("--base-url", default="http://127.0.0.1:11434")
    parser.add_argument("--model", default="qwen2.5:7b")
    parser.add_argument("--output", default="docs/evidence/20261006_control_plane/local-benchmark.json")
    parser.add_argument("--gpu", action="store_true")
    args = parser.parse_args()
    if urlparse(args.base_url).hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("実測の接続先はローカル（Local）に限定します。")
    base = args.base_url.rstrip("/")
    installed = request(base, "/api/tags").get("models", [])
    model = next((row for row in installed if row.get("name") == args.model), None)
    if not model or model.get("remote_model") or model.get("remote_host"):
        raise ValueError("指定モデルが未インストール、またはクラウド（Cloud）モデルです。")
    before = request(base, "/api/ps")
    owned = not any(row.get("name") == args.model for row in before.get("models", []))
    report = {"model": args.model, "gpuRequested": args.gpu, "hardware": hardware(), "initialRunning": before, "samples": []}
    started = time.monotonic()
    try:
        # 文脈長（Context Length）を変えた3条件と同条件の温起動を比較します。
        for index, context in enumerate((2048, 2048, 4096)):
            print(f"実測（Benchmark） {index + 1}/3：文脈長={context}", flush=True)
            payload = {"model": args.model, "prompt": "Reply with OK only.", "stream": True, "keep_alive": "2m",
                       "options": {"num_ctx": context, "num_predict": 16, "temperature": 0, "num_gpu": 99 if args.gpu else 0}}
            sample_start = time.monotonic()
            first = None
            text = ""
            final = None
            with urlopen(Request(base + "/api/generate", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json"}), timeout=120) as response:
                for line in response:
                    row = json.loads(line)
                    if row.get("error"):
                        raise RuntimeError(row["error"])
                    if row.get("response") or row.get("thinking"):
                        if first is None:
                            first = (time.monotonic() - sample_start) * 1000
                        text += row.get("response", "")
                    if row.get("done"):
                        final = row
            if not final:
                raise RuntimeError("終了イベント（Done Event）を取得できません。")
            resident = next((row for row in request(base, "/api/ps").get("models", []) if row.get("name") == args.model), {})
            duration = final.get("eval_duration", 0)
            report["samples"].append({"context": context, "cold": index == 0 and owned, "latencyMs": (time.monotonic() - sample_start) * 1000,
                "ttftMs": first, "promptTokens": final.get("prompt_eval_count"), "outputTokens": final.get("eval_count"),
                "tokensPerSecond": final.get("eval_count", 0) / (duration / 1e9) if duration else None,
                "loadMs": final.get("load_duration", 0) / 1e6, "residentBytes": resident.get("size"), "residentVramBytes": resident.get("size_vram"),
                "runtimeContext": resident.get("context_length"), "accepted": text.strip() == "OK", "hardwareAfter": hardware()})
    finally:
        # 他アプリが事前にロードしたモデルは保持し、本実測でロードしたモデルだけを片付けます。
        if owned:
            request(base, "/api/generate", {"model": args.model, "prompt": "", "stream": False, "keep_alive": 0})
        report["finalRunning"] = request(base, "/api/ps")
        report["elapsedSeconds"] = time.monotonic() - started
        target = Path(args.output).resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"実測レポート（Benchmark Report）：{target}", flush=True)


if __name__ == "__main__":
    main()
