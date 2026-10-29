"""動画生成エンジン（Video Engine）を専用Python環境へ準備します。

CPUとNVIDIA CUDAを選択できます。既存Python環境のパッケージは変更しません。
モデルの大容量取得は--download-model指定時だけ行い、生成中には通信しません。
Hugging Faceの認証が必要な環境はHF_TOKENを環境変数で設定し、ログへ出さないでください。
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--directory", type=Path, default=Path(__file__).resolve().parent.parent / ".wentian/video-engine")
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--revision", default=None, help="モデルの固定リビジョン。省略時は取得時点のコミットへ固定します。")
    args = parser.parse_args()
    directory = args.directory.resolve()
    python = directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    # uvの引数を分離し、保存先をシェルとして解釈させません。Pythonは3.11へ統一します。
    if not python.exists():
        subprocess.run(["uv", "venv", "--python", "3.11", str(directory)], check=True)
    print("動画生成の依存ライブラリを専用環境へ準備しています。", flush=True)
    index = "https://download.pytorch.org/whl/cu128" if args.device == "cuda" else "https://download.pytorch.org/whl/cpu"
    subprocess.run(["uv", "pip", "install", "--python", str(python), "--index-url", index, "torch==2.8.0"], check=True)
    # 採用したAPIを固定し、別版への自動更新でパイプライン呼出しが変わることを防ぎます。
    subprocess.run(["uv", "pip", "install", "--python", str(python), "diffusers==0.35.2", "transformers==4.56.2", "accelerate==1.10.1", "safetensors>=0.6,<0.7", "sentencepiece>=0.2,<0.3", "protobuf>=5,<7", "Pillow>=11,<12", "imageio>=2.37,<3", "imageio-ffmpeg>=0.6,<0.7", "huggingface-hub>=0.34,<1"], check=True)
    if args.download_model:
        model = Path(os.environ.get("WENTIAN_VIDEO_MODEL_PATH", str(directory / "model")))
        model.mkdir(parents=True, exist_ok=True)
        # トークンは親プロセスからの環境変数だけで受け取り、取得結果には公開リビジョンのみ記録します。
        code = "from huggingface_hub import HfApi,snapshot_download; import sys,json,pathlib,os; repo='Lightricks/LTX-Video'; token=os.environ.get('HF_TOKEN') or False; revision=HfApi().model_info(repo,revision=sys.argv[2] or None,token=token).sha; snapshot_download(repo,revision=revision,local_dir=sys.argv[1],token=token,allow_patterns=['model_index.json','scheduler/*.json','tokenizer/*','text_encoder/*.json','text_encoder/*.safetensors','transformer/*.json','transformer/*.safetensors','vae/*.json','vae/*.safetensors']); pathlib.Path(sys.argv[1],'wentian-model.json').write_text(json.dumps({'repository':repo,'revision':revision}),encoding='utf-8')"
        print("LTXモデルを取得しています。数十GBの空き容量と通信量が必要です。", flush=True)
        marker = model / "wentian-model.json"
        revision = args.revision or (json.loads(marker.read_text(encoding="utf-8")).get("revision") if marker.exists() else "")
        subprocess.run([str(python), "-c", code, str(model), revision or ""], check=True)
        manifest = json.loads(marker.read_text(encoding="utf-8"))
        manifest["files"] = {str(file.relative_to(model)).replace("\\", "/"): file.stat().st_size for file in model.rglob("*") if file.is_file() and ".cache" not in file.parts and file.name != "wentian-model.json"}
        marker.write_text(json.dumps(manifest), encoding="utf-8")
    print("動画用Python環境を準備しました。", flush=True)
    print("WENTIAN_VIDEO_PYTHON=" + str(python))
    print("WENTIAN_VIDEO_MODEL_PATH=" + str(directory / "model"))
    if not args.download_model:
        print("モデルは未取得です。--download-modelを付けて再実行してください。")


if __name__ == "__main__":
    main()
