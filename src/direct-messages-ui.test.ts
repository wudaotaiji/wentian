import test from 'node:test';
import assert from 'node:assert/strict';
import { Window, HTMLSelectElement, HTMLTextAreaElement, HTMLButtonElement } from 'happy-dom';
import { directMessagesHtml } from './direct-messages-ui.js';

test('私聊画面で相手を選び送信し、本文を安全表示し、認証失効後は履歴を隠す', async () => {
  const window = new Window({ url: 'http://localhost/direct-messages' });
  const intervals: Array<() => Promise<void>> = [];
  window.setInterval = ((callback: () => Promise<void>) => { intervals.push(callback); return 0; }) as any;
  window.localStorage.setItem('wentian-language', 'zh');
  let expired = false;
  const messages: any[] = [], requests: string[] = [];
  window.fetch = (async (input: unknown, options: any = {}) => {
    const url = String(input); requests.push(url);
    if (expired && url.startsWith('/api/direct-messages')) return new window.Response(JSON.stringify({ error: { message: '失効' } }), { status: 401 });
    const thread = { id: 'abc', participants: ['a', 'b'], messages };
    let data: any = {};
    if (url === '/api/control-center/me') data = { user: { id: 'a', role: 'viewer', displayName: '甲' } };
    else if (url === '/api/direct-messages' && !options.body) data = { me: { id: 'a', name: '甲' }, people: [{ id: 'b', name: '乙' }], threads: [{ ...thread, count: messages.length }] };
    else if (url === '/api/direct-messages/abc/messages') { messages.push({ senderId: 'a', content: JSON.parse(options.body).content, at: new Date().toISOString() }); data = thread; }
    else data = thread;
    return new window.Response(JSON.stringify(data), { status: 200 });
  }) as typeof window.fetch;
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    window.document.write(directMessagesHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    for (const script of directMessagesHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(script[1]);
    await settle(); const doc = window.document;
    assert.equal(doc.getElementById('title')!.textContent, '私聊');
    (doc.getElementById('peer') as HTMLSelectElement).value = 'b'; (doc.getElementById('open') as HTMLButtonElement).click(); await settle();
    (doc.getElementById('content') as HTMLTextAreaElement).value = '<img src=x onerror=alert(1)>秘密';
    doc.getElementById('sendForm')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.match(doc.getElementById('history')!.textContent!, /秘密/); assert.equal(doc.querySelector('#history img'), null);
    assert.equal(requests.some(url => /workbench.*messages|chat\/completions/.test(url)), false);
    expired = true; await intervals.at(-1)!(); await settle();
    assert.equal(doc.getElementById('history')!.textContent, ''); assert.equal((doc.getElementById('send') as HTMLButtonElement).disabled, true);
  } finally { await window.happyDOM.close(); }
});
