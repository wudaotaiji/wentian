"""検証専用サーバーでサイト複製・Apache原本編集・削除を実ブラウザーから確認します。

実運用の8787番ポートには接続しません。テスト用フォルダーだけを変更し、
独立したEdgeプロファイルで動作を検証して証拠を保存します。
"""
import argparse
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def main():
    # 変更範囲を呼出側が作成した一時Apacheフォルダーへ限定します。
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    if "wentian-visual-" not in str(directory):
        parser.error("検証用の一時フォルダーだけを指定してください。")
    evidence = Path(__file__).resolve().parent.parent / "docs/evidence/20261007_site_creation"
    evidence.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        context = browser.new_context(viewport={"width":1440,"height":1000}, locale="ja-JP")
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto("http://127.0.0.1:8788/#site")
        page.locator("#loginUser").fill(os.environ["WENTIAN_ADMIN_USERNAME"])
        page.locator("#loginPassword").fill(os.environ["WENTIAN_ADMIN_PASSWORD"])
        page.locator("#loginForm button").click()
        expect(page.locator("#siteTemplates button")).to_have_count(4, timeout=30000)
        page.locator("#siteNewSlug").fill("Browser-Aurora")
        page.locator("#siteTemplates button").first.click()
        expect(page.locator("#sitePage")).to_have_value("browser-aurora", timeout=30000)
        expect(page.locator("#siteStatus")).to_contain_text("テンプレートから")
        expect(page.locator("#siteTemplateStatus")).to_contain_text("準備ができました")
        expect(page.locator('#siteList a[href="/sites/browser-aurora/"]')).to_be_visible()
        # 保存後に同じポートの公開リンクを開き、実データの更新を検収します。
        page.locator("#siteTitle").fill("ブラウザー公開検証")
        page.locator("#siteSave").click()
        expect(page.locator("#siteStatus")).to_contain_text("保存して公開しました")
        page.locator('.nav-rail [data-view="site-list"]').click()
        with page.expect_popup() as popup:
            page.locator('#siteList a[href="/sites/browser-aurora/"]').click()
        published = popup.value
        expect(published).to_have_title("ブラウザー公開検証")
        assert published.url == "http://127.0.0.1:8788/sites/browser-aurora/"
        published.close()
        page.screenshot(path=str(evidence / "templates.png"), full_page=True)
        # 書き出し結果をブラウザーと実ファイルの両方で検収します。
        page.locator("#siteExport").click()
        expect(page.locator("#siteSourcePath")).to_contain_text("index.html")
        sources = list(directory.parent.glob(".wentian/sites/pages/browser-aurora/revision-*/index.html"))
        assert sources and any("ブラウザー公開検証" in source.read_text(encoding="utf-8") for source in sources)
        preview = context.new_page()
        preview.goto(sources[-1].as_uri())
        expect(preview.locator("h1")).to_contain_text("次の可能性")
        preview.screenshot(path=str(evidence / "aurora-desktop.png"), full_page=True)
        preview.set_viewport_size({"width":390,"height":844})
        preview.screenshot(path=str(evidence / "aurora-mobile.png"), full_page=True)
        assert preview.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.locator('.nav-rail [data-view="site"]').click()
        page.locator("#siteExternalEditor summary").click()
        page.locator("#siteDirectory").fill(str(directory))
        page.locator("#siteConnect").click()
        expect(page.locator("#siteExternalCode")).to_have_value("<h1>APACHE_ORIGINAL</h1>")
        page.locator("#siteExternalCode").fill("<h1>APACHE_UPDATED</h1>")
        page.locator("#siteExternalSave").click()
        expect(page.locator("#siteExternalStatus")).to_contain_text("バックアップ")
        assert (directory / "index.html").read_text(encoding="utf-8") == "<h1>APACHE_UPDATED</h1>"
        backups = list(directory.parent.glob(".wentian/site-file-backups/*/index.html"))
        assert any(file.read_text(encoding="utf-8") == "<h1>APACHE_ORIGINAL</h1>" for file in backups)
        page.screenshot(path=str(evidence / "external-editor.png"), full_page=True)
        # サイトの削除確認ダイアログは、このテストが作成したサイトだけに同意します。
        page.on("dialog", lambda dialog: dialog.accept())
        # サブメニュー（Submenu）へ移動し、検証用サイトの行だけを閉鎖します。
        page.locator('.nav-rail [data-view="site-list"]').click()
        target = page.locator('#siteList p').filter(has=page.locator('a[href="/sites/browser-aurora/"]'))
        target.get_by_role("button", name="このサイト削除", exact=True).click()
        expect(page.locator("#siteListStatus")).to_contain_text("閉鎖しました", timeout=30000)
        assert page.locator('#sitePage option[value="browser-aurora"]').count() == 0
        assert not errors, errors
        (evidence / "report.json").write_text(json.dumps({"success":True,"checks":["4テンプレート","大文字URLから複製","編集準備完了","作成済みサイト一覧","保存後に同一ポートの公開リンクを開く","独立HTML表示","モバイル表示","Apache原本編集","原本バックアップ","サイト削除"],"pageErrors":errors},ensure_ascii=False,indent=2),encoding="utf-8")
        browser.close()


if __name__ == "__main__":
    main()
