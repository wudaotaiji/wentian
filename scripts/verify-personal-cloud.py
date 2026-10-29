"""Personal Cloudの隔離検証（Verification）。実運用の設定・認証・8787番ポートを使いません。

--dockerはDocker統合試験、--browserは実Edgeによる画面試験を追加します。
生成する認証値とSQLite台帳は一時フォルダー内に限定し、秘密値を証拠へ保存しません。
Docker試験の削除対象はテストが作成したWentian管理ラベル付きコンテナだけです。
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
    parser.add_argument("--docker", action="store_true")
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--browser-only", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    evidence = root / "docs/evidence/personal-cloud/20261007"
    evidence.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    if not args.browser_only:
        # 画面試験と型検査は分けて記録し、自動試験の成功を画面成功と解釈しません。
        commands = [["node", "node_modules/typescript/bin/tsc", "--noEmit"],
                    ["node", "--import", "tsx", "--import", "./src/test-environment.ts", "--test", "src/personal-cloud.test.ts", "src/cli-runtime.test.ts", "src/navigation-ui.test.ts"]]
        if args.docker:
            env["WENTIAN_CLOUD_DOCKER_TEST"] = "true"
            commands.append(["node", "--import", "tsx", "--import", "./src/test-environment.ts", "--test", "src/personal-cloud.integration.test.ts"])
        for index, command in enumerate(commands):
            with (evidence / f"checks-{index}.log").open("w", encoding="utf-8") as log:
                result = subprocess.run(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=360)
            if result.returncode:
                raise RuntimeError(f"検証が失敗しました。checks-{index}.logを確認してください。")
    if not (args.browser or args.browser_only):
        print("型検査と指定した自動試験が成功しました。")
        return
    from playwright.sync_api import sync_playwright, expect
    # 空きポートを探索し、検証用サーバーが実運用サーバーと競合しないようにします。
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="wentian-cloud-browser-") as temporary:
        work = Path(temporary)
        username = "cloud-test-admin"
        password = secrets.token_urlsafe(32)
        env.update({"PORT": str(port), "WENTIAN_HOST": "127.0.0.1", "WENTIAN_ENV_FILE": str(work / "unused.env"),
                    "WENTIAN_USER_STORE": str(work / "users.json"), "WENTIAN_CLOUD_STORE": str(work / "cloud.sqlite"),
                    "WENTIAN_ADMIN_USERNAME": username, "WENTIAN_ADMIN_PASSWORD": password,
                    "WENTIAN_EVENT_STORE": str(work / "events.jsonl"), "WENTIAN_SCHEDULE_ROOT": str(work / "schedules"),
                    "WENTIAN_AGENT_CONNECTION_MAINTENANCE": "false", "WENTIAN_NODE_HOME": str(work / "node")})
        # 本番APIキーを検証環境へ引き継ぎません。ログには認証本文を出力しないサーバーを使います。
        env.pop("WENTIAN_API_KEY", None)
        log = (work / "server.log").open("w", encoding="utf-8")
        server = subprocess.Popen(["node", "--import", (root / "node_modules/tsx/dist/loader.mjs").as_uri(), str(root / "src/server.ts")], cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT)
        agent = None
        base = f"http://127.0.0.1:{port}"
        errors = []
        try:
            for _ in range(120):
                if server.poll() is not None:
                    raise RuntimeError("検証用サーバーが終了しました。")
                try:
                    urllib.request.urlopen(base + "/health", timeout=1)
                    break
                except Exception:
                    time.sleep(0.25)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="msedge", headless=True)
                page = browser.new_page(viewport={"width": 1440, "height": 1000}, locale="ja-JP")
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.goto(base + "/personal-cloud")
                page.locator("#username").fill(username)
                page.locator("#password").fill(password)
                page.locator("#loginForm button").click()
                expect(page.locator("#content")).to_be_visible()
                page.locator("#nodeName").fill("ブラウザー検証PC")
                page.locator("#enrollForm button").click()
                expect(page.locator("#enrollInstructions")).to_be_visible()
                # 登録コードは一時環境変数で子プロセスへ渡し、コマンドラインへ埋め込みません。
                instructions = page.locator("#enrollInstructions").inner_text()
                code = instructions.split("：", 1)[1].splitlines()[0]
                env["WENTIAN_NODE_ENROLL_CODE"] = code
                command = ["node", "--import", "tsx", str(root / "src/cli.ts"), "node", "enroll", "--server", base]
                enrollment = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True, timeout=45)
                if enrollment.returncode:
                    raise RuntimeError("検証用Agentの登録に失敗しました。")
                env.pop("WENTIAN_NODE_ENROLL_CODE", None)
                # スクリーンショットへ一時コードを残さないよう、表示を閉じてから保存します。
                page.locator("#enrollInstructions").evaluate("element => element.hidden=true")
                page.locator("#refresh").click()
                page.on("dialog", lambda dialog: dialog.accept())
                page.get_by_role("button", name="この端末を承認").click()
                expect(page.locator("#nodes")).to_contain_text("offline")
                agent = subprocess.Popen(["node", "--import", "tsx", str(root / "src/cli.ts"), "node", "run"], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
                expect(page.locator("#nodes")).to_contain_text("online", timeout=60000)
                page.locator("#appName").fill("配置確認用")
                page.locator("#image").fill("nginxinc/nginx-unprivileged:alpine")
                page.locator("#containerPort").fill("8080")
                page.locator("#healthPath").fill("/")
                page.locator("#memory").fill("64")
                page.locator("#placement").click()
                expect(page.locator("#candidates")).to_contain_text("配置可能", timeout=15000)
                # 実際の画面から配備・停止・再開・削除を行い、API試験とは別の証拠にします。
                page.locator("#deploy").click()
                expect(page.locator("#apps article")).to_have_attribute("data-state", "ready", timeout=90000)
                page.locator("#apps").get_by_role("button", name="停止", exact=True).click()
                expect(page.locator("#apps article")).to_have_attribute("data-state", "stopped", timeout=45000)
                page.locator("#apps").get_by_role("button", name="起動", exact=True).click()
                expect(page.locator("#apps article")).to_have_attribute("data-state", "ready", timeout=45000)
                page.screenshot(path=str(evidence / "cloud-desktop.png"), full_page=True)
                page.set_viewport_size({"width": 390, "height": 844})
                page.screenshot(path=str(evidence / "cloud-mobile.png"), full_page=True)
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "画面幅を超えています。"
                assert not errors, errors
                page.locator("#apps").get_by_role("button", name="アプリ削除", exact=True).click()
                expect(page.locator("#apps article")).to_have_attribute("data-state", "deleted", timeout=45000)
                (evidence / "browser-report.json").write_text(json.dumps({"success": True, "checks": ["ログイン", "1回限りの端末登録", "管理者承認", "実Agentの生存報告", "実Dockerの診断", "配置候補", "画面から配備・停止・起動・削除", "デスクトップとモバイル幅"], "pageErrors": errors}, ensure_ascii=False, indent=2), encoding="utf-8")
                browser.close()
        finally:
            # 検証で起動したプロセスだけを終了します。本番プロセスの検索・一括停止は行いません。
            for process in [agent, server]:
                if process is not None and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
            log.close()
    print("実ブラウザーで端末登録・診断・配置候補を確認しました。")


if __name__ == "__main__":
    main()
