# CONFLUENCE_BROWSER_PATH で既存ブラウザー（Browser）の実行ファイルを指定できます。認証情報は環境変数で渡し、保存しません。
# Confluence のログイン付きページを Playwright で取得する PowerShell スクリプトです。
# 目的:
# - pageId 一覧を指定して、タイトル・最終 URL・本文・候補リンクを JSON に保存する
# - PowerShell からでも同じ手順を再利用できるようにする
# 実装方針:
# - 実ブラウザ制御は Node.js + Playwright で行います
# - このスクリプトは、その一時 JavaScript を生成して実行するラッパーです

[CmdletBinding()]
param(
  # Confluence にログインするメールアドレスです。
  [Parameter(Mandatory = $false)]
  [string]$Username = $env:CONFLUENCE_USERNAME,

  # Confluence にログインするパスワードです。
  [Parameter(Mandatory = $false)]
  [string]$Password = $env:CONFLUENCE_PASSWORD,

  # 確認したい Confluence の pageId 一覧です。
  [Parameter(Mandatory = $true)]
  [int[]]$PageIds,

  # 結果の JSON を出力するパスです。
  [Parameter(Mandatory = $false)]
  [string]$OutputPath = (Join-Path $PWD "confluence-pages.json"),

  # playwright パッケージが入っているプロジェクトのルートです。
  [Parameter(Mandatory = $false)]
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),

  # 接続先は環境設定から受け取ります。
  [Parameter(Mandatory = $false)]
  [string]$BaseUrl = $env:WENTIAN_CONFLUENCE_BASE_URL
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Username) -or [string]::IsNullOrWhiteSpace($Password)) {
  throw "Username と Password は引数または環境変数 CONFLUENCE_USERNAME / CONFLUENCE_PASSWORD で指定してください。"
}
if ([string]::IsNullOrWhiteSpace($BaseUrl)) { throw "環境変数 WENTIAN_CONFLUENCE_BASE_URL または BaseUrl を指定してください。" }

$env:CONF_USERNAME = $Username
$env:CONF_PASSWORD = $Password
$env:CONF_PAGE_IDS = ($PageIds -join ",")
$env:CONF_OUTPUT_PATH = $OutputPath
$env:WENTIAN_CONFLUENCE_BASE_URL = $BaseUrl.TrimEnd('/')

$tempScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ("confluence-playwright-" + [guid]::NewGuid().ToString() + ".js")

$nodeScript = @'
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
'@

try {
  Set-Content -LiteralPath $tempScriptPath -Value $nodeScript -Encoding UTF8

  Push-Location $ProjectRoot
  try {
    & node $tempScriptPath
  }
  finally {
    Pop-Location
  }
}
finally {
  if (Test-Path -LiteralPath $tempScriptPath) {
    Remove-Item -LiteralPath $tempScriptPath -Force
  }
}
