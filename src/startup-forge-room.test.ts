import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { startupForgeRoomHtml } from './startup-forge-room.js';
import { workbenchHtml } from './workbench-ui.js';

test('研究室の背景を群切替と素材の遅延読込・再表示後も保持する', async () => {
  const window = new Window({ url: 'http://localhost/startup-forge#groups' });
  window.localStorage.setItem('wentian-language', 'zh');
  const groups = ['group-11111111-1111-4111-8111-111111111111', 'group-22222222-2222-4222-8222-222222222222'].map(id => ({ id, title: id, members: [], messages: [] }));
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  window.fetch = (async (input: any) => {
    const url = String(input);
    if (url === '/api/visual-assets') { await ready; return new window.Response(JSON.stringify({ assets: [{ id: 'medical-lab', kind: 'background', name: '研究室', url: '/assets/startup-forge/medical-lab.png' }] })); }
    const value = url === '/api/control-center/me' ? { user: { id: 'admin', role: 'admin' } } : url === '/api/workbench' ? { workspace: '.', goals: [], sessions: [], skills: [] } : url === '/api/workbench/groups' ? { groups } : url.endsWith('/group-models') ? { models: [] } : url.endsWith('/forge') ? { state: null } : groups.find(g => url.endsWith(g.id)) || {};
    return new window.Response(JSON.stringify(value));
  }) as any;
  const key = 'wentian-forge-room:' + groups[0].id;
  window.localStorage.setItem(key, JSON.stringify({ scene: 'medical-lab', looks: {} }));
  const html = startupForgeRoomHtml(workbenchHtml);
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise<void>(r => setImmediate(r)); };
  try {
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(m[1]);
    await settle();
    const select = window.document.getElementById('groupSelect') as any;
    select.value = groups[0].id; select.dispatchEvent(new window.Event('change')); await settle();
    assert.equal(JSON.parse(window.localStorage.getItem(key)!).scene, 'medical-lab');
    release(); await settle();
    const background = () => (window.document.getElementById('worldBackdrop') as any).style.backgroundImage;
    assert.match(background(), /medical-lab\.png/);
    select.value = groups[1].id; select.dispatchEvent(new window.Event('change')); await settle();
    assert.match(background(), /office\.png/);
    select.value = groups[0].id; select.dispatchEvent(new window.Event('change')); await settle();
    assert.match(background(), /medical-lab\.png/);
    window.document.dispatchEvent(new window.CustomEvent('wentian-role')); await settle();
    assert.equal(JSON.parse(window.localStorage.getItem(key)!).scene, 'medical-lab');
    assert.match(background(), /medical-lab\.png/);
  } finally { release(); await window.happyDOM.close(); }
});

test('独立した孵化器は5背景・8形象を選択でき、群の実メッセージを安全な漫画気泡へ表示する', async () => {
  const window = new Window({ url: 'http://localhost/startup-forge#groups' });
  window.localStorage.setItem('wentian-language', 'zh');
  const group = { id: 'group-11111111-1111-1111-1111-111111111111', title: '事業相談', members: [{ name: '設計担当', role: '事業設計', model: 'mock' }, { name: '調査担当', role: '公開資料を確認', model: 'mock' }], messages: [{ speaker: '設計担当', content: '<img src=x onerror=alert(1)>最初の構想です。', at: new Date().toISOString() }, { speaker: '利用者', content: '次の検証方法は？', at: new Date().toISOString() }] };
  window.fetch = (async (url: any) => {
    const address = String(url);
    const data = address === '/api/control-center/me' ? { user: { id: 'admin', role: 'admin', displayName: '管理者' } }
      : address === '/api/workbench' ? { workspace: '.', goals: [], sessions: [], skills: [] }
      : address.endsWith('/group-models') ? { models: [] }
      : address === '/api/workbench/groups' ? { groups: [group] }
      : address.endsWith('/forge') ? { state: null }
      : address.endsWith(group.id) ? group : {};
    return new window.Response(JSON.stringify(data));
  }) as typeof window.fetch;
  const html = startupForgeRoomHtml(workbenchHtml);
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(m[1]);
  const settle = async () => { for (let i = 0; i < 35; i++) await new Promise<void>(r => setImmediate(r)); };
  try {
    await settle(); const doc = window.document;
    doc.getElementById('groupSelect')!.dispatchEvent(new window.Event('change')); await settle();
    assert.equal(doc.querySelectorAll('.scene-tab').length, 5);
    assert.equal(doc.querySelectorAll('#worldLook option').length, 8);
    assert.equal(doc.querySelectorAll('.world-actor').length, 2);
    assert.ok(doc.getElementById('worldLog')!.textContent.includes('最初の構想'));
    assert.equal(doc.querySelector('#worldLog img'), null);
    assert.equal(doc.querySelector('.comic-bubble img'), null);
    assert.ok(doc.getElementById('worldNarrator')!.textContent.includes('次の検証方法'));
    assert.equal((doc.getElementById('worldNarrator') as any).hidden, false);
    assert.ok(!doc.getElementById('worldNarrator')!.textContent.includes('历史回放'));
    (doc.getElementById('worldReplay') as any).click();
    assert.ok(doc.querySelector('.comic-bubble:not([hidden])')!.textContent.includes('历史回放'));
    (doc.getElementById('worldReplay') as any).click();
    assert.ok(!doc.getElementById('worldNarrator')!.textContent.includes('历史回放'));
    (doc.querySelector('[data-scene="beach"]') as any).click();
    assert.ok((doc.getElementById('worldBackdrop') as any).style.backgroundImage.includes('beach.png'));
    const look = doc.getElementById('worldLook') as any; look.value = '7'; look.dispatchEvent(new window.Event('change'));
    assert.ok(window.localStorage.getItem('wentian-forge-room:' + group.id)!.includes('7'));
    assert.ok(doc.querySelector('#worldForge #startupForge'));
    assert.ok(doc.querySelector('.nav-rail a[href="/startup-forge"]'));
  } finally { await window.happyDOM.close(); }
});
