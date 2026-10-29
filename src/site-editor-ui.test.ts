import assert from 'node:assert/strict';
import test from 'node:test';
import { Window, HTMLInputElement, HTMLButtonElement, HTMLIFrameElement } from 'happy-dom';
import { managerDashboardHtml } from './dashboard.js';
import { defaultPublicSite, renderPublicHome } from './public-site.js';

// 編集UI（User Interface）を通して手動保存・AI相談・自動保存の違いを検証します。
test('トップ編集の手動操作とAI相談をプレビューに反映する', async () => {
  const window = new Window({ url: 'http://127.0.0.1:8787/#site' });
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  let saved = structuredClone(defaultPublicSite), calls: any[] = [];
  const pages = [{slug:'',title:saved.title,href:'/'}];
  window.fetch = (async (url: unknown, options: any = {}) => {
    const address = String(url).split('?')[0], payload = options.body ? JSON.parse(options.body) : undefined;
    let body: unknown = {};
    if (address.endsWith('/me')) body = { user: { id: 'admin', displayName: '管理者', role: 'admin' } };
    else if (address.endsWith('/status')) body = { needsSetup: false };
    else if (address === '/api/site-admin/trash') body={items:[]};
    else if (address === '/api/site-admin/delete') {calls.push({closed:new URL(String(url),'http://localhost').searchParams.get('page')});pages.splice(pages.findIndex(p=>p.slug===calls.at(-1).closed),1);body={trash:'test-trash'};}
    else if (address === '/api/site-admin/preview') return new window.Response('<html><body>' + payload.headline + '</body></html>', { status: 200 });
    else if (address === '/api/site-admin/export') body = {source:{directory:'C:/検証/sites/home/revision-1',files:['index.html','styles.css','site.json','README.md']}};
    else if (address === '/api/site-admin/templates') {
      if(payload){calls.push(payload);pages.push({slug:payload.slug,title:payload.title,href:'/sites/'+payload.slug+'/'});saved={...structuredClone(defaultPublicSite),title:payload.title,revision:1};body={site:saved,slug:payload.slug};}
      else body = {templates:[{id:'aurora',name:'Aurora AI',description:'完成済みデザイン',background:'#142342',accent:'#9baaff'}]};
    }
    else if (address === '/api/site-admin/files/connect') body = {id:'test-folder',root:'C:/Apache/htdocs',files:['index.html']};
    else if (address === '/api/site-admin/files/read') body = {name:'index.html',content:'<h1>Apache原本</h1>',version:'version-1'};
    else if (address === '/api/site-admin/files/save') {calls.push(payload);body={...payload,version:'version-2',backup:'C:/検証/backup'};}
    else if (address === '/api/site-admin/design') {
      calls.push(payload); const proposed = { ...payload.draft, headline: 'AIで相談したデザイン' };
      if (payload.autoSave) { proposed.revision++; saved = proposed; }
      body = { site: proposed, message: '相談に沿ったデザインです。', saved: Boolean(payload.autoSave) };
    } else if (address === '/api/site-admin') {
      if (payload) { saved = { ...payload, revision: saved.revision + 1 }; calls.push(payload); }
      body = { site: saved, rooms: [], pages };
    } else if (address === '/api/workbench/models') body = { models: [{ id: 'mock/model' }] };
    else if (address === '/v1/models') body = [];
    else if (address === '/api/control-center/users') body = [];
    else if (address.includes('agent-marketplace')) body = { candidates: [] };
    else if (address.includes('external-agents')) body = { agents: [], summary: {} };
    return new window.Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    for (const match of managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(match[1]);
    const settle = async () => { for (let i = 0; i < 25; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
    await settle(); const doc = window.document;
    assert.equal(doc.getElementById('viewTitle')!.textContent, 'サイト編集');
    assert.equal(doc.querySelector('.nav-rail [data-view=site]')!.hasAttribute('hidden'), false);
    (doc.getElementById('siteExport') as HTMLButtonElement).click(); await settle();
    assert.match(doc.getElementById('siteSourcePath')!.textContent!, /C:\/検証\/sites\/home\/revision-1/);
    assert.match(doc.getElementById('siteSourcePath')!.textContent!, /index.html/);
    assert.match(doc.getElementById('siteTemplates')!.textContent!, /Aurora AI/);
    (doc.getElementById('siteDirectory') as HTMLInputElement).value='C:/Apache/htdocs';
    (doc.getElementById('siteConnect') as HTMLButtonElement).click();await settle();
    assert.equal((doc.getElementById('siteExternalCode') as HTMLInputElement).value,'<h1>Apache原本</h1>');
    (doc.getElementById('siteExternalCode') as HTMLInputElement).value='<h1>編集後</h1>';
    (doc.getElementById('siteExternalSave') as HTMLButtonElement).click();await settle();
    assert.equal(calls.at(-1).content,'<h1>編集後</h1>');
    assert.match(doc.getElementById('siteExternalStatus')!.textContent!,/backup/);
    (doc.getElementById('siteDisconnect') as HTMLButtonElement).click();
    assert.equal((doc.getElementById('siteExternalCode') as HTMLInputElement).value,'');
    const headline = doc.getElementById('siteHeadline') as HTMLInputElement;
    headline.value = '手動で変更したTOP';
    (doc.getElementById('siteSave') as HTMLButtonElement).click(); await settle();
    assert.equal(saved.headline, '手動で変更したTOP');
    assert.match((doc.getElementById('siteFrame') as HTMLIFrameElement).srcdoc, /手動で変更したTOP/);
    assert.equal((doc.getElementById('siteFrame') as HTMLIFrameElement).getAttribute('sandbox'), 'allow-same-origin');
    // プレビュー文書の実要素へポインター（Pointer）操作を送り、座標とコードが保存されることを確認します。
    const previewWindow = new Window();
    previewWindow.document.write(renderPublicHome(saved, [], 'http://127.0.0.1:8787', true).replace(/<script>[\s\S]*?<\/script>/g, ''));
    const frame = doc.getElementById('siteFrame') as HTMLIFrameElement;
    Object.defineProperty(frame, 'contentDocument', { value: previewWindow.document, configurable: true });
    (frame.onload as any)(new window.Event('load'));
    const tile = previewWindow.document.querySelector('[data-site-tile="section-0"]')!;
    const originalY = Number((tile as any).dataset.y);
    tile.dispatchEvent(new previewWindow.PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 20, bubbles: true, cancelable: true }));
    previewWindow.document.dispatchEvent(new previewWindow.PointerEvent('pointermove', { clientX: 120, clientY: 90 }));
    previewWindow.document.dispatchEvent(new previewWindow.PointerEvent('pointerup'));
    assert.equal((doc.getElementById('siteTileX') as HTMLInputElement).value, '100');
    assert.equal((doc.getElementById('siteTileY') as HTMLInputElement).value, String(originalY + 70));
    tile.querySelector('[data-tile-resize]')!.dispatchEvent(new previewWindow.PointerEvent('pointerdown', { button: 0, clientX: 120, clientY: 90, bubbles: true, cancelable: true }));
    previewWindow.document.dispatchEvent(new previewWindow.PointerEvent('pointermove', { clientX: 220, clientY: 130 }));
    previewWindow.document.dispatchEvent(new previewWindow.PointerEvent('pointerup'));
    assert.equal((doc.getElementById('siteTileWidth') as HTMLInputElement).value, '488');
    assert.equal((doc.getElementById('siteTileHeight') as HTMLInputElement).value, '260');
    (doc.getElementById('siteTileHtml') as HTMLInputElement).value = '<h3>手動で編集したタイル</h3>';
    (doc.getElementById('siteTileCss') as HTMLInputElement).value = 'background: #e8f1ff;';
    (doc.getElementById('siteTileApply') as HTMLButtonElement).click();
    (doc.getElementById('siteSave') as HTMLButtonElement).click(); await settle();
    assert.equal(saved.tiles!['section-0'].x, 100);
    assert.equal(saved.tiles!['section-0'].width, 488);
    assert.equal(saved.tiles!['section-0'].html, '<h3>手動で編集したタイル</h3>');
    await previewWindow.happyDOM.close();
    assert.equal((doc.getElementById('siteAutoSave') as HTMLInputElement).checked, true);
    (doc.getElementById('siteAutoSave') as HTMLInputElement).checked = false;
    const tileSelect = doc.getElementById('siteTileSelect') as HTMLInputElement;
    tileSelect.value = 'hero'; tileSelect.dispatchEvent(new window.Event('change'));
    (doc.getElementById('siteDesignPrompt') as HTMLInputElement).value = '青を中心にしてください';
    doc.getElementById('siteDesignForm')!.dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
    assert.equal(headline.value, 'AIで相談したデザイン');
    assert.equal(saved.headline, '手動で変更したTOP');
    assert.equal(calls.at(-1).model, undefined);
    assert.equal(calls.at(-1).tileId, 'hero');
    assert.equal(doc.getElementById('siteDesignModel'), null);
    assert.match(doc.getElementById('siteAiLog')!.textContent!, /相談に沿ったデザイン/);
    (doc.getElementById('siteAutoSave') as HTMLInputElement).checked = true;
    (doc.getElementById('siteDesignPrompt') as HTMLInputElement).value = 'もっとシンプルに';
    doc.getElementById('siteDesignForm')!.dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
    assert.equal(saved.headline, 'AIで相談したデザイン');
    assert.equal(calls.at(-1).history.length, 2);
    assert.equal(calls.at(-1).autoSave, true);
    (doc.getElementById('siteAddSection') as HTMLButtonElement).click();
    assert.equal(doc.getElementById('siteSections')!.children.length, 4);
    // テンプレート（Template）のクリックから編集準備と一覧リンクまでを検証します。
    (doc.getElementById('siteNewSlug') as HTMLInputElement).value='Iceberg';
    (doc.getElementById('siteNewTitle') as HTMLInputElement).value='Iceberg サイト';
    (doc.querySelector('#siteTemplates button') as HTMLButtonElement).click(); await settle();
    assert.equal(calls.at(-1).slug,'iceberg');
    assert.equal((doc.getElementById('sitePage') as HTMLInputElement).value,'iceberg');
    assert.equal((doc.getElementById('siteTitle') as HTMLInputElement).value,'Iceberg サイト');
    assert.match(doc.getElementById('siteTemplateStatus')!.textContent!,/準備ができました/);
    assert.ok(doc.querySelector('#siteList a[href="/sites/iceberg/"]'));
    assert.equal((doc.getElementById('siteSave') as HTMLButtonElement).disabled,false);
    // 一覧（Site List）の行から対象を引き継ぎ、確認取消では閉鎖しないことを検証します。
    (doc.querySelector('.nav-rail [data-view="site-list"]') as HTMLButtonElement).click();await settle();
    assert.equal(doc.getElementById('siteListPanel')!.closest('.nav-view')!.getAttribute('data-view'),'site-list');
    const target=doc.querySelector('#siteList a[href="/sites/iceberg/"]')!.parentElement!;
    (target.querySelector('button') as HTMLButtonElement).click();await settle();
    assert.equal(window.location.hash,'#site');
    let confirmation='';Object.defineProperty(window,'confirm',{value:(message:string)=>{confirmation=message;return false},configurable:true});
    (target.querySelectorAll('button')[1] as HTMLButtonElement).click();await settle();
    assert.match(confirmation,/Iceberg サイト/);assert.match(confirmation,/iceberg/);
    assert.notEqual(calls.at(-1).closed,'iceberg');
    Object.defineProperty(window,'confirm',{value:()=>true,configurable:true});
    (target.querySelectorAll('button')[1] as HTMLButtonElement).click();await settle();
    assert.equal(calls.at(-1).closed,'iceberg');assert.equal(window.location.hash,'#site-list');
    assert.equal(doc.querySelector('#siteList a[href="/sites/iceberg/"]'),null);

  } finally { await window.happyDOM.close(); }
});
