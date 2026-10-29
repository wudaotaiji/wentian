"""Python Playwrightでメール業務と実BusinessRecordsの結合を検証します。

両アプリとも一時データベースを使用し、利用者のメールや共有データを変更しません。
BusinessRecordsは指定された実装をそのまま読み込み、保存先とポートだけを分離します。
"""
import ast
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.request

from playwright.sync_api import sync_playwright


def free_port():
    # OSが選んだ空きポートを使い、稼働中のアプリと競合しないようにします。
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def initial_sales(path):
    """初期アカウントを構文木から取得し、認証値をログへ出力しません。"""
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    for node in ast.walk(tree):
        if isinstance(node, (ast.List, ast.Tuple)):
            try:
                values = ast.literal_eval(node)
            except (ValueError, TypeError):
                continue
            if isinstance(values, (list, tuple)):
                for item in values:
                    if isinstance(item, (list, tuple)) and len(item) == 6 and item[1] == "sales":
                        # 実装ではID, username, display_name, role, email, passwordの順です。
                        return item[1], item[-1]
    raise RuntimeError("BusinessRecordsの初期アカウント定義が見つかりません。")


def main():
    root = Path(__file__).resolve().parents[1]
    evidence = root / "docs/evidence/mail-operations/20261008"
    evidence.mkdir(parents=True, exist_ok=True)
    # 外部実装の場所は利用者が指定し、特定組織の配備先を参照しません。
    if not os.environ.get("WENTIAN_BUSINESS_RECORDS_SCRIPT"):
        raise RuntimeError("WENTIAN_BUSINESS_RECORDS_SCRIPT を設定してください。")
    ses_path = Path(os.environ["WENTIAN_BUSINESS_RECORDS_SCRIPT"])
    username, password = initial_sales(ses_path)
    with tempfile.TemporaryDirectory(prefix="mail-operations-browser-") as temporary:
        work = Path(temporary)
        # 実BusinessRecordsモジュールのデータ保存先のみを一時領域へ差し替えます。
        spec = importlib.util.spec_from_file_location("mail_verify_ses", ses_path)
        ses = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ses)
        ses.DATA_DIR = work / "ses"
        ses.DB_PATH = ses.DATA_DIR / "state.sqlite3"
        ses.initialize_database()
        server_class = getattr(ses, "ThreadingServer", None) or ses.http.server.ThreadingHTTPServer
        ses_server = server_class(("127.0.0.1", 0), ses.Handler)
        thread = threading.Thread(target=ses_server.serve_forever, daemon=True)
        thread.start()
        ses_origin = f"http://127.0.0.1:{ses_server.server_port}"
        port = free_port()
        origin = f"http://127.0.0.1:{port}"
        server_code = """
        import Fastify from 'fastify';
        import {provisionMailSite} from './src/mail-site.ts';
        import {registerSiteAdmin} from './src/public-site.ts';
        import {MailTrainingService,registerMailTraining} from './src/mail-training.ts';
        import {MailOperationsService,registerMailOperations} from './src/mail-operations.ts';
        const app=Fastify(),workspace=process.env.MAIL_VERIFY_WORKSPACE;
        await provisionMailSite(workspace);
        const training=new MailTrainingService(workspace+'/training');
        registerMailTraining(app,()=>true,training);
        registerMailOperations(app,()=>true,new MailOperationsService(workspace+'/operations',training));
        registerSiteAdmin(app,{workspace,authorize:()=>true,gatewayOrigin:()=>process.env.MAIL_VERIFY_ORIGIN,design:async()=> '{}'});
        await app.listen({host:'127.0.0.1',port:Number(process.env.MAIL_VERIFY_PORT)});
        """
        environment = {**os.environ, "MAIL_VERIFY_WORKSPACE": str(work),
                       "MAIL_VERIFY_PORT": str(port), "MAIL_VERIFY_ORIGIN": origin,
                       "WENTIAN_MAIL_SES_PASSWORD": password,
                       "WENTIAN_MAIL_TRAINING_PYTHON": str(root / ".wentian/mail-engine/Scripts/python.exe")}
        with (evidence / "server.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([str(root / "node_modules/@oven/bun-windows-x64/bin/bun.exe"), "-e", server_code], cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    try:
                        urllib.request.urlopen(origin + "/api/mail-operations", timeout=1).close()
                        break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError("メール検証サーバーの起動に失敗しました。")
                        time.sleep(0.1)
                else:
                    raise RuntimeError("メール検証サーバーが応答しません。")
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(channel="msedge", headless=True)
                    page = browser.new_page(viewport={"width": 1440, "height": 1100})
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("dialog", lambda dialog: dialog.accept())
                    page.goto(origin + "/sites/mail-solutions/")
                    page.locator("#language").select_option("ja")
                    page.locator('[data-page="sources"]').click()
                    page.locator("#mailSourceName").fill("画面検証用EML")
                    page.locator("#mailLiveSourceEditor").get_by_role("button", name="確認内容を保存", exact=True).click()
                    page.locator("#mailLiveSourceList").get_by_role("heading", name="画面検証用EML").wait_for()
                    raw = ("From: verify@example.invalid\r\nSubject: Candidate available\r\n"
                           "Content-Type: text/plain; charset=utf-8\r\n\r\n"
                           "Name: Browser Candidate\r\nSkills: Python, SQL\r\nRate: 80\r\n"
                           "Availability: 2026-11-01\r\nExperience: 5\r\n")
                    page.locator("#mailLiveEml").set_input_files({"name": "verify.eml", "mimeType": "message/rfc822", "buffer": raw.encode()})
                    page.locator("#sources").get_by_role("button", name="EMLを取り込む", exact=True).click()
                    page.locator("#mailLiveGlobal").filter(has_text="取り込みました").wait_for()
                    page.locator('[data-page="inbox"]').click()
                    page.locator("#mailLiveSearch").fill("Candidate")
                    page.locator("#mailLiveInboxTable tbody tr").first.click()
                    detail = page.locator("#mailLiveReviewDetail")
                    detail.get_by_role("button", name="分類・抽出する", exact=True).click()
                    page.wait_for_function("document.querySelector('#mailLiveField-name').value === 'Browser Candidate'")
                    for key, value in {"type": "BP", "status": "提案可能", "role": "開発", "owner": "営業確認担当"}.items():
                        page.locator("#mailLiveBusiness-" + key).fill(value)
                    detail.get_by_role("button", name="確認内容を保存", exact=True).click()
                    detail.get_by_role("button", name="確認済み項目を登録待ちへ", exact=True).wait_for()
                    page.screenshot(path=str(evidence / "review.png"), full_page=True)
                    detail.get_by_role("button", name="確認済み項目を登録待ちへ", exact=True).click()
                    page.locator("#mailLiveGlobal").filter(has_text="保存しました").wait_for()
                    page.locator('[data-page="integrations"]').click()
                    page.locator("#mailSesBase").fill(ses_origin)
                    page.locator("#mailSesUsername").fill(username)
                    page.locator("#mailSesEnabled").check()
                    with page.expect_response(lambda response: response.url.endswith('/api/mail-operations/settings') and response.request.method == 'POST'):
                        page.get_by_role("button", name="接続設定を保存", exact=True).click()
                    page.wait_for_function("document.querySelector('#mailLiveGlobal').textContent === '保存しました。'")
                    # 接続検査はログインと読み取りのみで、業務レコードを追加しません。
                    checked = page.request.post(origin + "/api/mail-operations/connections/ses/test", data={})
                    assert checked.ok, checked.text()
                    page.locator('[data-page="extraction"]').click()
                    page.get_by_role("button", name="登録先へ送信", exact=True).click()
                    page.wait_for_function("document.querySelector('#extraction').textContent.includes('登録済み')")
                    page.screenshot(path=str(evidence / "registered.png"), full_page=True)
                    jobs = page.request.get(origin + "/api/mail-operations/outbox").json()["items"]
                    assert len(jobs) == 1 and jobs[0]["status"] == "registered", jobs
                    duplicate = page.request.post(origin + "/api/mail-operations/outbox/" + jobs[0]["id"] + "/send", data={"revision": jobs[0]["revision"]})
                    assert duplicate.status == 400
                    with sqlite3.connect(ses.DB_PATH) as database:
                        state = json.loads(database.execute("SELECT payload FROM app_state WHERE id=1").fetchone()[0])
                        assert sum(item.get("wentianJobId") == jobs[0]["id"] for item in state["engineers"]) == 1
                    # sqlite3のコンテキストは取引だけを閉じるため、Windowsのファイルロックも解放します。
                    database.close()
                    # テスト専用例で実学習・独立評価・有効化・推論の経路を確認します。
                    runs = []
                    for task in ("classification", "extraction"):
                        examples = []
                        for index in range(16):
                            kind = "personnel" if index % 2 == 0 else "project"
                            label = ["normal", "normal.personnel", "normal.personnel.business_app"] if kind == "personnel" else ["normal", "normal.project", "normal.project.open"]
                            field = "name" if kind == "personnel" else "title"
                            value = f"Test{index}"
                            examples.append({"mail_id": f"fixture-{index}", "thread_id": f"thread-{index}", "duplicate_group_id": f"dup-{index}", "subject": "Candidate available Python SQL" if kind == "personnel" else "Project engineers needed Java AWS", "body": ("Name: " if kind == "personnel" else "Project: ") + value + "\nSkills: Python, SQL\n", "reviewed": True, "split": "train" if index < 12 else "evaluation", "label_path": label, "kind": kind, "fields": {field: value, "skills": "Python, SQL"}})
                        response = page.request.post(origin + "/api/mail-training/examples", data={"task": task, "examples": examples})
                        assert response.ok, response.text()
                        response = page.request.post(origin + "/api/mail-training/runs", data={"task": task})
                        assert response.ok, response.text()
                        run = response.json()
                        for _ in range(300):
                            status = page.request.get(origin + "/api/mail-training").json()
                            completed = next(item for item in status["runs"] if item["id"] == run["id"])
                            if completed["status"] != "running":
                                break
                            time.sleep(0.2)
                        assert completed["status"] == "succeeded", completed
                        response = page.request.post(origin + "/api/mail-training/active", data={"task": task, "id": run["id"]})
                        assert response.ok, response.text()
                        response = page.request.post(origin + "/api/mail-training/predict", data={"task": task, "kind": "personnel", "subject": "Candidate available Python SQL", "body": "Name: InferenceTest\nSkills: Python, SQL\n"})
                        assert response.ok, response.text()
                        runs.append({"task": task, "report": completed["report"]})
                    for language in ("en", "zh-CN", "fr", "de", "ja"):
                        page.locator("#language").select_option(language)
                        assert page.locator("html").get_attribute("lang") == language
                    assert not errors, errors
                    result = {"status": "passed", "browser": "Python Playwright / Edge", "sesApplication": str(ses_path.parent.parent), "checks": ["EML取り込み", "検索", "分類・抽出", "人手確認", "登録待ち", "実BusinessRecordsへの登録", "二重登録防止", "5言語切替", "分類・抽出の実学習と独立評価・有効化・推論"], "trainingFixturesOnly": True, "training": runs, "productionDataModified": False}
                    (evidence / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                    print(json.dumps({"status": "passed", "checks": result["checks"]}, ensure_ascii=False))
                    browser.close()
            finally:
                process.terminate()
                process.wait(timeout=15)
                ses_server.shutdown()
                ses_server.server_close()


if __name__ == "__main__":
    main()
