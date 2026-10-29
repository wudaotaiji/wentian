"""基盤のモデル自動保守（Model Maintenance）。許可されたモデルだけを取得・修復します。

公開リビジョンは初回取得時に固定し、既存の正常なモデルを勝手に更新しません。
未完了取得はHugging Faceの再開機能を使い、サイズ不一致を検出すると修復します。
本番動画モデルは設定ファイルで有効にした場合だけ取得します。
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def healthy(directory):
    """台帳（Manifest）に記録されたファイルの存在と容量を毎回確認します。"""
    try:
        marker = json.loads((directory / "wentian-model.json").read_text(encoding="utf-8"))
        files = marker.get("files", {})
        return bool(files) and all((directory / name).is_file() and (directory / name).stat().st_size == size for name, size in files.items())
    except (OSError, ValueError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, required=True)
    args = parser.parse_args()
    policy = json.loads(args.policy.read_text(encoding="utf-8"))
    root = Path(__file__).resolve().parent.parent
    engine = root / ".wentian/video-engine"
    audio = Path(os.environ.get("WENTIAN_AUDIO_MODEL_ROOT", str(engine / "audio-models")))
    video = Path(os.environ.get("WENTIAN_VIDEO_MODEL_PATH", str(engine / "model")))
    results = {}
    from importlib.machinery import SourceFileLoader
    setup = SourceFileLoader("wentian_media_setup", str(root / "scripts/setup-media-engine.py")).load_module()
    setup.prepare_ffmpeg(engine)
    for kind in ["music", "sound", "transcribe", "video"]:
        directory = video if kind == "video" else audio / kind
        if not policy.get(kind, False):
            results[kind] = {"state": "deferred", "message": "取得は保留されています。"}
            continue
        try:
            if not healthy(directory):
                if kind == "video":
                    directory.mkdir(parents=True, exist_ok=True)
                    # 最小環境の動画モデルは検証用です。本番28GBモデルへ自動昇格させません。
                    from huggingface_hub import HfApi, snapshot_download
                    repository = "optimum-intel-internal-testing/tiny-random-ltx-video"
                    token = os.environ.get("HF_TOKEN") or False
                    marker = directory / "wentian-model.json"
                    try:
                        previous = json.loads(marker.read_text(encoding="utf-8")) if marker.exists() else {}
                    except (ValueError, OSError):
                        previous = {}
                    if previous.get("repository") and previous["repository"] != repository:
                        raise ValueError("既存の動画モデルは自動置換しません。別の保存先を指定してください。")
                    info = HfApi().model_info(repository, revision=previous.get("revision"), token=token, files_metadata=True)
                    files = [f.rfilename for f in info.siblings if f.rfilename.endswith((".safetensors", ".json", ".txt", ".model"))]
                    snapshot_download(repository, revision=info.sha, token=token, local_dir=str(directory), allow_patterns=files)
                    marker.write_text(json.dumps({"repository": repository, "revision": info.sha, "verificationOnly": True, "files": {name: (directory / name).stat().st_size for name in files}}), encoding="utf-8")
                    command = None
                else:
                    from importlib.machinery import SourceFileLoader
                    module = SourceFileLoader("wentian_media_setup", str(root / "scripts/setup-media-engine.py")).load_module()
                    module.download(kind, audio)
                    command = None
                if command:
                    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=7200)
                if not healthy(directory):
                    raise ValueError("モデルの整合性を確認できませんでした。")
            results[kind] = {"state": "ready", "message": "モデルを準備済みです。"}
        except Exception:
            # 秘密値やライブラリの例外全文を保守画面へ公開しません。
            results[kind] = {"state": "failed", "message": "取得・検査に失敗しました。通信・空き容量・保存先を確認してください。次回の保守で再試行します。"}
    print(json.dumps(results, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
