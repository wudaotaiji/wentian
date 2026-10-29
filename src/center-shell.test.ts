import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { operationsHtml } from './operations-center.js';
import { workflowCenterHtml } from './workflow-center.js';
import { projectCenterHtml } from './project-center.js';
import { controlCenterViews, workbenchViews } from './navigation-ui.js';

test('3画面を移動しても目的別メニューとホームへの入口を維持する', async () => {
  // ホームは先頭の共通項目へ統合し、下部に同じ目的のリンクを重複させません。
  const expected: string[][] = [];
  for (const [url, html] of [['/operations', operationsHtml], ['/workflows', workflowCenterHtml], ['/projects', projectCenterHtml]]) {
    const window = new Window();
    try {
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
      const links = [...window.document.querySelectorAll('.nav-bottom a')];
      const menus = [...window.document.querySelectorAll('.nav-rail nav a')];
      const views = menus.filter(link => link.hasAttribute('data-view'));
      assert.deepEqual(views.map(link => [link.getAttribute('href'), link.textContent]).sort(), [...controlCenterViews.map(([id,label]) => ['/#' + id, label]), ...workbenchViews.filter(([id]) => ['tasks','groups','skills'].includes(id)).map(([id,label]) => ['/workbench#' + id, label])].sort());
      for (const target of ['/operations','/workflows','/projects','/mcp-connections']) {
        assert.equal(window.document.querySelectorAll(`.nav-rail nav a[href="${target}"]`).length, 1);
      }
      assert.equal(window.document.querySelector('body > header h1')?.textContent, 'Wentian');
      assert.ok(window.document.querySelector('main > .view-head #viewTitle')?.textContent);
      for (const id of ['language','theme','centerUser','centerRefresh','centerLogout','navSearch','navResults']) assert.equal(window.document.querySelectorAll('#'+id).length, 1, id);
      assert.deepEqual(links.map(link => [link.getAttribute('href'), link.textContent]), expected);
      assert.equal(window.document.querySelector('.nav-rail nav a[aria-current="page"]')?.getAttribute('href'), url);
      for (const [target] of expected) assert.equal(window.document.querySelectorAll(`.nav-rail a.nav-link[href="${target}"]`).length, 1);
    } finally { await window.happyDOM.close(); }
  }
});

test('共通検索・管理者項目の権限制御・更新操作が3画面で動く', async () => {
  for (const html of [operationsHtml, workflowCenterHtml, projectCenterHtml]) {
    const window = new Window({ url: 'http://127.0.0.1:8787/projects' });
    try {
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
      window.eval(`window.fetch=async()=>({ok:true,json:async()=>({user:{displayName:'検証',role:'viewer'}})});`);
      window.eval([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]);
      await window.happyDOM.whenAsyncComplete();
      const doc = window.document;
      assert.equal((doc.querySelector('[data-view=users]') as unknown as { hidden: boolean }).hidden, true);
      assert.equal((doc.querySelector('[data-view=site]') as unknown as { hidden: boolean }).hidden, true);
      const search = doc.getElementById('navSearch') as unknown as {value: string;dispatchEvent: (event: Event) => boolean};
      search.value = 'エージェント'; search.dispatchEvent(new window.Event('input') as unknown as Event);
      assert.equal(doc.querySelectorAll('#navResults button').length, 2);
      search.value = 'ユーザー管理'; search.dispatchEvent(new window.Event('input') as unknown as Event);
      assert.equal(doc.querySelectorAll('#navResults button').length, 0);
      doc.dispatchEvent(new window.KeyboardEvent('keydown', {key:'k',ctrlKey:true}));
      assert.equal(doc.activeElement?.id, 'navSearch');
      assert.ok((doc.getElementById('centerRefresh') as unknown as {onclick: unknown}).onclick);
    } finally { await window.happyDOM.close(); }
  }
});
