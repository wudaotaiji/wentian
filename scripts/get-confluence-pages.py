# CONFLUENCE_BROWSER_PATH で既存ブラウザー（Browser）の実行ファイルを指定できます。認証情報は環境変数で渡し、保存しません。
"""
Confluence のログイン付きページを Playwright で取得する Python スクリプトです。

目的:
- pageId 一覧を指定して、タイトル・最終 URL・本文・候補リンクを JSON に保存する
- Python からも同じ Playwright 手順を再利用できるようにする

実装方針:
- 実ブラウザ制御は Node.js + Playwright で行います
- このスクリプトは、一時 JavaScript を生成して node へ渡すラッパーです
"""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    """コマンドライン引数を解析します。"""
    parser = argparse.ArgumentParser(
        description="Confluence の pageId 一覧を Playwright で取得し、JSON へ保存します。"
    )
    parser.add_argument("--username", default=os.environ.get("CONFLUENCE_USERNAME"))
    parser.add_argument("--password", default=os.environ.get("CONFLUENCE_PASSWORD"))
    parser.add_argument("--page-ids", nargs="+", required=True, type=int)
    parser.add_argument(
        "--output-path",
        default=str(Path.cwd() / "confluence-pages.json"),
        help="結果 JSON の出力先です。",
    )
    parser.add_argument(
        "--project-root",
        default=str(Path(__file__).resolve().parent.parent),
        help="playwright パッケージが入っているプロジェクトのルートです。",
    )
    parser.add_argument("--base-url", default=os.environ.get("WENTIAN_CONFLUENCE_BASE_URL", ""), help="Confluence のベース URL です。")
    return parser.parse_args()


def build_node_script() -> str:
    """Node.js で実行する Playwright スクリプト本文を返します。"""
    return r"""
const fs = require("fs");
const { chromium } = require("playwright");

const username = process.env.CONF_USERNAME;
const password = process.env.CONF_PASSWORD;
const pageIds = (process.env.CONF_PAGE_IDS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);
const outputPath = process.env.CONF_OUTPUT_PATH;
  const baseUrl = (process.env.WENTIAN_CONFLUENCE_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("WENTIAN_CONFLUENCE_BASE_URL を指定してください。");

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CONFLUENCE_BROWSER_PATH || undefined });
  // 保存済み認証状態（Storage State）を指定した場合、同じセッションで取得します。
  const context = await browser.newContext(process.env.CONFLUENCE_STORAGE_STATE ? { storageState: process.env.CONFLUENCE_STORAGE_STATE } : {});
  const page = await context.newPage();
  const results = [];

  try {
    const firstPageUrl = `${baseUrl}/pages/viewpage.action?pageId=${pageIds[0]}`;

    await page.goto(firstPageUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    if (!process.env.CONFLUENCE_STORAGE_STATE) {
    await page.fill("#os_username", username);
    await page.fill("#os_password", password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
      page.locator("#os_password").press("Enter")
    ]);

    }
    await page.waitForURL(u => !u.pathname.includes("login.action"), { timeout: 30000 }).catch(() => {});
    if (page.url().includes("login.action")) throw new Error("Confluence本文に到達できませんでした（ログイン画面）。認証・権限・セッションは未確定: " + await page.locator("body").innerText());
    // 認証状態を明示されたローカル領域だけへ保存し、次回の認証を再利用します。
    if (process.env.CONFLUENCE_SAVE_STATE) await context.storageState({ path: process.env.CONFLUENCE_SAVE_STATE });
    for (const pageId of pageIds) {
      const targetUrl = `${baseUrl}/pages/viewpage.action?pageId=${pageId}`;

      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 120000 }).catch(async () => {
        await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      });

      // ページごとにログイン画面への戻りを検査し、未認証結果を成功として保存しません。
      if (page.url().includes("login.action")) throw new Error(`本文取得失敗: pageId=${pageId} がログイン画面へ戻りました。`);
      const title = await page.title();
      const url = page.url();
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const candidateLinks = await page.locator("a").evaluateAll(nodes => nodes
        .map(a => ({
          text: (a.textContent || "").trim(),
          href: a.href || ""
        }))
        .filter(x => x.text || x.href)
        .slice(0, 100)
      ).catch(() => []);

      results.push({
        pageId,
        title,
        url,
        bodySnippet: bodyText,
        candidateLinks
      });
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`OK: ${outputPath}`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
"""


def main() -> int:
    """一時 JavaScript を作成して node で実行します。"""
    args = parse_args()

    if not args.base_url:
        raise SystemExit("環境変数 WENTIAN_CONFLUENCE_BASE_URL または --base-url を指定してください。")

    if not args.username or not args.password:
        raise SystemExit(
            "username と password は引数または環境変数 CONFLUENCE_USERNAME / CONFLUENCE_PASSWORD で指定してください。"
        )

    env = os.environ.copy()
    env["CONF_USERNAME"] = args.username
    env["CONF_PASSWORD"] = args.password
    env["CONF_PAGE_IDS"] = ",".join(str(x) for x in args.page_ids)
    env["CONF_OUTPUT_PATH"] = args.output_path
    env["WENTIAN_CONFLUENCE_BASE_URL"] = args.base_url.rstrip("/")

    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as temp_file:
        temp_file.write(build_node_script())
        temp_script_path = Path(temp_file.name)

    try:
        subprocess.run(
            ["node", str(temp_script_path)],
            cwd=args.project_root,
            env=env,
            check=True,
        )
    finally:
        temp_script_path.unlink(missing_ok=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
