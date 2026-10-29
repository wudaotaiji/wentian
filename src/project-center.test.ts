import test from 'node:test';
import assert from 'node:assert/strict';
import { Window, HTMLTextAreaElement, HTMLInputElement, HTMLElement } from 'happy-dom';
import { projectCenterHtml } from './project-center.js';

// 共通メニューの常駐ポーリングは待たず、模擬通信と画面更新を待ちます。
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function open(canManage: boolean, withDocuments = false) {
  const window = new Window({ url: 'http://127.0.0.1:8787/projects' }); const calls: Array<{ url: string; body?: any; method?: string }> = [];
  const collectionJobs:any[]=[];
  window.fetch = (async (url: unknown, init?: { body?: string; method?: string }) => {
    const address = String(url), body = init?.body ? JSON.parse(init.body) : undefined; calls.push({ url: address, body, method: init?.method });
    let data: unknown = {};
    if (address.endsWith('/me')) data = { user: { id: 'owner', role: canManage ? 'admin' : 'viewer' } };
    else if (address.endsWith('/projects')) data = { projects: [{ id: 'project-a', name: '<img src=x onerror=alert(1)>' }, ...(withDocuments ? [{ id: 'project-b', name: '別プロジェクト' }] : [])] };
    else if (address.endsWith('/usage')) data = { project: { allowedModels: ['example/model-a', 'example/model-b'], spendUsd: 1, heldUsd: 0, canManage, members: { owner: 'owner' } }, keys: [] };
    else if (address.endsWith('/keys')) data = { key: 'wt-test-one-time-key' };
    else if (address.endsWith('/sources')) data={sources:[{id:'mock-profile'}]};
    else if (address.endsWith('/collection-jobs')) {if(init?.method==='POST')collectionJobs.push({id:'job-fixture',input:body,status:'queued',documents:0,pendingCount:1});data=init?.method==='POST'?collectionJobs.at(-1):{jobs:collectionJobs};}
    else if (address.endsWith('/collect')) data = { complete: true, documents: [{ title: '収集した資料', url: 'https://example.invalid/source', revision: 1 }], errors: [] };
    else if (address.includes('/search?')) data = { hits: [{ title: '<img src=x>', url: 'https://example.com/source', excerpt: '<script>danger()</script>', revision: 2, lineStart: 4, lineEnd: 8 }] };
    else if (address.endsWith('/documents')) data = withDocuments ? [{ id: 'doc-a', title: '資料A', revision: 4 }] : [];
    else if (address.endsWith('/documents/doc-a')) data = { id: 'doc-a', title: '資料A', url: 'https://example.com', content: '本文', revision: 4 };
    return new window.Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;
  window.document.write(projectCenterHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const script of projectCenterHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(script[1]);
  await settle();
  // モックfetchのPromiseはDOM側の通信管理外なので、初期ロード完了を観測して待つ。
  for (let attempt = 0; attempt < 100 && !(window.document.getElementById('models') as HTMLTextAreaElement).value; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok((window.document.getElementById('models') as HTMLTextAreaElement).value, JSON.stringify({ notice: window.document.getElementById('notice')!.textContent, calls: calls.map(call => call.url), selected: (window.document.getElementById('project') as unknown as { value: string }).value }));
  return { window, calls };
}
test('設定画面は改行モデルを保存し、キーは発行時だけ表示、引用は文字として描画する', async () => {
  const { window, calls } = await open(true); const document = window.document;
  try {
    assert.equal((document.getElementById('models') as HTMLTextAreaElement).value, 'example/model-a\nexample/model-b');
    (document.getElementById('models') as HTMLTextAreaElement).value = 'example/new-a\nexample/new-b';
    (document.getElementById('save') as HTMLElement).click(); await settle();
    assert.deepEqual(calls.find(call => call.body?.allowedModels)?.body.allowedModels, ['example/new-a', 'example/new-b']);
    (document.getElementById('issue') as HTMLElement).click(); await settle();
    assert.match(document.getElementById('key')!.textContent, /wt-test-one-time-key/); assert.equal(window.localStorage.length, 0);
    (document.getElementById('query') as HTMLInputElement).value = '復旧'; (document.getElementById('search') as HTMLElement).click(); await settle();
    assert.match(document.getElementById('results')!.textContent, /改訂 2/); assert.match(document.getElementById('results')!.textContent, /4.*8/);
    assert.equal(document.querySelector('img'), null); assert.equal(document.querySelector('#results script'), null);
    (document.getElementById('reload') as HTMLElement).click(); await settle(); assert.equal(document.getElementById('key')!.textContent, '');
  } finally { await window.happyDOM.close(); }
});
test('メンバーの画面では管理設定と所属編集を隠し、資料変更を無効化する', async () => {
  const { window } = await open(false);
  try {
    assert.equal((window.document.getElementById('settings') as HTMLElement).hidden, true);
    assert.equal((window.document.getElementById('membership') as HTMLElement).hidden, true);
    assert.equal((window.document.getElementById('putDocument') as unknown as { disabled: boolean }).disabled, true);
    assert.equal((window.document.getElementById('collectUrls') as unknown as { disabled: boolean }).disabled, true);
  } finally { await window.happyDOM.close(); }
});

test('URL収集とベクトル検索の画面が実APIへ選択値を送り、収集結果を表示する', async () => {
  const { window, calls } = await open(true); const doc = window.document;
  try {
    (doc.getElementById('collectUrl') as HTMLInputElement).value = 'https://example.invalid/source';
    (doc.getElementById('collectLinks') as HTMLInputElement).checked = true;
    (doc.getElementById('collectMaxPages') as HTMLInputElement).value = '3';
    (doc.getElementById('collectUrls') as HTMLElement).click(); await settle();
    assert.deepEqual(calls.find(c => c.url.endsWith('/collect'))?.body, { url: 'https://example.invalid/source', followLinks: true, maxPages: 3, render: true });
    assert.match(doc.getElementById('collectResult')!.textContent, /収集完了/);
    assert.match(doc.getElementById('collectResult')!.textContent, /収集した資料/);
    (doc.getElementById('searchMode') as any).value = 'vector';
    (doc.getElementById('query') as HTMLInputElement).value = '意味による質問';
    (doc.getElementById('search') as HTMLElement).click(); await settle();
    assert.ok(calls.some(c => c.url.includes('/search?') && c.url.endsWith('&mode=vector')));
  } finally { await window.happyDOM.close(); }
});

test('認証接続設定と継続収集の指定を送信し、ジョブ画面から一時停止できる',async()=>{
  const {window,calls}=await open(true),doc=window.document;
  try{
    (doc.getElementById('collectUrl') as HTMLInputElement).value='https://example.invalid/private';
    (doc.getElementById('collectProfile') as any).value='mock-profile';
    (doc.getElementById('collectJobMode') as any).value='continuous';
    (doc.getElementById('collectInterval') as HTMLInputElement).value='2';
    (doc.getElementById('startCollectionJob') as HTMLElement).click();await settle();
    const created=calls.find(c=>c.url.endsWith('/collection-jobs')&&c.method==='POST');
    assert.equal(created?.body.profileId,'mock-profile');assert.equal(created?.body.render,true);assert.equal(created?.body.mode,'continuous');assert.equal(created?.body.intervalMs,120000);
    const pause=doc.querySelector('#collectionJobs button') as HTMLElement;assert.ok(pause);pause.click();await settle();
    assert.ok(calls.some(c=>c.url.endsWith('/collection-jobs/job-fixture/pause')&&c.method==='POST'));
  }finally{await window.happyDOM.close()}
});

test('プロジェクト画面の英語・中国語表示に固定日本語を残さない', async () => {
  for (const locale of ['en', 'zh']) {
    const window = new Window({ url: 'http://localhost/' });
    window.localStorage.setItem('wentian-language', locale);
    try {
      window.document.write(projectCenterHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
      const script = [...projectCenterHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('window.wentianUi={t,apply,language}'));
      assert.ok(script, '翻訳スクリプトが必要です');
      window.eval(script![1]);
      const remaining = new Set<string>();
      const walker = window.document.createTreeWalker(window.document.body, 4);
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement!.closest('script,style,pre,code,textarea,#language,[data-no-translate]')) continue;
        const value = node.textContent!.trim();
        if ((locale === 'en' ? /[\u3040-\u30ff\u3400-\u9fff]/ : /[\u3040-\u30ff]/).test(value)) remaining.add(value);
      }
      for (const element of window.document.querySelectorAll('[placeholder],[aria-label],[title]')) {
        if (element.closest('#language,[data-no-translate]')) continue;
        for (const key of ['placeholder', 'aria-label', 'title']) {
          const value = element.getAttribute(key) || '';
          if ((locale === 'en' ? /[\u3040-\u30ff\u3400-\u9fff]/ : /[\u3040-\u30ff]/).test(value)) remaining.add(value);
        }
      }
      assert.deepEqual([...remaining], [], `${locale}の未翻訳UI`);
    } finally { await window.happyDOM.close(); }
  }
});

test('資料一覧から閲覧・改訂付き更新を行い、プロジェクト切替で前の入力を消去する', async () => {
  const { window, calls } = await open(true, true);
  const doc = window.document;
  Object.assign(window, { confirm: () => false });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    assert.equal(doc.querySelectorAll('#projectSummary .card').length, 4);
    (doc.querySelector('#documentList button') as HTMLElement).click(); await settle();
    assert.equal((doc.getElementById('content') as HTMLTextAreaElement).value, '本文');
    (doc.getElementById('removeDocument') as HTMLElement).click(); await settle();
    assert.equal(calls.some(call => call.method === 'DELETE'), false);
    (doc.getElementById('content') as HTMLTextAreaElement).value = '更新した本文';
    (doc.getElementById('putDocument') as HTMLElement).click(); await settle();
    assert.equal(calls.find(call => call.method === 'PUT')!.body.expectedRevision, 4);
    assert.equal((doc.getElementById('content') as HTMLTextAreaElement).value, '');
    (doc.querySelector('#documentList button') as HTMLElement).click(); await settle();
    (doc.getElementById('inputPrice') as HTMLInputElement).value = '999';
    const selector = doc.getElementById('project') as any;
    selector.value = 'project-b'; selector.dispatchEvent(new window.Event('change')); await settle();
    assert.equal((doc.getElementById('content') as HTMLTextAreaElement).value, '');
    assert.equal((doc.getElementById('inputPrice') as HTMLInputElement).value, '');
    assert.equal(doc.getElementById('document')!.getAttribute('data-revision'), null);
    assert.equal(doc.querySelector('#documentList script'), null);
  } finally { await window.happyDOM.close(); }
});
