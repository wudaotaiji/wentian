"""会議保存データをローカルWhisperで文字起こしします。

既存の音声制作環境、モデル保存先、FFmpeg設定を再利用します。
モデルを自動取得せず、音声は30秒ずつ読み込んでメモリ増加を抑えます。
会議本文や認証値を実行ログへ出しません。
"""
import argparse
import importlib.util
import json
from pathlib import Path
import wave


def transcribe(directory, language):
    """固定された保存ファイルだけを扱い、任意URLやシェル式は受け付けません。"""
    import numpy as np
    import torch
    from transformers import AutoProcessor, WhisperForConditionalGeneration

    spec = importlib.util.spec_from_file_location("wentian_media", Path(__file__).with_name("media-worker.py"))
    media = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(media)
    model = media.model_root() / "transcribe"
    if not media.model_complete(model):
        raise ValueError("文字起こしモデルが未準備です。音声制作の設定から準備してください。")
    # MediaRecorderのWebMに長さが記録されない場合も、実音声の復号結果で検証します。
    # 安全上限は4時間。上限を1秒超えて復号し、切り捨てを成功と扱わないようにします。
    audio = directory / "meeting.wav"
    media.command([media.ffmpeg(), "-nostdin", "-y", "-v", "error",
                   "-protocol_whitelist", "file,pipe", "-i", str(directory / "capture.bin"),
                   "-t", "14401", "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(audio)])
    device = media.ai_device()
    processor = AutoProcessor.from_pretrained(str(model), local_files_only=True)
    pipeline = WhisperForConditionalGeneration.from_pretrained(str(model), local_files_only=True, use_safetensors=True).to(device)
    segments = []
    with wave.open(str(audio), "rb") as source:
        rate = source.getframerate()
        if source.getnchannels() != 1 or source.getsampwidth() != 2 or not 0 < source.getnframes() / rate <= 14400:
            raise ValueError("会議音声の形式または長さが範囲外です。")
        start = 0
        while True:
            frames = source.readframes(rate * 30)
            if not frames:
                break
            samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768
            # 無音を文字に変換しないため、入力信号がない区間は推論せず空欄として残します。
            text = ""
            if np.max(np.abs(samples)) > 0.0001:
                processed = processor(samples, sampling_rate=rate, return_tensors="pt", return_attention_mask=True)
                options = {"task": "transcribe", "max_new_tokens": 256}
                if language != "auto":
                    options["language"] = language
                with torch.inference_mode():
                    tokens = pipeline.generate(processed.input_features.to(device), attention_mask=processed.attention_mask.to(device), **options)
                text = processor.batch_decode(tokens, skip_special_tokens=True)[0].strip()
            end = start + len(samples) / rate
            segments.append({"start": start, "end": end, "text": text})
            start = end
    (directory / "transcript.json").write_text(json.dumps({"segments": segments}, ensure_ascii=False), encoding="utf-8")
    # 元の録画を保全し、復号のために作成した一時WAVだけを取り除きます。
    audio.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="会議のローカル文字起こし")
    parser.add_argument("--directory", required=True)
    parser.add_argument("--language", choices=["auto", "ja", "zh", "en"], default="auto")
    args = parser.parse_args()
    try:
        transcribe(Path(args.directory).resolve(strict=True), args.language)
        print("会議の文字起こしを保存しました。")
    except Exception:
        print("会議の文字起こしに失敗しました。モデル・音声形式・実行環境を確認してください。")
        raise SystemExit(1)
