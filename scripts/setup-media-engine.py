"""音声制作環境（Media Engine）を動画用の専用Pythonへ追加します。

モデルは--download指定時だけ取得します。動画の本番モデルは取得しません。
既存OSのPython環境を変更せず、モデルのコミット番号と取得容量を記録します。
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import shutil
import hashlib
import urllib.request
import zipfile

MODELS = {"music": "facebook/musicgen-small", "sound": "cvssp/audioldm-s-full-v2", "transcribe": "openai/whisper-tiny"}


def prepare_ffmpeg(directory):
    """Windowsの専用フォルダーへFFmpegを配置し、公開SHA256で取得物を検証します。"""
    if os.name != "nt":
        return
    tools = directory / "ffmpeg"
    if (tools / "ffmpeg.exe").exists() and (tools / "ffprobe.exe").exists():
        return
    tools.mkdir(parents=True, exist_ok=True)
    url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    archive = tools / "download.zip"
    print("Wentian専用のFFmpegを取得しています。", flush=True)
    urllib.request.urlretrieve(url, archive)
    expected = next(line.split()[0] for line in urllib.request.urlopen(url.rsplit("/", 1)[0] + "/checksums.sha256", timeout=30).read().decode().splitlines() if line.split()[-1] == "ffmpeg-master-latest-win64-gpl.zip")
    with archive.open("rb") as handle:
        actual = hashlib.file_digest(handle, "sha256").hexdigest()
    if actual.lower() != expected.lower():
        raise ValueError("FFmpegの取得物の検証に失敗しました。")
    with zipfile.ZipFile(archive) as package:
        for member in package.infolist():
            name = Path(member.filename).name
            if name in ("ffmpeg.exe", "ffprobe.exe", "LICENSE", "LICENSE.txt", "README.txt"):
                # ZIP内のディレクトリ名を使用せず、既知のファイル名だけを書き込みます。
                with package.open(member) as source, (tools / name).open("wb") as target:
                    shutil.copyfileobj(source, target)
    (tools / "wentian-ffmpeg.json").write_text(json.dumps({"source": url, "sha256": actual}), encoding="utf-8")
    archive.unlink()


def download(kind, directory):
    """重み（Weights）の重複取得を避け、safetensorsと設定ファイルだけを取得します。"""
    from huggingface_hub import HfApi, snapshot_download
    token = os.environ.get("HF_TOKEN") or False
    target = directory / kind
    marker = target / "wentian-model.json"
    try:
        revision = json.loads(marker.read_text(encoding="utf-8")).get("revision") if marker.exists() else None
    except (ValueError, OSError):
        revision = None
    info = HfApi().model_info(MODELS[kind], revision=revision, token=token, files_metadata=True)
    # PyTorch pickle形式の重みは取得・読込せず、安全なsafetensorsを使用します。
    selected = [f.rfilename for f in info.siblings if f.rfilename.endswith((".safetensors", ".json", ".txt", ".model", ".tiktoken")) and not f.rfilename.startswith(("onnx/", "flax/", "original/"))]
    if not any(name.endswith(".safetensors") for name in selected):
        raise ValueError("対応するsafetensorsモデルが見つかりません。")
    size = sum(f.size or 0 for f in info.siblings if f.rfilename in selected)
    print(f"{kind}を取得します：約{size / 1e9:.2f}GB。", flush=True)
    target = directory / kind
    target.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(target).free < size + 2 * 1024**3:
        raise ValueError("音声モデルの取得に必要なディスク空き容量がありません。")
    snapshot_download(MODELS[kind], revision=info.sha, token=token, local_dir=str(target), allow_patterns=selected)
    files = {name: (target / name).stat().st_size for name in selected}
    (target / "wentian-model.json").write_text(json.dumps({"repository": MODELS[kind], "revision": info.sha, "bytes": size, "files": files}), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent.parent / ".wentian/video-engine")
    parser.add_argument("--download", choices=[*MODELS, "all"])
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--model-root", type=Path)
    args = parser.parse_args()
    directory = args.directory.resolve()
    python = directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    dependency_check = "import importlib.util,sys;sys.exit(0 if all(importlib.util.find_spec(n) is not None for n in ['torch','transformers','diffusers','huggingface_hub']) else 1)"
    if not python.exists() or subprocess.run([str(python), "-c", dependency_check], check=False).returncode:
        # 基本ライブラリだけを準備し、動画モデルの大容量取得は行いません。
        subprocess.run([sys.executable, str(Path(__file__).with_name("setup-video-engine.py")), "--directory", str(directory), "--device", args.device], check=True)
    subprocess.run(["uv", "pip", "install", "--python", str(python), "scipy>=1.15,<1.17"], check=True)
    prepare_ffmpeg(directory)
    root = (args.model_root or Path(os.environ.get("WENTIAN_AUDIO_MODEL_ROOT", str(directory / "audio-models")))).resolve()
    if args.download:
        # Hugging Faceのモジュールを専用環境内で使用し、トークンを引数やログへ出しません。
        for kind in (MODELS if args.download == "all" else [args.download]):
            code = "import runpy,sys,pathlib; m=runpy.run_path(sys.argv[1]); m['download'](sys.argv[2],pathlib.Path(sys.argv[3]))"
            subprocess.run([str(python), "-c", code, str(Path(__file__).resolve()), kind, str(root)], check=True)
    subprocess.run([str(python), str(Path(__file__).with_name("media-worker.py")), "--diagnose"], check=True)
    print("音声制作環境の準備を確認しました。未取得のモデルは必要なものだけ追加してください。")


if __name__ == "__main__":
    main()
