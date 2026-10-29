import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { withStartupForge } from './startup-forge-ui.js';

test('Forgeパネルは管理者だけに表示し、生成・登録・実行を独立した操作として送信する', async () => {
  const window = new Window({ url: 'http://localhost/workbench#groups' }), requests: string[] = [];
  (window as any).wentianGroupUser = { role: 'admin' };
  let state: any = null;
  window.fetch = (async (url: any, options: any = {}) => {
    const address = String(url); requests.push(address);
    if (address.endsWith('/plan')) state = { status: 'planning', events: [] };
    if (address.endsWith('/register')) state = { status: 'registered', goalId: 'goal-test', events: [] };
    return new window.Response(JSON.stringify({ state }));
  }) as typeof window.fetch;
  const html = withStartupForge('<html><body><select id="groupSelect"><option value="group-test">群</option></select><div id="groupAutonomyPanel"></div></body></html>');
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(m[1]);
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r)); };
  try {
    await settle(); const doc = window.document;
    assert.equal((doc.getElementById('startupForge') as any).hidden, false);
    (doc.getElementById('forgeBrief') as any).value = '検証する構想'; (doc.getElementById('forgePlan') as any).click(); await settle();
    assert.ok(doc.getElementById('forgeStatus')!.textContent.includes('生成中'));
    (doc.getElementById('forgeRegister') as any).hidden = false; (doc.getElementById('forgeRegister') as any).click(); await settle();
    (doc.getElementById('forgeRun') as any).click(); await settle();
    assert.ok(requests.includes('/api/workbench/goals/goal-test/run'));
    (window as any).wentianGroupUser = { role: 'viewer' }; doc.dispatchEvent(new window.Event('wentian-role')); await settle();
    assert.equal((doc.getElementById('startupForge') as any).hidden, true);
  } finally { await window.happyDOM.close(); }
});
