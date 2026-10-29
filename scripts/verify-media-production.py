"""音声・動画制作の実検証（Verification）。本番の作品・認証・ポートを変更しません。

標準で実際の日本語・中国語・英語読み上げとFFmpeg編集を検証します。
--aiは取得済みの本番音声モデルでCPU推論、--browserはEdgeで実画面を検証します。
生成した素材と検査結果は証跡フォルダーに保存し、モデルの画質・精度を保証しません。
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import wave
import array


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ai", action="store_true")
    parser.add_argument("--browser", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    evidence = root / "docs/evidence/media-production/20261007"
    evidence.mkdir(parents=True, exist_ok=True)
    python = root / ".wentian/video-engine/Scripts/python.exe"
    ffmpeg = str(root / ".wentian/video-engine/ffmpeg/ffmpeg.exe")
    env = dict(os.environ, PYTHONIOENCODING="utf-8", WENTIAN_AUDIO_DEVICE="cpu", WENTIAN_MEDIA_MODEL_MAINTENANCE="false")
    report = {"device": "cpu", "gpuVerified": False, "checks": []}
    # 型検査と所有者・キュー・API境界の自動試験は、実処理とは分けて記録します。
    for index, command in enumerate([["node", "node_modules/typescript/bin/tsc", "--noEmit"], ["node", "--import", "tsx", "--import", "./src/test-environment.ts", "--test", "src/media-production.test.ts", "src/media-examples.test.ts", "src/media-model-maintenance.test.ts", "src/video-generation.test.ts", "src/navigation-ui.test.ts", "src/server.test.ts"]]):
        with (evidence / f"checks-{index}.log").open("w", encoding="utf-8") as log:
            result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        if result.returncode:
            raise RuntimeError("自動試験が失敗しました。証跡のログを確認してください。")
    # 検証専用フォルダーへ要求を保存し、公開APIと同じPythonワーカーを呼びます。
    with tempfile.TemporaryDirectory(prefix="wentian-media-verification-") as temporary:
        work = Path(temporary)
        def job(name, request, sources=None):
            directory = work / name
            directory.mkdir()
            (directory / "request.json").write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
            for target, source in (sources or {}).items():
                shutil.copyfile(source, directory / target)
            started = time.monotonic()
            with (evidence / (name + ".log")).open("w", encoding="utf-8") as log:
                result = subprocess.run([str(python), str(root / "scripts/media-worker.py"), "--job", str(directory)], env=env, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
            if result.returncode:
                raise RuntimeError(name + "の実処理が失敗しました。ログを確認してください。")
            metadata = json.loads((directory / "result.json").read_text(encoding="utf-8"))
            report["checks"].append({"name": name, "seconds": round(time.monotonic() - started, 2), "result": metadata})
            for file in directory.glob("output.*"):
                shutil.copyfile(file, evidence / (name + file.suffix))
            return directory
        samples = []
        for name, voice, text in [("speech-ja", "Microsoft Haruka Desktop", "こんにちは。動画と音声の制作を確認しています。"), ("speech-zh", "Microsoft Huihui Desktop", "你好。正在确认视频和音频制作功能。"), ("speech-en", "Microsoft Zira Desktop", "Hello. We are testing video and audio production.")]:
            samples.append(job(name, {"kind": "speech", "text": text, "voice": voice, "rate": 0, "volume": 100}))
        track = {"id": "verification", "start": 0, "trimStart": 0, "volume": 0.7, "fadeIn": 0.2, "fadeOut": 0.3, "loop": True}
        mixed = job("audio-mix", {"kind": "mix", "mediaType": "audio", "duration": 4, "tracks": [track, {**track, "start": 1, "trimStart": 0.2, "trimEnd": 1.5, "volume": 0.2}]}, {"track-0.audio": samples[0] / "output.wav", "track-1.audio": samples[1] / "output.wav"})
        source = work / "source.mp4"
        subprocess.run([ffmpeg, "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=12:d=2", "-i", str(mixed / "output.wav"), "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(source)], check=True, env=env)
        base = {"kind": "mix", "mediaType": "video", "duration": 4, "videoStart": 0, "speed": 0.25, "retainOriginal": True, "originalVolume": 0.5, "width": 512, "height": 320, "tracks": [track], "caption": "動画と音声の合成テスト"}
        video = job("video-with-audio", base, {"source.mp4": source, "track-0.audio": samples[2] / "output.wav"})
        assert json.loads((video / "result.json").read_text())["hasAudio"]
        silent = job("video-silent", {**base, "tracks": [], "retainOriginal": False, "caption": ""}, {"source.mp4": source})
        silent_result = json.loads((silent / "result.json").read_text())
        assert not silent_result["hasAudio"]
        assert abs(silent_result["duration"] - base["duration"]) < 0.05
        attach = work / "attach"
        attach.mkdir()
        shutil.copyfile(source, attach / "output.mp4")
        shutil.copyfile(samples[0] / "output.wav", attach / "soundtrack.audio")
        (attach / "request.json").write_text(json.dumps({"audioVolume": 0.5}))
        subprocess.run([str(python), str(root / "scripts/media-worker.py"), "--attach-video", str(attach)], env=env, check=True)
        report["checks"].append({"name": "generated-video-audio-attachment", "success": True})
        # 保存だけでなく、FFmpegが音声と映像を最後まで復号できることを確認します。
        for file in evidence.glob("*"):
            if file.suffix in (".wav", ".mp3", ".mp4"):
                subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-i", str(file), "-f", "null", "-"], env=env, check=True, timeout=30)
        if args.ai:
            for kind, prompt in [("music", "Gentle piano melody"), ("sound", "Rain falling on a roof")]:
                generated = job("ai-" + kind, {"kind": kind, "prompt": prompt, "duration": 1, "seed": 42, "steps": 2})
                result = json.loads((generated / "result.json").read_text())
                assert result["hasAudio"] and abs(result["duration"] - 1) < 0.05
                # 音声トラックの存在だけでなく、無音ではない波形を保存したことも確認します。
                with wave.open(str(generated / "output.wav")) as audio:
                    amplitude = max(abs(sample) for sample in array.array("h", audio.readframes(audio.getnframes())))
                    assert amplitude > 10
                report["checks"][-1]["peakAmplitude"] = amplitude
            job("transcribe", {"kind": "transcribe", "language": "en"}, {"source.audio": samples[2] / "output.wav"})
            verify_maintenance(root, evidence, env)
        if args.browser:
            browser_check(root, evidence, env, report)
    (evidence / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("音声・動画制作の実処理と保存・復号の検証が成功しました。")


def verify_maintenance(root, evidence, env):
    """隔離した小型モデルを一部破損させ、固定リビジョンの自動修復を実行します。"""
    with tempfile.TemporaryDirectory(prefix="wentian-model-repair-") as temporary:
        work = Path(temporary)
        model = work / "model"
        shutil.copytree(root / ".wentian/video-engine/model", model, ignore=shutil.ignore_patterns(".cache"))
        before = json.loads((model / "wentian-model.json").read_text())
        config = model / "transformer/config.json"
        original = config.read_bytes()
        config.write_text("破損確認", encoding="utf-8")
        policy = work / "policy.json"
        policy.write_text(json.dumps({"video": True}))
        isolated = dict(env, WENTIAN_VIDEO_MODEL_PATH=str(model), HF_HUB_OFFLINE="0", TRANSFORMERS_OFFLINE="0")
        with (evidence / "model-repair.log").open("w", encoding="utf-8") as log:
            subprocess.run([str(root / ".wentian/video-engine/Scripts/python.exe"), str(root / "scripts/maintain-media-models.py"), "--policy", str(policy)], env=isolated, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
        after = json.loads((model / "wentian-model.json").read_text())
        assert config.read_bytes() == original
        assert after["revision"] == before["revision"]
        (evidence / "model-repair.json").write_text(json.dumps({"success": True, "revision": after["revision"], "checks": ["容量不一致検出後の再取得", "元ファイルとの一致", "リビジョン固定", "本番保存先の隔離"]}, ensure_ascii=False, indent=2), encoding="utf-8")


def browser_check(root, evidence, env, report):
    """実認証（Authentication）から制作・再生・取得・削除まで実画面で検証します。"""
    from playwright.sync_api import sync_playwright, expect
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="wentian-media-browser-") as temporary:
        work = Path(temporary)
        username, password = "media-test-admin", secrets.token_urlsafe(32)
        isolated = dict(env, PORT=str(port), WENTIAN_HOST="127.0.0.1", WENTIAN_ENV_FILE=str(work / "unused.env"), WENTIAN_USER_STORE=str(work / "users.json"), WENTIAN_ADMIN_USERNAME=username, WENTIAN_ADMIN_PASSWORD=password, WENTIAN_VIDEO_ROOT=str(work / "videos"), WENTIAN_MEDIA_ROOT=str(work / "media"), WENTIAN_MEDIA_MAINTENANCE_ROOT=str(work / "maintenance"), WENTIAN_CLOUD_STORE=str(work / "cloud.sqlite"), WENTIAN_GOAL_PATH=str(work / "goals"), WENTIAN_EVENT_STORE=str(work / "events.jsonl"), WENTIAN_AGENT_CONNECTION_MAINTENANCE="false")
        isolated.pop("WENTIAN_API_KEY", None)
        with (evidence / "browser-server.log").open("w", encoding="utf-8") as log:
            server = subprocess.Popen(["node", "--import", (root / "node_modules/tsx/dist/loader.mjs").as_uri(), str(root / "src/server.ts")], cwd=work, env=isolated, stdout=log, stderr=subprocess.STDOUT)
            base = f"http://127.0.0.1:{port}"
            try:
                for _ in range(90):
                    try:
                        urllib.request.urlopen(base + "/health", timeout=1).close()
                        break
                    except Exception:
                        if server.poll() is not None:
                            raise RuntimeError("隔離サーバーの起動に失敗しました。")
                        time.sleep(1)
                with sync_playwright() as p:
                    browser = p.chromium.launch(channel="msedge", headless=True)
                    page = browser.new_page(viewport={"width": 1440, "height": 1000})
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.goto(base + "/media-studio")
                    page.locator("#username").fill(username)
                    page.locator("#password").fill(password)
                    page.locator("#loginForm button").click()
                    expect(page.locator("#create")).to_be_enabled(timeout=60000)
                    expect(page.locator("#exampleCards article")).to_have_count(12, timeout=30000)
                    example_audio = page.locator("#exampleCards audio").first
                    example_audio.evaluate("async a=>{a.muted=true;await a.play()}")
                    page.wait_for_function("document.querySelector('#exampleCards audio').currentTime>0")
                    page.locator("#text").fill("音声と動画の制作テストです。")
                    page.locator("#voice").select_option("Microsoft Haruka Desktop")
                    page.locator("#title").fill("画面検証ナレーション")
                    page.locator("#create").click()
                    expect(page.locator("#jobs article")).to_have_attribute("data-status", "succeeded", timeout=60000)
                    audio = page.locator("#jobs audio")
                    audio.evaluate("async a=>{a.muted=true;await a.play()}")
                    page.wait_for_function("document.querySelector('#jobs audio').currentTime>0")
                    with page.expect_download() as event:
                        page.locator("#jobs").get_by_role("link", name="MP3", exact=True).click()
                    event.value.save_as(str(evidence / "browser-audio.mp3"))
                    page.locator("#addTrack").click()
                    page.locator(".trackSource").select_option(index=1)
                    page.locator('[data-field="loop"]').check()
                    page.locator("#mix").click()
                    expect(page.locator('#jobs article[data-status="succeeded"]')).to_have_count(2, timeout=60000)
                    page.locator("#uploadType").select_option("video")
                    page.locator("#upload").set_input_files(str(evidence / "video-silent.mp4"))
                    page.locator("#uploadButton").click()
                    expect(page.locator('#jobs article[data-status="succeeded"]')).to_have_count(3, timeout=60000)
                    page.locator("#mixType").select_option("video")
                    page.locator("#videoSource").select_option(index=1)
                    page.locator("#caption").fill("画面から合成した字幕")
                    page.locator("#mix").click()
                    expect(page.locator('#jobs article[data-status="succeeded"]')).to_have_count(4, timeout=60000)
                    video = page.locator("#jobs video").last
                    video.evaluate("async v=>{v.muted=true;await v.play()}")
                    page.wait_for_function("[...document.querySelectorAll('video')].some(v=>v.currentTime>0)")
                    page.evaluate("window.scrollTo(0,0)")
                    page.screenshot(path=str(evidence / "studio-desktop.png"), full_page=True)
                    page.set_viewport_size({"width": 390, "height": 844})
                    page.screenshot(path=str(evidence / "studio-mobile.png"), full_page=True)
                    assert page.evaluate("document.documentElement.scrollWidth<=innerWidth"), "画面幅を超えています。"
                    page.on("dialog", lambda dialog: dialog.accept())
                    while page.locator("#jobs article").count():
                        before = page.locator("#jobs article").count()
                        page.locator("#jobs").get_by_role("button", name="削除", exact=True).first.click()
                        expect(page.locator("#jobs article")).to_have_count(before - 1)
                    assert not errors, errors
                    report["browser"] = {"success": True, "checks": ["実認証", "読み上げ制作", "音声再生", "MP3取得", "音声編集", "動画取込", "動画と音声と字幕の合成", "動画再生", "削除", "モバイル幅"], "pageErrors": errors}
                    browser.close()
            finally:
                if server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=5)


if __name__ == "__main__":
    main()
