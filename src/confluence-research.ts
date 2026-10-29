import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
const execFileAsync = promisify(execFile);

export interface ConfluencePageResult { pageId: string; title: string; url: string; body: string; }

/** 設定済みConfluenceホストの数値pageIdだけを抽出し、任意URLへのセッション送信を防ぎます。 */
export function confluencePageId(input: string): string | undefined {
  const configured = process.env.WENTIAN_CONFLUENCE_BASE_URL;
  if (!configured) return undefined;
  try {
    const base = new URL(configured);
    const candidate = new URL(input.match(/https?:\/\/[^\s"']+/i)?.[0] || '');
    if (base.protocol !== 'https:' || candidate.origin !== base.origin || candidate.pathname !== `${base.pathname.replace(/\/$/, '')}/pages/viewpage.action`) return undefined;
    const id = candidate.searchParams.get('pageId');
    return id && /^\d{1,20}$/.test(id) ? id : undefined;
  } catch { return undefined; }
}

/** 認証情報や秘密鍵そのものを要求する文面を検出します。 */
export function requestsSecretExtraction(input: string): boolean {
  return /(?:preshared\s*key|pre-shared\s*key|事前共有鍵|共有鍵|password|パスワード|秘密鍵|private\s*key|api\s*key|token|トークン).*(?:教えて|表示|抽出|取得|見せて)|(?:教えて|表示|抽出|取得|見せて).*(?:preshared\s*key|pre-shared\s*key|事前共有鍵|共有鍵|password|パスワード|秘密鍵|private\s*key|api\s*key|token|トークン)/i.test(input);
}

/** Playwrightの保存済みログインセッションを使い、本文テキストだけを標準出力で受け取ります。 */
export async function fetchConfluencePage(pageId: string): Promise<ConfluencePageResult> {
  if (!/^\d{1,20}$/.test(pageId)) throw new Error('Confluence pageIdが不正です。');
  const configured = process.env.WENTIAN_CONFLUENCE_BASE_URL;
  if (!configured) throw new Error('WENTIAN_CONFLUENCE_BASE_URLが未設定です。');
  const baseUrl = new URL(configured);
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) throw new Error('Confluence Base URLは認証情報を含まないHTTPS URLにしてください。');
  const projectRoot = process.env.WENTIAN_CONFLUENCE_PLAYWRIGHT_ROOT || process.cwd();
  const authState = process.env.WENTIAN_CONFLUENCE_AUTH_STATE || path.join(projectRoot, '.wentian', 'confluence-auth.json');
  const targetUrl = new URL(`${baseUrl.pathname.replace(/\/$/, '')}/pages/viewpage.action?pageId=${pageId}`, baseUrl).toString();
  const browserRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const chromiumDirectory = existsSync(browserRoot) ? readdirSync(browserRoot).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0] : undefined;
  const executablePath = chromiumDirectory ? path.join(browserRoot, chromiumDirectory, 'chrome-win64', 'chrome.exe') : '';
  const browserScript = `const {chromium}=require('playwright');(async()=>{const launch={headless:true};if(process.env.WENTIAN_CHROMIUM_PATH)launch.executablePath=process.env.WENTIAN_CHROMIUM_PATH;const browser=await chromium.launch(launch);try{const context=await browser.newContext({storageState:process.env.WENTIAN_AUTH_STATE});const page=await context.newPage();await page.goto(process.env.WENTIAN_TARGET_URL,{waitUntil:'domcontentloaded',timeout:120000});const result={pageId:process.env.WENTIAN_PAGE_ID,title:await page.title(),url:page.url(),body:(await page.locator('body').innerText()).slice(0,12000)};console.log(JSON.stringify(result));}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exit(1)});`;
  const result = await execFileAsync(process.execPath, ['-e', browserScript], { cwd: projectRoot, windowsHide: true, timeout: 150000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, WENTIAN_AUTH_STATE: authState, WENTIAN_TARGET_URL: targetUrl, WENTIAN_PAGE_ID: pageId, WENTIAN_CHROMIUM_PATH: executablePath } });
  const page = JSON.parse(result.stdout.trim()) as ConfluencePageResult;
  if (/login\.action/i.test(page.url) || /Confluence ログイン/.test(page.title)) throw new Error('Confluenceログインセッションが期限切れです。認証状態を更新してください。');
  if (new URL(page.url).origin !== baseUrl.origin) throw new Error('Confluence外へリダイレクトされたため取得を中止しました。');
  return page;
}

/** 可視ブラウザーで人間がログインした後、Cookie等をローカルのstorageStateへ保存します。 */
export async function loginConfluenceSession(): Promise<void> {
  const configured = process.env.WENTIAN_CONFLUENCE_BASE_URL;
  if (!configured) throw new Error('WENTIAN_CONFLUENCE_BASE_URLが未設定です。');
  const baseUrl = new URL(configured);
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) throw new Error('Confluence Base URLは認証情報を含まないHTTPS URLにしてください。');
  const projectRoot = process.env.WENTIAN_CONFLUENCE_PLAYWRIGHT_ROOT || process.cwd();
  const authState = process.env.WENTIAN_CONFLUENCE_AUTH_STATE || path.join(projectRoot, '.wentian', 'confluence-auth.json');
  const browserRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  const chromiumDirectory = existsSync(browserRoot) ? readdirSync(browserRoot).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0] : undefined;
  const executablePath = chromiumDirectory ? path.join(browserRoot, chromiumDirectory, 'chrome-win64', 'chrome.exe') : '';
  const script = `const {chromium}=require('playwright');const readline=require('readline');(async()=>{const launch={headless:false};if(process.env.WENTIAN_CHROMIUM_PATH)launch.executablePath=process.env.WENTIAN_CHROMIUM_PATH;const browser=await chromium.launch(launch);const context=await browser.newContext();const page=await context.newPage();await page.goto(process.env.WENTIAN_CONFLUENCE_LOGIN_URL,{waitUntil:'domcontentloaded',timeout:120000});console.log('ブラウザーでログイン後、この端末でEnterキーを押してください。');await new Promise(resolve=>readline.createInterface({input:process.stdin,output:process.stdout}).question('',resolve));await context.storageState({path:process.env.WENTIAN_AUTH_STATE});await browser.close();console.log('Confluenceログインセッションを保存しました。');})().catch(e=>{console.error(e.message);process.exit(1)});`;
  const loginUrl = new URL(`${baseUrl.pathname.replace(/\/$/, '')}/login.action`, baseUrl).toString();
  await new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, ['-e', script], { cwd: projectRoot, windowsHide: false, stdio: 'inherit', env: { ...process.env, WENTIAN_AUTH_STATE: authState, WENTIAN_CHROMIUM_PATH: executablePath, WENTIAN_CONFLUENCE_LOGIN_URL: loginUrl } }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Confluenceログイン処理が終了コード${code}で失敗しました。`))); });
}
