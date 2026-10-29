import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { workbenchHtml } from './workbench-ui.js';
import { startupForgeRoomHtml } from './startup-forge-room.js';

const first = 'group-11111111-1111-1111-1111-111111111111';
const second = 'group-22222222-2222-2222-2222-222222222222';
async function fixture(route: string, saved: string, query = '', ids = [first, second]) {
  const window = new Window({ url: 'http://localhost' + route + query + '#groups' });
  const key = 'wentian-selected-group:' + route + ':admin';
  window.localStorage.setItem(key, saved);
  const groups = ids.map(id => ({ id, title: id === first ? '最初の群' : '選択した群', members: [{ name: 'AI', role: '試験', model: 'mock' }], messages: [] }));
  window.fetch = (async (input: any) => {
    const url = String(input);
    const value = url === '/api/control-center/me' ? { user: { id: 'admin', role: 'admin', displayName: '管理者' } }
      : url === '/api/workbench' ? { workspace: '.', goals: [], sessions: [], skills: [] }
      : url === '/api/workbench/groups' ? { groups }
      : url.endsWith('/group-models') ? { models: [] }
      : url === '/api/visual-assets' ? { assets: [] }
      : url === '/api/site-admin' ? { pages: [] }
      : url.endsWith('/forge') ? { state: null }
      : groups.find(g => url.endsWith('/' + g.id)) || {};
    return new window.Response(JSON.stringify(value));
  }) as any;
  const html = route === '/startup-forge' ? startupForgeRoomHtml(workbenchHtml) : workbenchHtml;
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(script[1]);
  const settle = async () => { for (let n = 0; n < 60; n++) await new Promise<void>(r => setImmediate(r)); };
  await settle();
  return { window, key, settle, select: window.document.getElementById('groupSelect') as any };
}

for (const route of ['/startup-forge', '/workbench']) {
  test(route + ' は保存した群を初回の一覧読込で復元し、一覧更新後も保持する', async () => {
    const f = await fixture(route, second);
    try {
      assert.equal(f.select.value, second);
      (f.window.document.getElementById('groupRefresh') as any).click(); await f.settle();
      assert.equal(f.select.value, second);
      f.select.value = first; f.select.dispatchEvent(new f.window.Event('change')); await f.settle();
      assert.equal(f.window.localStorage.getItem(f.key), first);
    } finally { await f.window.happyDOM.close(); }
  });
  test(route + ' は明示URLを保存値より優先し、削除済みの群なら最初の群へ戻す', async () => {
    const linked = await fixture(route, second, '?group=' + first);
    try { assert.equal(linked.select.value, first); } finally { await linked.window.happyDOM.close(); }
    const removed = await fixture(route, second, '', [first]);
    try { assert.equal(removed.select.value, first); assert.equal(removed.window.localStorage.getItem(removed.key), first); } finally { await removed.window.happyDOM.close(); }
  });
}
