import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { Window, HTMLSelectElement, HTMLInputElement } from 'happy-dom';
import { managerDashboardHtml } from './dashboard.js';
import { workbenchHtml } from './workbench-ui.js';
import { withAppearance } from './appearance-ui.js';
import { visualAssetsHtml } from './visual-assets-ui.js';
import { studyHtml } from './study/ui.js';

test('プログラム更新後の再検証状態を日本語・英語・中国語で表示する', async () => {
  for (const [language, expected] of [['ja', 'プログラム更新後の接続・作業を再確認中です。'], ['en', 'Rechecking connection and work after the program update.'], ['zh', '程序更新后正在重新验证连接和作业。']]) {
    const html = withAppearance(visualAssetsHtml), window = new Window({ url: 'http://localhost/' });
    window.localStorage.setItem('wentian-language', language);
    try {
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('window.wentianUi={t,apply,language}'))!;
      window.eval(script);
      const element = window.document.createElement('p'); element.textContent = 'プログラム更新後の接続・作業を再確認中です。'; window.document.body.append(element);
      for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(element.textContent, expected);
    } finally { await window.happyDOM.close(); }
  }
});

test('独立画面の共通翻訳は一度だけ初期化し、追加UIを自動翻訳して会話を保持する', async () => {
  for (const source of [visualAssetsHtml, studyHtml]) {
    const html = withAppearance(source);
    assert.equal(withAppearance(html), html);
    const window = new Window({ url: 'http://localhost/' });
    window.localStorage.setItem('wentian-language', 'en');
    try {
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('window.wentianUi={t,apply,language}'))!;
      window.eval(script);
      const panel = window.document.createElement('section');
      panel.innerHTML = '<h1>创业孵化器</h1><p role="status">画像を制作しています…</p><div class="group-bubble"><p>我的人物形象</p></div><p data-no-translate>研究室</p>';
      window.document.body.append(panel);
      for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r));
      assert.equal(panel.querySelector('h1')!.textContent, 'Startup Forge');
      assert.equal(panel.querySelector('[role=status]')!.textContent, 'Generating the image…');
      assert.equal(panel.querySelector('.group-bubble')!.textContent, '我的人物形象');
      assert.equal(panel.querySelector('[data-no-translate]')!.textContent, '研究室');
    } finally { await window.happyDOM.close(); }
  }
});

