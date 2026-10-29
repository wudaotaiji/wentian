"""音声・動画制作ワーカー（Media Worker）。ComfyUIや外部生成APIを使用しません。

読み上げはWindows SAPI／espeak-ng、BGMはMusicGen、効果音はAudioLDM、
文字起こしはWhisperを直接呼びます。モデルは準備済みのローカルファイルだけを使います。
編集はFFmpegへ検証済み数値と固定ファイル名を引数配列で渡します。
利用者の文字列をシェルやフィルター式として実行しません。
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def emit(percent, stage):
    """ワーカー（Worker）の標準出力は構造化した日本語の進捗専用です。"""
    print(json.dumps({"type": "progress", "percent": percent, "stage": stage}, ensure_ascii=False), flush=True)


def command(arguments, directory=None, environment=None, text_input=None):
    """シェルを経由せず起動し、ライブラリの例外・入力本文を外部へ流しません。"""
    result = subprocess.run(arguments, cwd=directory, env=environment, input=text_input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise ValueError("音声・動画の処理に失敗しました。素材の形式と実行環境を確認してください。")
    return result.stdout


def ffmpeg():
    dedicated = Path(__file__).resolve().parent.parent / ".wentian/video-engine/ffmpeg/ffmpeg.exe"
    executable = os.environ.get("WENTIAN_FFMPEG") or (str(dedicated) if dedicated.exists() else None)
    if executable:
        return executable
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def ffprobe():
    dedicated = Path(__file__).resolve().parent.parent / ".wentian/video-engine/ffmpeg/ffprobe.exe"
    executable = os.environ.get("WENTIAN_FFPROBE") or (str(dedicated) if dedicated.exists() else shutil.which("ffprobe"))
    if not executable:
        raise ValueError("音声・動画の検査にffprobeが必要です。FFmpeg一式を準備してください。")
    return executable


def probe(file):
    """コンテナー（Container）の情報を取得し、過大な長さ・画像サイズを拒否します。"""
    data = json.loads(command([ffprobe(), "-v", "error", "-protocol_whitelist", "file,pipe", "-show_format", "-show_streams", "-of", "json", str(file)]))
    duration = float(data.get("format", {}).get("duration", 0))
    streams = data.get("streams", [])
    if not 0 < duration <= 120.1 or len(streams) > 8:
        raise ValueError("音声・動画は120秒以内で指定してください。")
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video and (int(video.get("width", 0)) * int(video.get("height", 0)) > 8_500_000):
        raise ValueError("動画の解像度が上限を超えています。")
    if audio and (int(audio.get("channels", 0)) > 8 or int(audio.get("sample_rate", 0)) > 192000):
        raise ValueError("音声のチャンネル数またはサンプリング周波数が範囲外です。")
    return {"duration": duration, "hasAudio": audio is not None, "width": video.get("width") if video else None, "height": video.get("height") if video else None, "sampleRate": int(audio["sample_rate"]) if audio else None, "channels": audio.get("channels") if audio else None}


def model_root():
    return Path(os.environ.get("WENTIAN_AUDIO_MODEL_ROOT", str(Path(__file__).resolve().parent.parent / ".wentian/video-engine/audio-models"))).resolve()


def model_complete(directory):
    """完了マーカーと構成ファイルの存在・容量を検査します。"""
    try:
        metadata = json.loads((directory / "wentian-model.json").read_text(encoding="utf-8"))
        files = metadata.get("files", {})
        return bool(files) and all((directory / name).is_file() and (directory / name).stat().st_size == size for name, size in files.items())
    except (OSError, ValueError):
        return False


def voices():
    """OSに登録済みの音声だけを公開します。任意の実行ファイルは選択させません。"""
    if os.name == "nt":
        script = "Add-Type -AssemblyName System.Speech; @([System.Speech.Synthesis.SpeechSynthesizer]::new().GetInstalledVoices() | ForEach-Object { @{name=$_.VoiceInfo.Name;language=$_.VoiceInfo.Culture.Name} }) | ConvertTo-Json -Compress"
        raw = command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new();" + script])
        result = json.loads(raw.decode("utf-8-sig"))
        return result if isinstance(result, list) else [result]
    if shutil.which("espeak-ng"):
        lines = command(["espeak-ng", "--voices"]).decode("utf-8", errors="replace").splitlines()[1:]
        return [{"name": row.split()[1], "language": row.split()[1]} for row in lines if len(row.split()) >= 4]
    return []


def diagnose():
    """編集・読み上げ・各AIモデルを別々に診断し、一部の未準備で全機能を停止しません。"""
    features = {}
    try:
        command([ffmpeg(), "-version"])
        command([ffprobe(), "-version"])
        features["editing"] = {"ready": True, "message": "音声・動画の編集と合成を利用できます。"}
    except Exception:
        features["editing"] = {"ready": False, "message": "FFmpegとffprobeを準備してください。"}
    try:
        installed = voices()
    except Exception:
        installed = []
    features["speech"] = {"ready": bool(installed) and features["editing"]["ready"], "message": "PC標準の読み上げを利用できます。" if installed else "読み上げ音声が未準備です。Windows音声またはespeak-ngを導入してください。"}
    libraries = all(importlib.util.find_spec(name) is not None for name in ["torch", "transformers", "diffusers", "scipy"])
    for kind, label in [("music", "BGM"), ("sound", "効果音"), ("transcribe", "文字起こし")]:
        ready = libraries and model_complete(model_root() / kind) and features["editing"]["ready"]
        features[kind] = {"ready": ready, "message": label + ("のAIモデルを利用できます。" if ready else "のAIモデルが未準備です。")}
    device = os.environ.get("WENTIAN_AUDIO_DEVICE", os.environ.get("WENTIAN_VIDEO_DEVICE", "auto"))
    if libraries:
        import torch
        if device == "auto":
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
    return {"ready": features["editing"]["ready"], "message": "音声・動画制作の準備状況です。AIモデルは機能ごとに準備できます。", "features": features, "voices": installed, "device": device}


def encode_audio(directory, source):
    """音声をWAV／MP3へ正規化し、両形式をダウンロードできるよう保存します。"""
    info = probe(source)
    if not info["hasAudio"]:
        raise ValueError("音声トラックがありません。")
    emit(88, "WAVとMP3を保存中")
    for extension, codec in [("wav", "pcm_s16le"), ("mp3", "libmp3lame")]:
        target = directory / ("output.partial." + extension)
        command([ffmpeg(), "-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(source), "-map", "0:a:0", "-vn", "-ar", "48000", "-ac", "2", "-c:a", codec, str(target)])
        os.replace(target, directory / ("output." + extension))
    return probe(directory / "output.wav")


def speech(directory, request):
    """テキスト（Text）をSAPI／espeak-ngへそのまま渡し、SSMLやシェル本文として扱いません。"""
    available = voices()
    voice = request.get("voice") or (available[0]["name"] if available else "")
    if voice not in [item["name"] for item in available]:
        raise ValueError("音声を選択してください。指定した音声は利用できません。")
    emit(20, "ナレーションを制作中")
    target = directory / "speech.wav"
    if os.name == "nt":
        script = "Add-Type -AssemblyName System.Speech; $r=Get-Content -LiteralPath $env:WENTIAN_SPEECH_REQUEST -Raw -Encoding UTF8 | ConvertFrom-Json; $s=[System.Speech.Synthesis.SpeechSynthesizer]::new(); try {$s.SelectVoice($env:WENTIAN_SPEECH_VOICE); $s.Rate=[int]$r.rate; $s.Volume=[int]$r.volume; $s.SetOutputToWaveFile($env:WENTIAN_SPEECH_OUTPUT); $s.Speak([string]$r.text)} finally {$s.Dispose()}"
        environment = dict(os.environ, WENTIAN_SPEECH_REQUEST=str(directory / "request.json"), WENTIAN_SPEECH_OUTPUT=str(target), WENTIAN_SPEECH_VOICE=voice)
        command(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], environment=environment)
    else:
        command(["espeak-ng", "-v", voice, "-s", str(175 + int(request.get("rate", 0)) * 20), "-a", str(request.get("volume", 100)), "-w", str(target), "--stdin"], text_input=request["text"].encode("utf-8"))
    return encode_audio(directory, target)


def ai_device():
    import torch
    device = os.environ.get("WENTIAN_AUDIO_DEVICE", os.environ.get("WENTIAN_VIDEO_DEVICE", "auto"))
    if device == "auto":
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    if device != "cpu" and not (device.startswith("cuda:") and device[5:].isdigit() and torch.cuda.is_available() and int(device[5:]) < torch.cuda.device_count()):
        raise ValueError("音声生成用のCUDAデバイスが利用できません。")
    torch.set_num_threads(max(1, min(os.cpu_count() or 1, 8)))
    return device


def generate_ai(directory, request):
    """準備済みMusicGen／AudioLDMを直接呼び出し、制作時にモデルを取得しません。"""
    import torch
    import numpy as np
    from scipy.io import wavfile
    kind = request["kind"]
    model = model_root() / kind
    if not (model / "wentian-model.json").is_file():
        raise ValueError("音声生成のAIモデルが未準備です。")
    device = ai_device()
    torch.manual_seed(int(request["seed"]))
    emit(5, "音声モデルを読み込み中")
    if kind == "music":
        from transformers import AutoProcessor, MusicgenForConditionalGeneration
        processor = AutoProcessor.from_pretrained(str(model), local_files_only=True)
        pipeline = MusicgenForConditionalGeneration.from_pretrained(str(model), local_files_only=True, use_safetensors=True).to(device)
        inputs = processor(text=[request["prompt"]], padding=True, return_tensors="pt").to(device)
        emit(20, "BGMを生成中")
        with torch.inference_mode():
            # キャッシュ（Cache）の版差を避け、CPUでも同じ生成処理を使用します。
            # コードブック（Codebook）の遅延分を加算し、指定秒数より短くしません。
            audio = pipeline.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=max(25, int(request["duration"] * 50)) + pipeline.config.decoder.num_codebooks, use_cache=False)[0, 0].cpu().numpy()
        rate = pipeline.config.audio_encoder.sampling_rate
    else:
        from diffusers import AudioLDMPipeline
        pipeline = AudioLDMPipeline.from_pretrained(str(model), local_files_only=True, use_safetensors=True, torch_dtype=torch.float32)
        if device.startswith("cuda:"):
            pipeline.enable_model_cpu_offload(gpu_id=int(device.split(":")[1]))
        else:
            pipeline.to("cpu")
        pipeline.set_progress_bar_config(disable=True)
        def callback(step, _timestep, _latents):
            emit(20 + int(60 * (step + 1) / request["steps"]), "効果音を生成中")
        audio = pipeline(request["prompt"], num_inference_steps=int(request["steps"]), audio_length_in_s=request["duration"], generator=torch.Generator(device="cpu").manual_seed(int(request["seed"])), callback=callback, callback_steps=1).audios[0]
        rate = 16000
    audio = audio[:int(request["duration"] * rate)]
    target = directory / "generated.wav"
    wavfile.write(target, rate, (np.clip(audio, -1, 1) * 32767).astype(np.int16))
    return encode_audio(directory, target)


def uploaded(directory, request):
    """参照型プレイリスト（Playlist）を拒否し、持ち込み音声・動画を固定形式へ変換します。"""
    source = directory / "upload.bin"
    with source.open("rb") as handle:
        header = handle.read(16)
    audio = header[:4] in (b"RIFF", b"OggS", b"fLaC") or header[:3] == b"ID3" or header[0] == 255 and header[1] & 224 == 224
    video = header[4:8] == b"ftyp" or header[:4] == bytes([26, 69, 223, 163])
    if not (audio or video):
        raise ValueError("音声・動画ファイルの形式が不正です。プレイリストは読み込めません。")
    info = probe(source)
    emit(20, "素材を取り込み中")
    if request["mediaType"] == "audio":
        return encode_audio(directory, source)
    if not info["width"]:
        raise ValueError("動画トラックがありません。")
    temporary = directory / "output.partial.mp4"
    command([ffmpeg(), "-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(temporary)])
    os.replace(temporary, directory / "output.mp4")
    return probe(directory / "output.mp4")


def srt_time(seconds):
    total = int(max(0, seconds) * 1000)
    return f"{total // 3600000:02}:{total // 60000 % 60:02}:{total // 1000 % 60:02},{total % 1000:03}"


def mix(directory, request):
    """トラック（Track）を配置・切取・反復・フェードし、必要なら動画と合成します。"""
    duration = float(request["duration"])
    is_video = request["mediaType"] == "video"
    arguments = [ffmpeg(), "-nostdin", "-y", "-v", "error", "-protocol_whitelist", "file,pipe"]
    filters, labels = [], []
    if is_video:
        source = directory / "source.mp4"
        info = probe(source)
        if request["videoStart"] >= info["duration"]:
            raise ValueError("動画の切り取り開始が長さを超えています。")
        arguments += ["-i", str(source)]
        if request.get("retainOriginal") and info["hasAudio"]:
            # atempoの下限0.5を守り、0.25倍速では二段階に分けます。
            tempo = "atempo=0.5,atempo=0.5" if request["speed"] == 0.25 else (f"atempo=0.5,atempo={request['speed'] * 2}" if request["speed"] < 0.5 else f"atempo={request['speed']}")
            filters.append(f"[0:a]atrim=start={request['videoStart']},asetpts=PTS-STARTPTS,{tempo},volume={request['originalVolume']},aresample=48000,aformat=channel_layouts=stereo[original]")
            labels.append("[original]")
    for n, track in enumerate(request["tracks"]):
        source = directory / f"track-{n}.audio"
        info = probe(source)
        segment = min(float(track.get("trimEnd", info["duration"])), info["duration"]) - float(track["trimStart"])
        if segment <= 0:
            raise ValueError("音声の切り取り範囲が素材の長さを超えています。")
        arguments += ["-i", str(source)]
        index = n + (1 if is_video else 0)
        chain = f"[{index}:a]atrim=start={track['trimStart']}:duration={segment},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
        if track.get("loop"):
            chain += f",aloop=loop=-1:size={max(1,int(segment*48000))},atrim=duration={duration-track['start']}"
        length = duration - track["start"] if track.get("loop") else min(segment, duration - track["start"])
        chain += f",volume={track['volume']}"
        if track["fadeIn"]:
            chain += f",afade=t=in:d={min(track['fadeIn'],length)}"
        if track["fadeOut"]:
            chain += f",afade=t=out:st={max(0,length-track['fadeOut'])}:d={min(track['fadeOut'],length)}"
        chain += f",adelay={int(track['start']*1000)}:all=1[a{n}]"
        filters.append(chain)
        labels.append(f"[a{n}]")
    if labels:
        filters.append("".join(labels) + f"amix=inputs={len(labels)}:duration=longest:normalize=0,alimiter=limit=0.95:level=0,apad,atrim=duration={duration}[audio]")
    if is_video:
        chain = f"[0:v]trim=start={request['videoStart']},setpts=(PTS-STARTPTS)/{request['speed']}"
        if request.get("width"):
            w, h = request["width"], request["height"]
            chain += f",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
        # 速度変更後も固定フレームレート（Frame Rate）へ揃え、作品の長さを安定させます。
        chain += f",tpad=stop_mode=clone:stop_duration={duration},fps=24"
        if request.get("caption"):
            # 字幕はSRTファイルとして渡します。本文をFFmpegフィルター式へ埋め込みません。
            caption = request["caption"].replace("{", "(").replace("}", ")").replace("\\", "/")
            (directory / "output.srt").write_text(f"1\n00:00:00,000 --> {srt_time(duration)}\n{caption}\n", encoding="utf-8")
            chain += ",subtitles=output.srt"
        filters.append(chain + "[video]")
    arguments += ["-filter_complex", ";".join(filters)]
    if is_video:
        arguments += ["-map", "[video]", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p"]
    if labels:
        arguments += ["-map", "[audio]", "-c:a", "aac" if is_video else "pcm_s16le", "-ar", "48000", "-ac", "2"]
    else:
        arguments += ["-an"]
    temporary = directory / ("mixed.mp4" if is_video else "mixed.wav")
    if is_video:
        arguments += ["-movflags", "+faststart"]
    arguments += ["-t", str(duration), str(temporary)]
    emit(25, "トラックを編集・合成中")
    command(arguments, directory=directory)
    if is_video:
        os.replace(temporary, directory / "output.mp4")
        return probe(directory / "output.mp4")
    return encode_audio(directory, temporary)


def transcribe(directory, request):
    """音声を30秒ずつ処理し、テキストと区間単位のSRT字幕を保存します。"""
    import torch
    import numpy as np
    from scipy.io import wavfile
    from transformers import AutoProcessor, WhisperForConditionalGeneration
    model = model_root() / "transcribe"
    if not (model / "wentian-model.json").is_file():
        raise ValueError("音声の文字起こしモデルが未準備です。")
    probe(directory / "source.audio")
    command([ffmpeg(), "-nostdin", "-y", "-v", "error", "-i", str(directory / "source.audio"), "-ar", "16000", "-ac", "1", str(directory / "transcribe.wav")])
    rate, audio = wavfile.read(directory / "transcribe.wav")
    audio = audio.astype(np.float32) / 32768
    device = ai_device()
    emit(10, "文字起こしモデルを読み込み中")
    processor = AutoProcessor.from_pretrained(str(model), local_files_only=True)
    pipeline = WhisperForConditionalGeneration.from_pretrained(str(model), local_files_only=True, use_safetensors=True).to(device)
    segments = []
    for start in range(0, len(audio), rate * 30):
        chunk = audio[start:start + rate * 30]
        processed = processor(chunk, sampling_rate=rate, return_tensors="pt", return_attention_mask=True)
        inputs = processed.input_features.to(device)
        options = {"task": "transcribe", "max_new_tokens": 256}
        if request.get("language") != "auto":
            options["language"] = request["language"]
        with torch.inference_mode():
            tokens = pipeline.generate(inputs, attention_mask=processed.attention_mask.to(device), **options)
        text = processor.batch_decode(tokens, skip_special_tokens=True)[0].strip()
        segments.append({"start": start / rate, "end": (start + len(chunk)) / rate, "text": text})
        emit(20 + int(70 * (start + len(chunk)) / len(audio)), "文字起こし中")
    text = "\n".join(s["text"] for s in segments)
    (directory / "output.txt").write_text(text or "（音声を認識できませんでした）", encoding="utf-8")
    (directory / "output.json").write_text(json.dumps({"text": text, "segments": segments}, ensure_ascii=False), encoding="utf-8")
    (directory / "output.srt").write_text("\n".join(f"{i+1}\n{srt_time(s['start'])} --> {srt_time(s['end'])}\n{s['text']}\n" for i, s in enumerate(segments)), encoding="utf-8")
    return {"text": text, "duration": len(audio) / rate}


def attach_video(directory):
    """動画生成側の完成映像へ、受付時に複製した音声を動画尺に合わせて付けます。"""
    request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
    source = directory / "output.mp4"
    duration = probe(source)["duration"]
    volume = float(request.get("audioVolume", 1))
    if not 0 <= volume <= 2:
        raise ValueError("音声の音量が範囲外です。")
    temporary = directory / "attached.mp4"
    command([ffmpeg(), "-nostdin", "-y", "-v", "error", "-i", str(source), "-i", str(directory / "soundtrack.audio"), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-af", f"volume={volume},apad", "-t", str(duration), "-c:a", "aac", "-movflags", "+faststart", str(temporary)])
    os.replace(temporary, source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--diagnose", action="store_true")
    modes.add_argument("--job", type=Path)
    modes.add_argument("--attach-video", type=Path)
    args = parser.parse_args()
    try:
        if args.diagnose:
            print(json.dumps(diagnose(), ensure_ascii=False), flush=True)
        elif args.attach_video:
            attach_video(args.attach_video.resolve(strict=True))
        else:
            directory = args.job.resolve(strict=True)
            request = json.loads((directory / "request.json").read_text(encoding="utf-8"))
            kind = request["kind"]
            result = speech(directory, request) if kind == "speech" else generate_ai(directory, request) if kind in ("music", "sound") else uploaded(directory, request) if kind == "upload" else mix(directory, request) if kind == "mix" else transcribe(directory, request) if kind == "transcribe" else None
            if result is None:
                raise ValueError("音声・動画の制作種別が不正です。")
            (directory / "result.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            emit(99, "保存を確認中")
    except Exception as error:
        if isinstance(error, ValueError) and str(error).startswith(("音声", "動画", "素材", "読み上げ")):
            message = str(error)
        elif isinstance(error, (ImportError, ModuleNotFoundError)):
            message = "音声制作の依存ライブラリが未準備です。セットアップを実行してください。"
        elif "out of memory" in str(error).lower() or isinstance(error, MemoryError):
            message = "音声制作に必要なメモリが不足しています。長さを短くしてください。"
        else:
            message = "音声・動画制作に失敗しました。素材・モデル・実行環境を確認してください。"
        print(json.dumps({"type": "error", "message": message}, ensure_ascii=False), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
