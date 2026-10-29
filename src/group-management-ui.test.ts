import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { groupManagementHtml } from './group-management-ui.js';

async function open(role = 'admin') {
  const window = new Window({ url: 'http://127.0.0.1:8787/workbench/groups' }); (window as unknown as { confirm: () => boolean }).confirm = () => true;
  const normal = { id: 'group-11111111-1111-1111-1111-111111111111', title: '<img src=x onerror=alert(1)>', createdAt: new Date().toISOString(), kind: 'discussion', aiCount: 2, humanCount: 1, messageCount: 4, activePages: [] as string[], publications: [] as any[], summary: '', defaultPublished: false, canDelete: true, deletedAt: undefined as string | undefined };
  const a2a = { ...normal, id: 'group-22222222-2222-2222-2222-222222222222', title: 'A2A相談', kind: 'a2a', canDelete: false };
  const archived = { ...normal, id: 'group-33333333-3333-3333-3333-333333333333', title: '削除済み相談', deletedAt: new Date().toISOString(), canDelete: false };
  const groups = [normal, a2a, archived], requests: Array<{ url: string; body: any }> = [];
  window.fetch = (async (url: unknown, options: any = {}) => {
    const address = String(url), body = options.body ? JSON.parse(options.body) : undefined; requests.push({ url: address, body }); let result: unknown = { ok: true };
    if (address === '/api/control-center/me') result = { user: { role } };
    else if (address === '/api/site-admin') result = { pages: [{ slug: '', title: 'トップ' }, { slug: 'research', title: '研究ページ' }] };
    else if (address === '/api/workbench/group-management') result = { groups };
    else if (address.endsWith('/rename')) normal.title = body.title;
    else if (address.endsWith('/publication')) { normal.publications = [{ page: body.page, published: body.published, summary: body.summary }]; normal.activePages = body.published ? [body.page] : []; }
    else if (address.endsWith('/delete')) { normal.deletedAt = new Date().toISOString(); normal.activePages = []; normal.publications = []; normal.canDelete = false; }
    else if (address.endsWith('/restore')) { normal.deletedAt = undefined; normal.activePages = []; normal.publications = []; normal.canDelete = true; }
    return new window.Response(JSON.stringify(result), { status: 200 });
  }) as typeof window.fetch;
  window.document.write(groupManagementHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const script of groupManagementHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(script[1]);
  await settle(); return { window, normal, a2a, requests };
}
async function settle() { for (let index = 0; index < 25; index++) await new Promise<void>(resolve => setImmediate(resolve)); }

test('作成中と失敗理由をフォーム直下に表示し、主題を保持して再操作できる', async () => {
  const f = await open(), doc = f.window.document;
  try {
    let finish!: (value: any) => void;
    f.window.fetch = (() => new Promise(resolve => { finish = resolve; })) as typeof f.window.fetch;
    (doc.getElementById('newTitle') as any).value = '关于问天开发的构想';
    const form = doc.getElementById('createForm')!;
    form.dispatchEvent(new f.window.Event('submit', { cancelable: true })); await settle();
    assert.equal(form.getAttribute('aria-busy'), 'true');
    assert.ok(form.querySelector('button')!.disabled);
    assert.ok(doc.getElementById('createStatus')!.textContent.includes('依頼しています'));
    finish(new f.window.Response(JSON.stringify({ error: { message: 'AIが有効なJSONを返しませんでした。' } }), { status: 400 })); await settle();
    assert.equal(doc.getElementById('createStatus')!.textContent, 'AIが有効なJSONを返しませんでした。');
    assert.equal((doc.getElementById('newTitle') as any).value, '关于问天开发的构想');
    assert.equal(form.getAttribute('aria-busy'), 'false');
    assert.equal(form.querySelector('button')!.disabled, false);
  } finally { await f.window.happyDOM.close(); }
});

test('作成成功時は検索条件を解除して新しいグループを表示する', async () => {
  const f = await open(), doc = f.window.document, original = f.window.fetch;
  try {
    const created = { ...f.normal, id: 'group-44444444-4444-4444-4444-444444444444', title: '关于问天开发的构想' };
    f.window.fetch = (async (url: unknown, options: any) => {
      if (String(url) === '/api/workbench/groups') return new f.window.Response(JSON.stringify(created));
      if (String(url) === '/api/workbench/group-management') return new f.window.Response(JSON.stringify({ groups: [created] }));
      return original(url as any, options);
    }) as typeof f.window.fetch;
    (doc.getElementById('filter') as any).value = 'deleted';
    (doc.getElementById('search') as any).value = '一致しない検索';
    (doc.getElementById('newTitle') as any).value = created.title;
    doc.getElementById('createForm')!.dispatchEvent(new f.window.Event('submit', { cancelable: true })); await settle();
    assert.ok(row(f.window, created.id));
    assert.equal((doc.getElementById('newTitle') as any).value, '');
    assert.equal(doc.getElementById('createStatus')!.textContent, 'AIグループを作成しました。');
  } finally { await f.window.happyDOM.close(); }
});
function row(window: Window, id: string) { return window.document.querySelector('tr[data-group-id="' + id + '"]')!; }
function button(window: Window, id: string, name: string) { return [...row(window, id).querySelectorAll('button')].find(item => item.textContent === name)!; }

test('グループ一覧で名前変更・ページ公開・削除復元を操作し、A2A削除とHTML実行を防ぐ', async () => {
  const f = await open(), doc = f.window.document;
  try {
    assert.equal((doc.getElementById('content') as any).hidden, false); assert.equal(doc.querySelectorAll('#groups tr').length, 2);
    assert.ok(doc.querySelector('a[href="/#home"]'));
    assert.equal(row(f.window, f.normal.id).querySelector('img'), null); assert.equal(button(f.window, f.a2a.id, '削除').disabled, true);
    button(f.window, f.normal.id, '変更・公開管理').click(); await settle();
    (doc.getElementById('editTitle') as any).value = '名前変更後'; doc.getElementById('renameForm')!.dispatchEvent(new f.window.Event('submit', { cancelable: true })); await settle();
    assert.equal(f.requests.find(item => item.url.endsWith('/rename'))!.body.expectedTitle, '<img src=x onerror=alert(1)>'); assert.ok(row(f.window, f.normal.id).textContent.includes('名前変更後'));
    (doc.getElementById('page') as any).value = 'research'; doc.getElementById('page')!.dispatchEvent(new f.window.Event('change'));
    (doc.getElementById('summary') as any).value = '研究室の紹介'; (doc.getElementById('publish') as any).click(); await settle();
    assert.equal(f.requests.find(item => item.url.endsWith('/publication'))!.body.page, 'research'); assert.equal((doc.getElementById('page') as any).value, 'research');
    button(f.window, f.normal.id, '削除').click(); await settle(); assert.equal(doc.querySelector('tr[data-group-id="' + f.normal.id + '"]'), null);
    (doc.getElementById('filter') as any).value = 'deleted'; doc.getElementById('filter')!.dispatchEvent(new f.window.Event('change'));
    button(f.window, f.normal.id, '復元').click(); await settle(); assert.equal(f.normal.deletedAt, undefined); assert.equal(f.normal.activePages.length, 0);
  } finally { await f.window.happyDOM.close(); }
});

test('管理画面は閲覧者に管理機能を表示せず、未認証時はログインへ戻す', async () => {
  const viewer = await open('viewer');
  try { assert.equal((viewer.window.document.getElementById('content') as any).hidden, true); assert.ok(viewer.window.document.getElementById('message')!.textContent.includes('管理者')); assert.ok(!viewer.requests.some(item => item.url === '/api/workbench/group-management')); }
  finally { await viewer.window.happyDOM.close(); }
  const admin = await open();
  try {
    admin.window.fetch = (async () => new admin.window.Response(JSON.stringify({ error: { message: 'ログインが必要です。' } }), { status: 401 })) as typeof admin.window.fetch;
    (admin.window.document.getElementById('refresh') as any).click(); await settle();
    assert.equal((admin.window.document.getElementById('content') as any).hidden, true); assert.equal((admin.window.document.getElementById('login') as any).hidden, false);
  } finally { await admin.window.happyDOM.close(); }
});
