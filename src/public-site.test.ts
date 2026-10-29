import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { Script } from 'node:vm';
import { AgentGroupStore, namedMembers } from './agent-group.js';
import { PublicSiteStore, defaultPublicSite, buildPublicWebsite, registerSiteAdmin, renderPublicHome, validatePublicSite } from './public-site.js';

async function temporary(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-public-'));
  try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('保存時にページ別の独立ソースを生成し、再書き出しで前世代を保持する', async () => temporary(async root => {
  const app = Fastify();
  registerSiteAdmin(app, {workspace:root,authorize:()=>true,gatewayOrigin:()=> 'http://127.0.0.1:8787',design:async()=> '{}'});
  try {
    const saved = (await app.inject({method:'POST',url:'/api/site-admin?page=about',payload:{...defaultPublicSite,headline:'独立サイトの検証'}})).json();
    assert.ok(saved.source.directory.startsWith(path.join(root,'.wentian','sites','pages','about') + path.sep));
    const html = await readFile(path.join(saved.source.directory,'index.html'),'utf8');
    assert.match(html,/独立サイトの検証/);
    assert.match(html,/href="styles.css"/);
    assert.doesNotMatch(html,/<script\b|<style\b|\/api\/site/);
    assert.ok((await readFile(path.join(saved.source.directory,'styles.css'),'utf8')).length > 100);
    assert.equal(JSON.parse(await readFile(path.join(saved.source.directory,'site.json'),'utf8')).revision,1);
    const exported = (await app.inject({method:'POST',url:'/api/site-admin/export?page=about',payload:{}})).json();
    assert.notEqual(exported.source.directory,saved.source.directory);
    assert.equal(await readFile(path.join(saved.source.directory,'index.html'),'utf8'),html);
    assert.equal((await app.inject({method:'POST',url:'/api/site-admin/export?page=..%2Fescape',payload:{}})).statusCode,400);
  } finally {await app.close();}
}));

test('ページ別の公開と閉鎖は他ページの掲載・発言欄を変更しない', async () => temporary(async root => {
  const groups = new AgentGroupStore(root), group = await groups.create('ページ別相談室', namedMembers(['mock/model']));
  await groups.publish(group.id, true, 'トップ紹介', 'online', '');
  const home = new PublicSiteStore(root), company = new PublicSiteStore(root, 'companyprofile');
  assert.equal((await home.rooms()).length, 1); assert.equal((await company.rooms()).length, 0);
  await groups.publish(group.id, true, '会社紹介', 'offline', 'companyprofile');
  assert.equal((await home.rooms())[0].showComposer, true); assert.equal((await company.rooms())[0].showComposer, undefined);
  await groups.publish(group.id, false, undefined, 'offline', 'companyprofile');
  assert.equal((await home.rooms())[0].summary, 'トップ紹介'); assert.equal((await company.rooms()).length, 0);
  await groups.publish(group.id, true, '会社紹介', 'online', 'companyprofile');
  await groups.publish(group.id, false, undefined, 'offline', '');
  assert.equal((await home.rooms()).length, 0); assert.equal((await company.rooms())[0].showComposer, true);
}));

test('追加ページを独立して編集・公開し、未作成URLと不正な保存先を拒否する', async () => temporary(async root => {
  const admin = Fastify();
  registerSiteAdmin(admin, { workspace: root, authorize: () => true, gatewayOrigin: () => 'http://127.0.0.1:8787', design: async () => '{}' });
  const website = buildPublicWebsite(root, 'http://127.0.0.1:8787');
  try {
    const created = await admin.inject({ method: 'POST', url: '/api/site-admin?page=about', payload: { ...defaultPublicSite, title: '会社紹介', headline: '追加ページの内容' } });
    assert.equal(created.statusCode, 200);
    // 同一オリジン（Origin）の公開URLは認証なしで表示し、大文字の別名も解決します。
    const publicPage = await admin.inject('/sites/About/');
    assert.equal(publicPage.statusCode, 200);
    assert.match(publicPage.body, /追加ページの内容/);
    assert.match(publicPage.body, /pathname.startsWith\('\/sites\/'\)/);
    assert.equal((await admin.inject('/sites/missing/')).statusCode, 404);
    assert.equal((await admin.inject('/sites/about')).headers.location, '/sites/about/');
    assert.equal((await admin.inject('/api/site?page=about')).json().site.title, '会社紹介');
    const page = await website.inject('/pages/about');
    assert.equal(page.statusCode, 200); assert.match(page.body, /追加ページの内容/); assert.match(page.body, /href="\/pages\/about"/);
    assert.doesNotMatch((await website.inject('/')).body, /追加ページの内容/);
    const data = (await admin.inject('/api/site-admin?page=about')).json();
    assert.equal(data.pages.length, 2); assert.equal(data.site.revision, 1);
    assert.equal((await website.inject('/api/site?page=about')).json().site.title, '会社紹介');
    assert.equal((await website.inject('/pages/missing')).statusCode, 404);
    assert.equal((await admin.inject('/api/site-admin?page=..%2Foutside')).statusCode, 400);
    assert.equal((await admin.inject({ method: 'POST', url: '/api/site-admin?page=about', payload: defaultPublicSite })).statusCode, 409);
  } finally { await admin.close(); await website.close(); }
}));

test('デフォルトトップを配信し、公開・閉鎖した相談室の入口だけを一覧へ反映する', async () => temporary(async root => {
  const groups = new AgentGroupStore(root), group = await groups.create('開発相談室', namedMembers(['秘密のモデル']));
  await groups.participate(group.id, { id: 'private-id', name: 'Private Person' }, 'join');
  await groups.post(group.id, 'private-id', 'private-transcript');
  const app = buildPublicWebsite(root, 'http://127.0.0.1:8787');
  try {
    let page = await app.inject('/');
    assert.equal(page.statusCode, 200); assert.match(page.body, /アイデアを、確かな成果へ/);
    assert.doesNotMatch(page.body, /開発相談室/);
    await groups.publish(group.id, true, '開発のアイデアを検討します');
    page = await app.inject('/');
    assert.match(page.body, /開発相談室/);
    assert.doesNotMatch(page.body, /相談室を開く|会話に参加・発言する/);
    const snapshot = (await app.inject('/api/site')).json();
    assert.deepEqual(snapshot.rooms, [{ id: group.id, title: '開発相談室', summary: '開発のアイデアを検討します', messages: [{speaker:'Private Person',content:'private-transcript',at:(await groups.load(group.id)).messages[0].at}] }]);
    assert.match(page.body, /private-transcript/);
    assert.doesNotMatch(page.body + JSON.stringify(snapshot), /private-id|秘密のモデル/);
    await groups.publish(group.id, false);
    assert.equal((await app.inject('/api/site')).json().rooms.length, 0);
    assert.doesNotMatch((await app.inject('/')).body, /開発相談室/);
    assert.equal((await groups.load(group.id)).messages.length, 1);
    assert.equal((await app.inject('/api/site-admin')).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/site', payload: {} })).statusCode, 404);
    assert.match(page.headers['content-security-policy']!, /object-src 'none'/);
  } finally { await app.close(); }
}));

test('公開時の参加状態で紹介と発言の2タイルを切り替え、再公開と閉鎖を反映する', async () => temporary(async root => {
  const store = new AgentGroupStore(root), group = await store.create('営業交流', namedMembers(['AI']));
  const app = buildPublicWebsite(root, 'http://127.0.0.1:8787');
  try {
    await store.publish(group.id, true, '紹介', 'offline');
    assert.doesNotMatch((await app.inject('/')).body, /<h3>あなたの発言<\/h3>/);
    await store.publish(group.id, true, '紹介', 'online');
    assert.match((await app.inject('/')).body, /<h3>あなたの発言<\/h3>/);
    const onlinePage = (await app.inject('/')).body;
    assert.match(onlinePage, /name="nickname"/);
    assert.match(onlinePage, /name="content"/);
    assert.doesNotMatch(onlinePage, /相談室を開く|会話に参加・発言する/);
    assert.equal((await app.inject('/api/site')).json().rooms[0].showComposer, true);
    await store.publish(group.id, true, '紹介', 'offline');
    assert.doesNotMatch((await app.inject('/')).body, /<h3>あなたの発言<\/h3>/);
    await store.publish(group.id, false);
    assert.equal((await app.inject('/api/site')).json().rooms.length, 0);
  } finally { await app.close(); }
}));

test('公開投稿はオンライン公開室の許可済み操作だけを認証経路へ転送する', async () => temporary(async root => {
  const groups = new AgentGroupStore(root), group = await groups.create('公開投稿', namedMembers(['AI']));
  const calls: string[] = [];
  const app = buildPublicWebsite(root, 'http://127.0.0.1:8787', async (_req, reply, url) => { calls.push(url); return reply.code(401).send({ error: { message: 'ログインが必要です。' } }); });
  try {
    const url = `/api/site/rooms/${group.id}/messages`;
    assert.equal((await app.inject({ method:'POST', url, payload:{content:'本文'} })).statusCode,403);
    await groups.publish(group.id,true,'紹介','online');
    assert.equal((await app.inject({ method:'POST',url,headers:{origin:'https://evil.example'},payload:{content:'本文'} })).statusCode,403);
    assert.equal(calls.length,0);
    assert.equal((await app.inject({ method:'POST',url,payload:{content:'本文'} })).statusCode,401);
    assert.equal(calls[0],`/api/workbench/groups/${group.id}/messages`);
    assert.equal((await app.inject({ method:'POST',url:`/api/site/rooms/${group.id}/publication`,payload:{} })).statusCode,404);
  } finally { await app.close(); }
}));

test('公開状態を議論中にも変更でき、議論保存で公開状態を巻き戻さない', async () => temporary(async root => {
  const store = new AgentGroupStore(root), group = await store.create('会議', namedMembers(['AI']));
  await store.discuss(group.id, '議題', 1, async () => {
    await store.publish(group.id, true, '途中で公開');
    assert.equal((await store.load(group.id)).publication!.published, true);
    await store.publish(group.id, false);
    return '回答';
  });
  const saved = await store.load(group.id);
  assert.equal(saved.publication!.published, false);
  assert.equal(saved.messages.length, 2);
}));

test('手動設定を永続化し、古い編集案の上書きと実行可能なHTMLを拒否する', async () => temporary(async root => {
  const store = new PublicSiteStore(root), draft = await store.load();
  draft.title = 'カスタムTOP'; draft.theme = 'glass'; draft.layout = 'centered';
  draft.customHtml = '<h2>追加領域</h2><script>alert(1)</script><img src="https://example.com/a.png" onerror="alert(1)">';
  draft.customCss = '.public-hero {padding:60px} </style><script>alert(2)</script>';
  const saved = await store.save(draft);
  assert.equal(saved.revision, 1); assert.equal(saved.theme, 'glass');
  assert.doesNotMatch(saved.customHtml, /<script|onerror/);
  assert.deepEqual(await new PublicSiteStore(root).load(), saved);
  await assert.rejects(store.save(draft), /別の操作/);
  const html = renderPublicHome(saved, [], 'http://127.0.0.1:8787');
  assert.doesNotMatch(html, /<script>alert/);
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
  assert.throws(() => validatePublicSite({ ...saved, sections: [{ title: 'X', text: '', linkLabel: '', href: 'javascript:alert(1)' }] }), /リンク/);
  assert.throws(() => validatePublicSite({ ...saved, accent: 'red;position:fixed' }), /カラー/);
}));

test('管理者の編集・AI相談・自動反映を区別し、一般利用者と別オリジンを拒否する', async () => temporary(async root => {
  const app = Fastify(), store = new PublicSiteStore(root); let calls = 0;
  registerSiteAdmin(app, { workspace: root, gatewayOrigin: () => 'http://127.0.0.1:8787',
    authorize: (req, reply) => { if (req.headers.authorization === 'Bearer admin') return true; reply.code(403).send({ error: { message: '管理者のみ' } }); return false; },
    design: async (_model, messages) => { calls++; assert.match(messages.at(-1)!.content, /青い/); return JSON.stringify({ message: '青い案です。', site: { ...structuredClone(defaultPublicSite), headline: 'AIによる提案', customHtml: '<p>AIの案</p><script>bad()</script>' } }); }
  });
  const headers = { authorization: 'Bearer admin' };
  try {
    assert.equal((await app.inject('/api/site-admin')).statusCode, 403);
    assert.equal((await app.inject({method:'POST',url:'/api/site-admin/export',payload:{}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/site-admin/export',headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode,403);
    const draft = (await app.inject({ url: '/api/site-admin', headers })).json().site;
    const payload = { prompt: '青いページにしてください', model: 'mock/model', draft, history: [] };
    let response = await app.inject({ method: 'POST', url: '/api/site-admin/design', headers, payload });
    assert.equal(response.statusCode, 200); assert.equal(response.json().saved, false);
    assert.equal((await store.load()).revision, 0); assert.equal(response.json().site.headline, 'AIによる提案');
    assert.doesNotMatch(response.json().site.customHtml, /script/);
    response = await app.inject({ method: 'POST', url: '/api/site-admin/design', headers, payload: { ...payload, autoSave: true } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().saved, true);
    assert.ok(response.json().source.files.includes('index.html'));
    assert.equal((await store.load()).headline, 'AIによる提案'); assert.equal(calls, 2);
    response = await app.inject({ method: 'POST', url: '/api/site-admin', headers, payload: draft });
    assert.equal(response.statusCode, 409);
    response = await app.inject({ method: 'POST', url: '/api/site-admin', headers: { ...headers, origin: 'https://evil.example' }, payload: draft });
    assert.equal(response.statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/site-admin/preview', headers, payload: await store.load() })).statusCode, 200);
  } finally { await app.close(); }
}));