// 実サービスへ接続せず、配信される全スクリプト（Script）と自動更新を一緒に検証します。
async function open(language = 'ja', theme = 'dark') {
  const window = new Window({ url: 'http://127.0.0.1:8787/#marketplace' });
  window.localStorage.setItem('wentian-language', language);
  window.localStorage.setItem('wentian-theme', theme);
  // 定期更新の代わりに更新ボタンを押し、テストの終了を待ち続けるタイマーを作りません。
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  let probes = 0;
  window.fetch = (async (url: unknown) => {
    const address = String(url);
    let body: unknown = [];
    if (address.endsWith('/status')) body = { needsSetup: false, memory: {}, providers: [] };
    if (address.endsWith('/me')) body = { user: { displayName: '稼働状況', role: 'admin' } };
    if (address.endsWith('/metrics')) body = {};
    if (address.endsWith('/external-agents')) body = { summary: {}, agents: [] };
    if (address.includes('agent-marketplace')) {
      probes++;
      body = { candidates: [{ id: 'sample', name: '候補', repository: 'owner/sample', popularity: 42, liveState: 'healthy', compatibility: 'windows', note: 'OpenAI公式CLI', installed: false, installSupported: true }] };
    }
    return new window.Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;
  window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const match of managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(match[1]);
  for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
  return { window, probes: () => probes };
}

test('マーケット画面の言語切替はメニュー・表・説明・検索へ適用し、更新後も維持する', async () => {
  const { window, probes } = await open();
  try {
    const doc = window.document;
    const language = doc.getElementById('language') as HTMLSelectElement;
    const chat = doc.getElementById('chatInput') as HTMLInputElement;
    chat.value = '候補';
    for (const [locale, title, rank, state, action, note] of [
      ['en', 'Add Agents', 'Rank', 'Running', 'Review & install', 'Official OpenAI CLI'],
      ['zh', '添加智能体', '排名', '运行中', '查看计划并安装', 'OpenAI 官方 CLI'],
      ['ja', 'エージェントを追加', '順位', '稼働中', '計画確認・導入', 'OpenAI公式CLI']
    ]) {
      language.value = locale; language.dispatchEvent(new window.Event('change', { bubbles: true }));
      assert.equal(doc.documentElement.lang, locale);
      assert.equal(doc.getElementById('viewTitle')!.textContent, title);
      assert.ok(doc.querySelector('.nav-rail [data-view=marketplace]')!.textContent!.includes(title));
      assert.equal(doc.querySelector('#marketplace th')!.textContent, rank);
      assert.equal(doc.querySelector('#marketplace .badge')!.textContent, state);
      assert.equal(doc.querySelector('#marketplace [data-install-agent]')!.textContent, action);
      assert.equal(doc.querySelector('#marketplace td:nth-child(6)')!.textContent, note);
      // 依頼文、利用者名、リポジトリー（Repository）名、エージェント名を翻訳しません。
      assert.equal(chat.value, '候補');
      assert.match(doc.getElementById('currentUser')!.textContent!, /稼働状況/);
      assert.equal(doc.querySelector('#marketplace td:nth-child(2) strong')!.textContent, '候補');
      assert.equal(doc.querySelector('#marketplace code')!.textContent, 'owner/sample');
      const before = probes();
      (doc.getElementById('refresh') as HTMLInputElement).click();
      for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(probes() > before);
      assert.equal(doc.querySelector('#marketplace th')!.textContent, rank);
      assert.equal(doc.querySelector('#marketplace [data-install-agent]')!.textContent, action);
      assert.equal(doc.querySelector('#marketplace td:nth-child(6)')!.textContent, note);
    }
    language.value = 'en'; language.dispatchEvent(new window.Event('change', { bubbles: true }));
    const search = doc.getElementById('navSearch') as HTMLInputElement;
    search.value = 'Marketplace'; search.dispatchEvent(new window.Event('input'));
    assert.equal(doc.querySelector('#navResults button')!.textContent, 'Add Agents');
    assert.match(doc.querySelector('[data-view=marketplace].nav-view>section, [data-view=marketplace].nav-view>.panel')!.textContent!, /re-add or delete uninstalled agents/);
  } finally { await window.happyDOM.close(); }
});

test('7種類のスタイルは全画面へ適用でき、言語変更で設定を失わない', async () => {
  const { window } = await open('zh', 'glass');
  try {
    const doc = window.document;
    const selector = doc.getElementById('theme') as HTMLSelectElement;
    assert.equal(selector.options.length, 7);
    assert.equal(selector.value, 'glass');
    const palettes = new Set<string>();
    for (const theme of ['dark', 'light', 'glass', 'bento', 'soft', 'brutalist', 'minimal']) {
      selector.value = theme; selector.dispatchEvent(new window.Event('change', { bubbles: true }));
      assert.equal(doc.documentElement.dataset.theme, theme);
      assert.equal(window.localStorage.getItem('wentian-theme'), theme);
      palettes.add(window.getComputedStyle(doc.documentElement).getPropertyValue('--bg'));
      const language = doc.getElementById('language') as HTMLSelectElement;
      language.value = 'en'; language.dispatchEvent(new window.Event('change', { bubbles: true }));
      assert.equal(doc.documentElement.dataset.theme, theme);
      assert.equal(selector.value, theme);
      assert.equal(selector.getAttribute('aria-label'), 'Site style');
    }
    assert.equal(palettes.size, 7);
    // 同じ保存値を読み込む初期化を再実行し、ページ再読込に相当する復元を確認します。
    doc.documentElement.dataset.theme = 'dark';
    window.eval([...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]);
    assert.equal(doc.documentElement.dataset.theme, 'minimal');
    assert.equal(doc.documentElement.lang, 'en');
  } finally { await window.happyDOM.close(); }
});

test('削除範囲の選択確認は説明文まで中国語に翻訳する',async()=>{
  const {window}=await open('zh');
  try{
    const dialog=window.document.createElement('dialog');
    dialog.innerHTML='<h3>アンインストール</h3><p>自動実行から外し、エージェント追加へ移動します。</p><p>ほかのアプリや直接実行にも影響します。</p><button>キャンセル</button>';
    window.document.body.append(dialog);
    (window as unknown as {wentianUi:{apply:()=>void}}).wentianUi.apply();
    assert.match(dialog.textContent!,/卸载/);assert.match(dialog.textContent!,/停止自动使用/);assert.match(dialog.textContent!,/影响其他应用/);assert.match(dialog.textContent!,/取消/);
  }finally{await window.happyDOM.close();}
});

test('未知の保存設定は既定へ戻し、両画面の全コードに構文エラーがない', async () => {
  for (const html of [managerDashboardHtml, workbenchHtml]) {
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  }
  const { window } = await open('unknown', 'unknown');
  try {
    assert.equal(window.document.documentElement.lang, 'ja');
    assert.equal(window.document.documentElement.dataset.theme, 'dark');
  } finally { await window.happyDOM.close(); }
});
