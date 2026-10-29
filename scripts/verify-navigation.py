"""初回案内と目的別メニューを実ブラウザーで検証します。

アプリのHTML生成関数から検証用HTMLを作り、HTTP要求はブラウザー内で
模擬応答します。本番サーバーや認証情報、業務データには接続しません。
日本語・中国語、狭い画面、折りたたみと検索を確認して画像を保存します。
"""
import json
import subprocess
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    root = Path(__file__).resolve().parents[1]
    evidence = root / "docs/evidence/navigation/20261010"
    evidence.mkdir(parents=True, exist_ok=True)
    # 生成済み画面の実装を読み込み、APIを呼ぶ業務スクリプトは実行しません。
    # 表示設定とナビゲーションだけを残し、レイアウトと画面移動を検証します。
    generated = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e",
         "import {managerDashboardHtml as html} from './src/dashboard.ts';"
         "console.log(html.replace(/<script>([\\s\\S]*?)<\\/script>/g,"
         "(tag,code)=>code.includes('const entries=')||code.includes('const definitions=wb?')?tag:''));"],
        cwd=root, check=True, capture_output=True, encoding="utf-8",
    ).stdout
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/*", lambda route: route.fulfill(content_type="text/html", body=generated))
            page.goto("http://navigation.test/")
            # 認証処理を省いた検証用ページでのみ、認証フォームを隠します。
            page.locator("#login").evaluate("node => node.remove()")
            page.locator('.nav-view[data-view="home"]').wait_for(state="visible")
            assert page.locator(".welcome-cards a").count() == 3
            page.screenshot(path=str(evidence / "home-ja.png"), full_page=True)
            page.select_option("#language", "zh")
            assert "初次使用指南" in page.locator(".welcome-guide").inner_text()
            page.fill("#navSearch", "邮件")
            assert page.locator('#navResults a[href="/sites/mail-solutions/"]').is_visible()
            page.fill("#navSearch", "")
            page.screenshot(path=str(evidence / "home-zh.png"), full_page=True)
            page.evaluate("location.hash='overview'")
            controls = page.locator("#overviewControls")
            controls.wait_for(state="visible")
            assert controls.locator("#auto").is_checked()
            assert controls.locator("#refresh").is_visible()
            assert "每10秒自动刷新" in controls.inner_text()
            assert page.locator("header #refresh").count() == 0
            page.screenshot(path=str(evidence / "overview-refresh.png"), full_page=True)
            # 深い階層への直接移動でも、親メニューが全て開くことを確認します。
            page.evaluate("location.hash='evidence'")
            page.locator('.nav-view[data-view="evidence"]').wait_for(state="visible")
            assert page.locator('.nav-rail [data-view="evidence"]').is_visible()
            page.evaluate("location.hash='home'")
            page.set_viewport_size({"width": 390, "height": 844})
            page.locator('.nav-view[data-view="home"]').wait_for(state="visible")
            assert not page.locator("#navigationMenu").is_visible()
            page.locator("#navigationMenuToggle").check()
            assert page.locator("#navigationMenu").is_visible()
            page.locator("#navigationMenuToggle").uncheck()
            page.evaluate("scrollTo(0,0)")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path=str(evidence / "home-mobile.png"), full_page=True)
            assert not errors, errors
            (evidence / "result.json").write_text(json.dumps(
                {"passed": True, "liveAuthentication": False, "pageErrors": errors,
                 "checks": ["ホーム", "中国語", "メール検索", "深い直接リンク", "狭い画面の横はみ出し"]},
                ensure_ascii=False, indent=2), encoding="utf-8")
            print("画面検証が成功しました。証跡: " + str(evidence))
        finally:
            browser.close()


if __name__ == "__main__":
    main()
