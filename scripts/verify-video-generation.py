"""動画生成の隔離検証（Verification）。実際の作品・認証・8787番ポートは使いません。

既定は型検査と単体試験のみです。--inferenceは小型ランダムLTXモデルを取得して
CPUで文章・画像から実推論し、MP4をエンコード・デコードします。
--browserは実サーバー・実ワーカーをEdgeで操作し、再生とダウンロードを確認します。
小型モデルの結果を本番モデルの画質やGPU動作の証拠にはしません。
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inference", action="store_true")
    parser.add_argument("--browser", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    evidence = root / "docs/evidence/video-generation/20261007"
    evidence.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    # 本番データを使わない試験入口を明示し、結果は独立したログへ保存します。
    commands = [["node", "node_modules/typescript/bin/tsc", "--noEmit"], ["node", "--import", "tsx", "--import", "./src/test-environment.ts", "--test", "src/video-generation.test.ts", "src/navigation-ui.test.ts", "src/server.test.ts"]]
    for index, command in enumerate(commands):
        with (evidence / f"checks-{index}.log").open("w", encoding="utf-8") as log:
            result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
        if result.returncode:
            raise RuntimeError(f"検証が失敗しました。checks-{index}.logを確認してください。")
    if not (args.inference or args.browser):
        print("動画生成の型検査と関連自動試験が成功しました。")
        return
    python = Path(env.get("WENTIAN_VIDEO_PYTHON", str(root / ".wentian/video-engine" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))))
    model = root / ".wentian/video-verification/model"
    model.mkdir(parents=True, exist_ok=True)
    # 検証専用モデルは本番モデルと別保存先に置き、公開リポジトリーを認証なしで取得します。
    code = "from huggingface_hub import HfApi,snapshot_download; import pathlib,sys,json; repo='optimum-intel-internal-testing/tiny-random-ltx-video'; revision=HfApi().model_info(repo,token=False).sha; snapshot_download(repo,revision=revision,local_dir=sys.argv[1],token=False,allow_patterns=['model_index.json','scheduler/*','tokenizer/*','text_encoder/*','transformer/*','vae/*']); pathlib.Path(sys.argv[1],'wentian-model.json').write_text(json.dumps({'repository':repo,'revision':revision,'verificationOnly':True}),encoding='utf-8')"
    subprocess.run([str(python), "-c", code, str(model)], cwd=root, env=env, check=True, timeout=180)
    env.update({"WENTIAN_VIDEO_PYTHON": str(python), "WENTIAN_VIDEO_MODEL_PATH": str(model), "WENTIAN_VIDEO_DEVICE": "cpu", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    # 生成と復号を同じ専用環境で実行します。ライブラリを既存Pythonへ混入させません。
    image_code = "from PIL import Image; import sys; Image.new('RGB',(256,256),(40,80,120)).save(sys.argv[1],format='PNG')"
    video_code = "import imageio.v2 as i,sys,json; r=i.get_reader(sys.argv[1]); f=r.get_data(0); print(json.dumps({'shape':list(f.shape),'fps':r.get_meta_data()['fps']})); r.close()"
    request = {"prompt": "Verification only: a landscape", "negativePrompt": "", "width": 256, "height": 256, "frames": 9, "fps": 8, "steps": 2, "seed": 42}
    report = {"verificationModel": True, "device": "cpu", "productionQualityVerified": False, "gpuVerified": False, "inference": []}
    with tempfile.TemporaryDirectory(prefix="wentian-video-inference-") as temporary:
        for kind in ["text", "image"]:
            work = Path(temporary) / kind
            work.mkdir()
            (work / "request.json").write_text(json.dumps(request), encoding="utf-8")
            if kind == "image":
                subprocess.run([str(python), "-c", image_code, str(work / "input.image")], check=True, env=env)
            with (evidence / f"{kind}-inference.log").open("w", encoding="utf-8") as log:
                result = subprocess.run([str(python), str(root / "scripts/video-worker.py"), "--job", str(work)], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=180)
            if result.returncode:
                raise RuntimeError(f"CPUの{kind}動画推論が失敗しました。ログを確認してください。")
            output = work / "output.mp4"
            decoded = json.loads(subprocess.check_output([str(python), "-c", video_code, str(output)], env=env, text=True))
            assert decoded["shape"][:2] == [256, 256], decoded
            assert decoded["fps"] == 8, decoded
            (evidence / f"verification-{kind}.mp4").write_bytes(output.read_bytes())
            report["inference"].append({"kind": kind, "success": True, "decoded": decoded, "bytes": output.stat().st_size})
    if args.browser:
        browser_check(root, python, evidence, env, report)
    (evidence / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("CPUによる文章・画像の実推論とMP4保存・復号を確認しました。検証用モデルのため画質評価は対象外です。")


def browser_check(root, python, evidence, env, report):
    """実画面（Browser）から生成し、認証されたMP4の再生と取得を確認します。"""
    from playwright.sync_api import sync_playwright, expect
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="wentian-video-browser-") as temporary:
        work = Path(temporary)
        username, password = "video-test-admin", secrets.token_urlsafe(32)
        env.update({"PORT": str(port), "WENTIAN_HOST": "127.0.0.1", "WENTIAN_ENV_FILE": str(work / "unused.env"), "WENTIAN_USER_STORE": str(work / "users.json"), "WENTIAN_ADMIN_USERNAME": username, "WENTIAN_ADMIN_PASSWORD": password, "WENTIAN_VIDEO_ROOT": str(work / "videos"), "WENTIAN_MEDIA_ROOT": str(work / "media"), "WENTIAN_MEDIA_MODEL_MAINTENANCE": "false", "WENTIAN_CLOUD_STORE": str(work / "cloud.sqlite"), "WENTIAN_EVENT_STORE": str(work / "events.jsonl"), "WENTIAN_GOAL_PATH": str(work / "goals"), "WENTIAN_SCHEDULE_ROOT": str(work / "schedules"), "WENTIAN_AGENT_CONNECTION_MAINTENANCE": "false"})
        env.pop("WENTIAN_API_KEY", None)
        log = (work / "server.log").open("w", encoding="utf-8")
        server = subprocess.Popen(["node", "--import", (root / "node_modules/tsx/dist/loader.mjs").as_uri(), str(root / "src/server.ts")], cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
        base = f"http://127.0.0.1:{port}"
        try:
            for _ in range(90):
                try:
                    urllib.request.urlopen(base + "/health", timeout=1).close()
                    break
                except Exception:
                    if server.poll() is not None:
                        raise RuntimeError("隔離した検証サーバーの起動に失敗しました。")
                    time.sleep(1)
            with sync_playwright() as p:
                browser = p.chromium.launch(channel="msedge", headless=True)
                page = browser.new_page(viewport={"width": 1440, "height": 1000})
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base + "/videos")
                page.locator("#username").fill(username)
                page.locator("#password").fill(password)
                page.locator("#loginForm").get_by_role("button", name="ログイン").click()
                expect(page.locator("#readiness")).to_contain_text("cpu", timeout=60000)
                page.locator("#prompt").fill("検証専用ランダムモデル・本番画質の評価対象外")
                page.locator("#steps").fill("2")
                page.get_by_text("詳細設定", exact=True).click()
                page.locator("#seed").fill("42")
                page.locator("#generate").click()
                expect(page.locator("#jobs article")).to_have_attribute("data-status", "succeeded", timeout=180000)
                video = page.locator("video")
                expect(video).to_be_visible()
                # メタデータの取得だけでなく、実際にフレームを再生できることを確認します。
                video.evaluate("async v => {v.muted=true; await v.play()}")
                page.wait_for_function("document.querySelector('video').currentTime > 0")
                with page.expect_download() as download_event:
                    page.get_by_role("link", name="MP4をダウンロード").click()
                download = download_event.value
                download.save_as(str(evidence / "browser-download.mp4"))
                page.evaluate("window.scrollTo(0,0)")
                page.wait_for_function("window.scrollY === 0")
                page.screenshot(path=str(evidence / "video-desktop.png"), full_page=True)
                page.set_viewport_size({"width": 390, "height": 844})
                page.evaluate("window.scrollTo(0,0)")
                page.wait_for_function("window.scrollY === 0")
                page.screenshot(path=str(evidence / "video-mobile.png"), full_page=True)
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "画面幅を超えています。"
                page.on("dialog", lambda dialog: dialog.accept())
                page.locator("#jobs").get_by_role("button", name="削除", exact=True).click()
                expect(page.locator("#jobs article")).to_have_count(0)
                assert not errors, errors
                report["browser"] = {"success": True, "checks": ["実認証", "CPU生成", "進捗と完了表示", "MP4再生", "ダウンロード", "削除", "デスクトップとモバイル幅"], "pageErrors": errors}
                browser.close()
        finally:
            # 自分で起動したサーバーだけを終了します。実運用のプロセスは操作しません。
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
            log.close()


if __name__ == "__main__":
    main()
