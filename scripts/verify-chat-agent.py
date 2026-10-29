"""PythonのPlaywrightでPlan/Act・Web読取り・実ファイル操作を検証します。

認証情報は環境変数だけから読み、記録しません。既存Edgeを独立プロファイルで
起動します。ファイル操作の検証先は専用の一時ワークスペースだけに限定します。
"""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def main():
    # 日本語の結果をWindowsでもUTF-8で出力します。
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8788")
    parser.add_argument("--model", default="lmstudio/local-model")
    parser.add_argument("--local-image", help="利用者が指定した画像を読取り専用で検証する")
    args = parser.parse_args()
    url = urlsplit(args.base_url)
    if url.hostname not in ("127.0.0.1", "localhost") or url.scheme != "http" or url.username or url.password:
        parser.error("検証用ローカルサーバーを指定してください。")
    root = Path(__file__).resolve().parent.parent
    folder = root / "docs/evidence/20261006_control_plane" / ("chat-local-image-browser" if args.local_image else "chat-agent-browser")
    folder.mkdir(parents=True, exist_ok=True)
    result = {"baseUrl": args.base_url, "success": False, "checks": [], "pageErrors": []}
    step = "起動"
    try:
        with sync_playwright() as pw:
            # 利用者の保存認証や既存タブを変更しません。
            browser = pw.chromium.launch(channel="msedge", headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="ja-JP")
            page = context.new_page()
            page.on("pageerror", lambda error: result["pageErrors"].append(type(error).__name__))
            page.goto(args.base_url + "/#chat", wait_until="domcontentloaded")
            step = "ログイン"
            page.locator("#loginUser").fill(os.environ["WENTIAN_ADMIN_USERNAME"])
            page.locator("#loginPassword").fill(os.environ["WENTIAN_ADMIN_PASSWORD"])
            page.locator("#loginForm button").click()
            expect(page.locator("#chatModel")).to_contain_text(args.model, timeout=30000)
            page.locator("#chatModel").select_option(args.model)
            result["model"] = args.model
            if args.local_image:
                # 依頼された画像の明示パスだけを読み、原画像やBase64は証拠へ保存しません。
                image = Path(args.local_image)
                if not image.is_file():
                    raise RuntimeError("指定画像が存在しません。")
                step = "作業場所外のローカル画像読取り"
                page.locator("#chatMode").select_option("plan")
                page.locator("#chatInput").fill(f'"{image}"を開いて内容を説明してください。アプリ名と表示中のテーブル名を画像から確認してください。')
                page.locator("#chatSend").click()
                expect(page.locator("#chatStatus")).not_to_have_text("応答を受信中…", timeout=180000)
                result["lastStatus"] = page.locator("#chatStatus").inner_text()
                if result["lastStatus"] != "完了":
                    result["lastFailure"] = page.locator("#chatLog").inner_text()[-500:]
                    raise RuntimeError("画像読取りの会話が失敗しました。")
                expect(page.locator("#chatToolLog")).to_contain_text("成功: read_image")
                # 今回の指定スクリーンショットの実内容との一致を確認します。
                expect(page.locator("#chatLog")).to_contain_text("DBeaver")
                expect(page.locator("#chatLog")).to_contain_text("Application")
                result["checks"].append({"mode": "plan", "readImage": True, "outsideWorkspace": True, "actualContentVerified": True})
                page.evaluate("window.scrollTo(0,0)")
                page.screenshot(path=str(folder / "image.png"), full_page=True)
                result["success"] = not result["pageErrors"]
                browser.close()
                (folder / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 0 if result["success"] else 1
            capability = context.request.get(args.base_url + "/api/chat/capabilities").json()
            workspace = Path(capability["workspace"])
            # 実アプリや顧客ファイルへ試験書込みしないよう、一時環境と試験入力を検査します。
            if not workspace.name.startswith("wentian-visual-") or (workspace / "input.txt").read_text() != "WENTIAN_PLAN_READ_OK":
                raise RuntimeError("専用の試験ワークスペースではありません。")
            step = "Plan読取り"
            page.locator("#chatMode").select_option("plan")
            page.locator("#chatInput").fill("read_fileツールでinput.txtを読み、含まれる合言葉をそのまま回答してください。推測は禁止です。")
            page.locator("#chatSend").click()
            expect(page.locator("#chatStatus")).not_to_have_text("応答を受信中…", timeout=180000)
            result["lastStatus"] = page.locator("#chatStatus").inner_text()
            if result["lastStatus"] != "完了":
                result["lastFailure"] = page.locator("#chatLog").inner_text()[-500:]
                raise RuntimeError("会話の実行が失敗しました。")
            expect(page.locator("#chatToolLog")).to_contain_text("成功: read_file")
            expect(page.locator("#chatLog")).to_contain_text("WENTIAN_PLAN_READ_OK")
            result["checks"].append({"mode": "plan", "readFile": True})
            page.evaluate("window.scrollTo(0,0)")
            page.screenshot(path=str(folder / "plan.png"), full_page=True)
            step = "Act書込み"
            page.locator("#chatNew").click()
            page.locator("#chatMode").select_option("act")
            page.locator("#chatWritePaths").fill("output.txt")
            page.locator("#chatInput").fill("write_fileツールでoutput.txtにWENTIAN_ACT_WRITE_OKを正確に書いて、read_fileで読取り検証してください。")
            page.locator("#chatSend").click()
            expect(page.locator("#chatStatus")).not_to_have_text("応答を受信中…", timeout=180000)
            result["lastStatus"] = page.locator("#chatStatus").inner_text()
            if result["lastStatus"] != "完了":
                result["lastFailure"] = page.locator("#chatLog").inner_text()[-500:]
                raise RuntimeError("会話の実行が失敗しました。")
            expect(page.locator("#chatToolLog")).to_contain_text("成功: write_file")
            if (workspace / "output.txt").read_text().strip() != "WENTIAN_ACT_WRITE_OK":
                raise RuntimeError("実ファイルの内容が一致しません。")
            result["checks"].append({"mode": "act", "writeFile": True, "actualFileVerified": True})
            page.evaluate("window.scrollTo(0,0)")
            page.screenshot(path=str(folder / "act.png"), full_page=True)
            step = "Web読取り"
            page.locator("#chatNew").click()
            page.locator("#chatMode").select_option("plan")
            page.locator("#chatInput").fill("read_webツールでhttps://example.com/を実際に読み、ページ名と出典URLを回答してください。")
            page.locator("#chatSend").click()
            expect(page.locator("#chatStatus")).not_to_have_text("応答を受信中…", timeout=180000)
            result["lastStatus"] = page.locator("#chatStatus").inner_text()
            if result["lastStatus"] != "完了":
                result["lastFailure"] = page.locator("#chatLog").inner_text()[-500:]
                raise RuntimeError("会話の実行が失敗しました。")
            expect(page.locator("#chatToolLog")).to_contain_text("成功: read_web")
            expect(page.locator("#chatLog")).to_contain_text("Example Domain")
            result["checks"].append({"mode": "plan", "readWeb": True})
            page.evaluate("window.scrollTo(0,0)")
            page.screenshot(path=str(folder / "web.png"), full_page=True)
            step = "Web検索"
            page.locator("#chatNew").click()
            page.locator("#chatInput").fill("web_searchツールでEthereum公式ドキュメントを検索し、検索結果から1件のタイトルとURLを回答してください。")
            page.locator("#chatSend").click()
            expect(page.locator("#chatStatus")).not_to_have_text("応答を受信中…", timeout=180000)
            result["lastStatus"] = page.locator("#chatStatus").inner_text()
            if result["lastStatus"] != "完了":
                result["lastFailure"] = page.locator("#chatLog").inner_text()[-500:]
                raise RuntimeError("会話の実行が失敗しました。")
            expect(page.locator("#chatToolLog")).to_contain_text("成功: web_search")
            result["checks"].append({"mode": "plan", "webSearch": True})
            page.evaluate("window.scrollTo(0,0)")
            page.screenshot(path=str(folder / "search.png"), full_page=True)
            browser.close()
            result["success"] = not result["pageErrors"]
    except Exception as error:
        # 例外の全文には要求や認証情報が混じり得るため、工程と種類だけ保存します。
        result.update(failedStep=step, errorType=type(error).__name__)
    (folder / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
