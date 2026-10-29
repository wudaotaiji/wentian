import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { cloudFederationHtml } from './cloud-federation/ui.js';

test('分散Cloud画面は目的だけをA2Aへ渡し、グループ確認への入口と未確認状態を表示する', async () => {
  const window = new Window({ url: 'http://127.0.0.1:8787/cloud-federation' });
  const requests: Array<{ url: string; body: any }> = [];
  const state = { identity: { nodeId: '試験ノード', publicKey: '公開鍵' }, resources: {}, policy: { enabled: false, maxConcurrent: 1, minFreeMemoryBytes: 1024 ** 3, minFreeDiskBytes: 1024 ** 3 }, peers: [], orders: [], outbound: [] };
  window.fetch = (async (url: unknown, options: any = {}) => {
    const address = String(url), body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url: address, body });
    const result = address === '/api/control-center/me' ? { user: { role: 'admin' } } : address === '/api/cloud-federation/a2a' ? { state: 'paused', reason: '相手から追加情報が必要です。' } : state;
    return new window.Response(JSON.stringify(result), { status: 200 });
  }) as typeof window.fetch;
  const settle = async () => { for (let index = 0; index < 20; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
  try {
    window.document.write(cloudFederationHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    for (const script of cloudFederationHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(script[1]);
    await settle();
    assert.equal((window.document.getElementById('content') as any).hidden, false);
    const objective = window.document.getElementById('a2aObjective') as any; objective.value = '相手のWentianへ相談して文章を照合したい';
    window.document.getElementById('a2aForm')!.dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
    const sent = requests.find(request => request.url === '/api/cloud-federation/a2a')!;
    assert.equal(sent.body.objective, objective.value); assert.equal(typeof sent.body.sessionId, 'string');
    assert.equal(sent.body.task, undefined);
    assert.ok(window.document.getElementById('sessions')!.textContent.includes('追加情報'));
    assert.ok(window.document.querySelector('a[href="/workbench#groups"]'));
  } finally { await window.happyDOM.close(); }
});
