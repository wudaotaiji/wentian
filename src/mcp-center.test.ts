import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { mcpCenterHtml } from './mcp-center.js';

test('MCP 画面は認証拒否を表示し、空の成功画面にしない', async () => {
  const window = new Window({ url: 'http://localhost/mcp-connections' });
  try {
    window.document.write(mcpCenterHtml.replace(/<script>[\s\S]*?<\/script>/g,''));
    window.fetch = (async () => new window.Response('{}',{ status:401 })) as any;
    const scripts = [...mcpCenterHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
    window.eval(scripts.find(script=>script.includes('const sample='))!);
    await window.happyDOM.waitUntilComplete();
    assert.match(window.document.getElementById('notice')!.textContent!,/HTTP 401/);
    assert.equal(window.document.querySelectorAll('#server option').length,0);
    assert.equal((window.document.getElementById('reload') as any).disabled,false);
  } finally { await window.happyDOM.close(); }
});

test('MCP 画面は変更内容を確認せず承認・実行しない', async () => {
  const window = new Window({ url: 'http://localhost/mcp-connections' }); const requests:string[]=[];
  try {
    window.document.write(mcpCenterHtml.replace(/<script>[\s\S]*?<\/script>/g,''));
    window.fetch = (async (url:any) => { requests.push(String(url)); return new window.Response(JSON.stringify(String(url).endsWith('tools-list')?{tools:[{name:'write'}]}:{servers:[{id:'one',transport:'http',allowedTools:['write'],readOnlyTools:[]}]}),{ status:200 }); }) as any;
    (window as any).confirm = () => false;
    window.eval([...mcpCenterHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).find(script=>script.includes('const sample='))!);
    await window.happyDOM.waitUntilComplete();
    (window.document.getElementById('tools') as any).click(); await window.happyDOM.waitUntilComplete();
    (window.document.getElementById('approve') as any).click(); await window.happyDOM.waitUntilComplete();
    assert.equal(requests.some(url=>url.endsWith('/approve')||url.endsWith('/call')),false);
    assert.match(window.document.getElementById('policy')!.textContent!,/明示承認/);
  } finally { await window.happyDOM.close(); }
});
