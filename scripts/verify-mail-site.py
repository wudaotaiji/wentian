"""Python版プレイライト（Playwright）でサイト一覧・編集・表示・閉鎖を検証します。

利用者の保存データやログイン情報を変更しないよう、専用の一時作業領域と
ループバック（Loopback）の空きポートに検証サーバーを起動します。
実際の画面生成関数とサイト管理APIを使用し、ブラウザーでクリックして確認します。
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright


def main():
    # パスは本スクリプトから解決し、呼び出し元の作業ディレクトリには依存しません。
    root = Path(__file__).resolve().parents[1]
    evidence = root / "docs/evidence/mail-site/20261008"
    evidence.mkdir(parents=True, exist_ok=True)
    bun = root / "node_modules/@oven/bun-windows-x64/bin/bun.exe"
    with tempfile.TemporaryDirectory(prefix="wentian-mail-browser-") as work:
        # OSが選ぶ空きポートを使い、稼働中の8787番ポートには干渉しません。
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        # 検証専用の認証応答を使用します。本番の認証設定は変更しません。
        server_code = """
        import Fastify from 'fastify';
        import {managerDashboardHtml} from './src/dashboard.ts';
        import {registerSiteAdmin} from './src/public-site.ts';
        import {registerMailSolutions} from './src/mail-solutions.ts';
        import {provisionMailSite} from './src/mail-site.ts';
        import {MailOperationsService,registerMailOperations} from './src/mail-operations.ts';
        import {MailTrainingService,registerMailTraining} from './src/mail-training.ts';
        const app=Fastify();const workspace=process.env.MAIL_VERIFY_WORKSPACE;
        await provisionMailSite(workspace);
        const training=new MailTrainingService(workspace+'/training');
        registerMailTraining(app,()=>true,training);
        registerMailOperations(app,()=>true,new MailOperationsService(workspace+'/operations',training));
        registerSiteAdmin(app,{workspace,authorize:()=>true,gatewayOrigin:()=>process.env.MAIL_VERIFY_ORIGIN,design:async()=> '{}'});
        registerMailSolutions(app,()=>true);
        app.get('/',async(_req,reply)=>reply.type('text/html').send(managerDashboardHtml));
        app.get('/api/control-center/me',async()=>({user:{id:'verify',role:'admin',displayName:'検証用管理者'}}));
        app.get('/api/control-center/status',async()=>({needsSetup:false}));
        app.get('/*',async req=>{
          if(req.url.includes('agent-marketplace'))return {candidates:[]};
          if(req.url.includes('external-agents'))return {agents:[],summary:{}};
          if(req.url.includes('workbench/models'))return {models:[]};
          if(req.url==='/v1/models'||req.url==='/api/control-center/users')return [];
          return {};
        });
        await app.listen({host:'127.0.0.1',port:Number(process.env.MAIL_VERIFY_PORT)});
        """
        environment = {**os.environ, "MAIL_VERIFY_WORKSPACE": work,
                       "MAIL_VERIFY_PORT": str(port), "MAIL_VERIFY_ORIGIN": origin}
        with (evidence / "server.log").open("w", encoding="utf-8") as log:
            server = subprocess.Popen([str(bun), "-e", server_code], cwd=root,
                                      env=environment, stdout=log, stderr=subprocess.STDOUT)
            try:
                # サーバーの起動をHTTP応答で確認し、固定時間待ちによる不安定さを避けます。
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError("検証サーバーが起動前に終了しました。server.logを確認してください。")
                    try:
                        urllib.request.urlopen(origin, timeout=1).close()
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    raise RuntimeError("検証サーバーの起動がタイムアウトしました。")
                with sync_playwright() as playwright:
                    # 既存のMicrosoft Edgeを使用し、ブラウザーの新規インストールは行いません。
                    browser = playwright.chromium.launch(channel="msedge", headless=True)
                    context = browser.new_context(viewport={"width": 1440, "height": 1100})
                    page = context.new_page()
                    page.on("dialog", lambda dialog: dialog.accept())
                    page.goto(origin + "/#site-list")
                    link = page.locator('#siteList a[href="/sites/mail-solutions/"]')
                    link.wait_for(state="visible")
                    row = link.locator("..")
                    assert row.get_by_role("button", name="編集", exact=True).is_visible()
                    assert row.get_by_role("button", name="このサイト削除", exact=True).is_visible()
                    assert page.locator("#mailSolutionsManaged").count() == 0
                    page.screenshot(path=str(evidence / "site-list.png"), full_page=True)
                    row.get_by_role("button", name="編集", exact=True).click()
                    source = page.locator("#siteDocumentHtml")
                    source.wait_for(state="visible")
                    # 変更は検証用コピーのHTMLだけへ保存し、通常の保存・再読込経路を通します。
                    original = source.input_value()
                    changed = original.replace("Wentian Enterprise", "ブラウザー検証済み")
                    assert changed != original
                    source.fill(changed)
                    page.locator("#siteSave").click()
                    page.locator("#siteStatus").filter(has_text="保存して公開しました").wait_for()
                    assert source.input_value() == changed
                    page.screenshot(path=str(evidence / "site-editor.png"), full_page=True)
                    # 一覧のリンクをクリックし、別タブで正しいURLと保存後の画面が開くことを確認します。
                    page.goto(origin + "/#site-list")
                    with page.expect_popup() as popup:
                        page.locator('#siteList a[href="/sites/mail-solutions/"]').click()
                    opened = popup.value
                    opened.wait_for_load_state()
                    assert opened.url == origin + "/sites/mail-solutions/"
                    assert opened.locator(".tenant-name").inner_text() == "ブラウザー検証済み"
                    opened.locator("#language").select_option("ja")
                    assert opened.locator("html").get_attribute("lang") == "ja"
                    opened.locator('[data-page="pipeline"]').click()
                    opened.locator(".mail-train-panel").first.wait_for(state="visible")
                    opened.screenshot(path=str(evidence / "mail-solutions.png"), full_page=True)
                    # 閉鎖の操作対象は一時領域のコピーだけです。本番サイトは閉鎖しません。
                    page.locator('#siteList a[href="/sites/mail-solutions/"]').locator("..").get_by_role("button", name="このサイト削除", exact=True).click()
                    page.locator("#siteListStatus").filter(has_text="閉鎖しました").wait_for()
                    assert page.locator('#siteList a[href="/sites/mail-solutions/"]').count() == 0
                    assert context.request.get(origin + "/sites/mail-solutions/").status == 404
                    result={"status":"passed", "tool":"Python Playwright", "checks":["一覧リンクと編集・削除ボタン", "HTML全文の編集・保存・再読込", "一覧クリックで別タブ表示", "日本語切替と学習画面", "閉鎖後の一覧除去と404"], "productionSiteDeleted":False}
                    (evidence / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                    print(json.dumps(result, ensure_ascii=False))
                    browser.close()
            finally:
                # 自分で起動した検証サーバーだけを終了します。利用者のサーバーは対象外です。
                server.terminate()
                server.wait(timeout=15)


if __name__ == "__main__":
    main()
