"""Wentian用MiniMax H3ワーカー（ComfyUI API経由）。

既存のComfyUI共有モデルを使い、文章から動画とネイティブ音声を生成します。
HTTP APIはループバックだけを使用し、利用者から受け取ったURLやコマンドを実行しません。
必要な場合は既知のComfyUIインストールを低VRAM設定で起動し、モデルファイルは読み取り専用で参照します。
標準出力にはWentianが解釈する進捗JSONだけを出します。詳細ログはジョブ用ディレクトリへ保存します。
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def emit(event):
    """Wentianの既存ジョブ管理画面向けに日本語の構造化イベントを通知します。"""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def settings():
    """管理者が設定したパスだけを使い、モデルの保存場所を固定します。"""
    shared = Path(os.environ.get(
        "WENTIAN_COMFYUI_MODEL_ROOT",
        str(Path(__file__).resolve().parents[1] / ".wentian" / "comfyui" / "models"),
    )).resolve()
    comfy = Path(os.environ.get("WENTIAN_COMFYUI_ROOT", str(Path(__file__).resolve().parents[1] / ".wentian" / "comfyui"))).resolve()
    python = Path(os.environ.get(
        "WENTIAN_COMFYUI_PYTHON", str(comfy / ".venv" / "Scripts" / "python.exe")
    )).resolve()
    job_root = Path(os.environ.get("WENTIAN_VIDEO_ROOT", str(Path(__file__).resolve().parent.parent / ".wentian" / "videos"))).resolve()
    base_url = os.environ.get("COMFYUI_BASE_URL", "http://127.0.0.1:8190").rstrip("/")
    return shared, comfy, python, job_root, base_url


def request_json(url, payload=None, timeout=15):
    """ローカルComfyUIとのJSON通信を行い、HTTP失敗を安全な例外に変換します。"""
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise RuntimeError("ComfyUI APIへ接続できません。") from error


def h3_files(shared):
    """H3本体・テキストエンコーダー・動画／音声VAEの既存ファイルを検査します。"""
    return [
        shared / "diffusion_models" / "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        shared / "text_encoders" / "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
        shared / "vae" / "minimax_h3_video_vae_fp16.safetensors",
        shared / "vae" / "minimax_h3_audio_vae_fp32.safetensors",
    ]


def write_model_config(shared, job_root):
    """ComfyUIが共有モデルを認識する最小設定を、専用データ領域へ原子的に保存します。"""
    config = job_root / "comfyui-model-paths.yaml"
    shared_text = shared.as_posix().replace("'", "''")
    content = (
        "minimax_h3_shared:\n"
        f"  base_path: '{shared_text}'\n"
        "  diffusion_models: diffusion_models\n"
        "  text_encoders: text_encoders\n"
        "  vae: vae\n"
        "  audio_encoders: audio_encoders\n"
    )
    temporary = config.with_suffix(".yaml.partial")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, config)
    return config


def start_comfyui(shared, comfy, python, job_root, base_url):
    """APIが未起動の場合だけ、既知のComfyUIを省VRAMフラグ付きで起動します。"""
    try:
        request_json(base_url + "/system_stats", timeout=3)
        return
    except RuntimeError:
        pass
    main = comfy / "main.py"
    if not main.is_file() or not python.is_file():
        raise RuntimeError("ComfyUI本体またはPython環境が見つかりません。")
    for file in h3_files(shared):
        if not file.is_file():
            raise RuntimeError("MiniMax H3の既存モデル一式が見つかりません。")
    job_root.mkdir(parents=True, exist_ok=True)
    model_config = write_model_config(shared, job_root)
    output = job_root / "comfyui-output"
    output.mkdir(parents=True, exist_ok=True)
    log = (job_root / "comfyui-server.log").open("a", encoding="utf-8")
    command = [
        str(python), str(main), "--listen", "127.0.0.1", "--port", str(urllib.parse.urlsplit(base_url).port or 8190),
        "--lowvram", "--disable-auto-launch", "--disable-async-offload", "--disable-pinned-memory",
        "--output-directory", str(output), "--extra-model-paths-config", str(model_config),
    ]
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(command, cwd=str(comfy), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                     creationflags=flags, close_fds=True)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        time.sleep(2)
        try:
            request_json(base_url + "/system_stats", timeout=3)
            return
        except RuntimeError:
            continue
    raise RuntimeError("ComfyUIの起動が3分以内に完了しませんでした。")


def diagnose():
    """共有モデルとComfyUI APIを確認し、初回だけ既知のComfyUIを起動します。"""
    shared, comfy, python, job_root, base_url = settings()
    missing = [file.name for file in h3_files(shared) if not file.is_file()]
    if missing:
        return {"ready": False, "model": "MiniMax H3", "message": "共有モデルが不足しています: " + ", ".join(missing)}
    try:
        start_comfyui(shared, comfy, python, job_root, base_url)
        stats = request_json(base_url + "/system_stats")
        devices = stats.get("devices") or []
        name = devices[0].get("name", "CUDA") if devices else "CUDA"
        return {"ready": True, "model": "MiniMax H3", "device": "ComfyUI / " + str(name),
                "cuda": True, "dependencies": True,
                "message": "既存のMiniMax H3 INT8モデルをComfyUIで使用します。映画的な文章動画・音声生成に対応します。"}
    except RuntimeError as error:
        return {"ready": False, "model": "MiniMax H3", "message": str(error)}


def workflow(prompt, width, height, frames, steps, seed):
    """今回実機で完走したH3ノード構成を、ComfyUI APIワークフローへ変換します。"""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"weight_dtype": "default", "unet_name": "minimax_h3_fl2va_pruned_int8_convrot.safetensors"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"device": "default", "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "5": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"vae": ["3", 0], "prompt": prompt, "length": frames, "height": height, "clip": ["2", 0], "width": width}},
        "6": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "7": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "8": {"class_type": "BasicScheduler", "inputs": {"steps": steps, "denoise": 1.0, "scheduler": "simple", "model": ["1", 0]}},
        "9": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["5", 0]}},
        "10": {"class_type": "SamplerCustomAdvanced", "inputs": {"latent_image": ["5", 1], "sigmas": ["8", 0], "sampler": ["7", 0], "noise": ["6", 0], "guider": ["9", 0]}},
        "11": {"class_type": "VAEDecode", "inputs": {"samples": ["10", 1], "vae": ["3", 0]}},
        "12": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["10", 1], "vae": ["4", 0]}},
        "13": {"class_type": "CreateVideo", "inputs": {"images": ["11", 0], "audio": ["12", 0], "fps": 24.0}},
        "14": {"class_type": "SaveVideo", "inputs": {"video": ["13", 0], "filename_prefix": "video/Wentian_H3_" + uuid.uuid4().hex, "codec": "auto", "format": "auto"}},
    }


def generate(directory):
    """動画要求をComfyUIへ投入し、完成したMP4だけをWentianのジョブ領域へ保存します。"""
    directory = Path(directory).resolve(strict=True)
    request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
    if (directory / "input.image").exists():
        raise RuntimeError("MiniMax H3では起点画像入力を使えません。文章からの動画を指定してください。")
    prompt = request["prompt"].strip()
    negative = request.get("negativePrompt", "").strip()
    if negative:
        prompt += " Avoid these visual defects: " + negative + "."
    shared, comfy, python, job_root, base_url = settings()
    start_comfyui(shared, comfy, python, job_root, base_url)
    emit({"type": "progress", "percent": 3, "stage": "MiniMax H3モデルを準備中"})
    queued = request_json(base_url + "/prompt", {"prompt": workflow(prompt, request["width"], request["height"], request["frames"], request["steps"], request["seed"]), "client_id": "wentian-h3"})
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
        raise RuntimeError("ComfyUIが動画生成要求を受け付けませんでした。")
    emit({"type": "progress", "percent": 5, "stage": "MiniMax H3で映画的な映像と音声を生成中"})
    deadline = time.monotonic() + 55 * 60
    generation_started = time.monotonic()
    # H3のVAEデコードはComfyUIのHTTP APIから進捗率が返らないため、実機検証値から控えめに推定します。
    # 初期化約4分、推論は1ステップ約10秒、映像デコードは5秒動画で約6分を基準にします。
    estimated_seconds = 240 + request["steps"] * 10 + (request["frames"] / 124) * 360
    last_percent = 5
    while time.monotonic() < deadline:
        time.sleep(3)
        try:
            history = request_json(base_url + "/history/" + urllib.parse.quote(prompt_id, safe=""), timeout=10).get(prompt_id)
        except RuntimeError:
            history = None
        if history:
            status = history.get("status", {})
            if status.get("completed"):
                outputs = history.get("outputs", {}).get("14", {}).get("images", [])
                if not outputs:
                    raise RuntimeError("ComfyUIは完了しましたが、MP4出力を確認できません。")
                item = outputs[0]
                if item.get("subfolder") != "video" or not str(item.get("filename", "")).endswith(".mp4"):
                    raise RuntimeError("ComfyUIの動画出力情報が不正です。")
                query = urllib.parse.urlencode({"filename": item["filename"], "subfolder": "video", "type": "output"})
                with urllib.request.urlopen(base_url + "/view?" + query, timeout=120) as response:
                    content = response.read(2 * 1024**3 + 1)
                if len(content) < 24 or len(content) > 2 * 1024**3 or content[4:8] != b"ftyp":
                    raise RuntimeError("生成されたファイルは有効なMP4ではありません。")
                temporary = directory / "output.partial.mp4"
                temporary.write_bytes(content)
                os.replace(temporary, directory / "output.mp4")
                if (directory / "soundtrack.audio").exists():
                    completed = subprocess.run([sys.executable, str(Path(__file__).with_name("media-worker.py")), "--attach-video", str(directory)], capture_output=True, timeout=600)
                    if completed.returncode:
                        raise RuntimeError("選択した音声を動画へ合成できませんでした。")
                emit({"type": "progress", "percent": 99, "stage": "MP4の保存を確認中"})
                return
            if status.get("status_str") in ("error", "failed"):
                raise RuntimeError("ComfyUIのMiniMax H3処理が失敗しました。サーバーログを確認してください。")
        elapsed = time.monotonic() - generation_started
        percent = min(88, 8 + int(80 * elapsed / estimated_seconds))
        if percent > last_percent:
            last_percent = percent
            emit({"type": "progress", "percent": percent, "stage": "MiniMax H3で映像・音声を生成中"})
    raise RuntimeError("生成が55分を超えました。解像度・長さを下げて再試行してください。")


def main():
    """Wentianからの診断／ジョブ要求を処理し、例外の詳細をログ外へ漏らしません。"""
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--diagnose", action="store_true")
    group.add_argument("--job", type=Path)
    args = parser.parse_args()
    try:
        if args.diagnose:
            emit(diagnose())
        else:
            generate(args.job)
    except Exception as error:
        message = str(error) if isinstance(error, RuntimeError) else "MiniMax H3動画の生成に失敗しました。ComfyUIログと設定を確認してください。"
        emit({"type": "error", "message": message[:500]})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
