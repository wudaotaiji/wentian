import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { managerDashboardHtml } from './dashboard.js';

test('チャットの予算・ツール設定と動的状態は選択言語へ揃い、パスと値を変更しない', async () => {
  const window = new Window({ url: 'http://localhost/#chat' });
  window.localStorage.setItem('wentian-language', 'en');
  window.fetch = (async () => new window.Response(JSON.stringify({ workspace: 'C:/研究室' }))) as any;
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const scripts = [...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    for (const source of scripts.filter(s => s.includes('window.wentianUi={t,apply,language}') || s.includes('window.wentianChatAgentRequest=payload') || s.includes('window.wentianChatRoute=response'))) window.eval(source);
    const doc = window.document;
    for (const language of ['en', 'zh', 'ja', 'en']) {
      window.localStorage.setItem('wentian-language', language);
      (window as any).wentianUi.apply();
      doc.dispatchEvent(new window.Event('wentian-language-changed'));
      if (language === 'en') {
        const budget = doc.getElementById('chatDifficulty')!.closest('details')!;
        assert.match(budget.textContent, /Difficulty & Execution Budget/);
        const controls = budget.textContent + doc.getElementById('chatToolSettings')!.textContent + (doc.getElementById('chatReadPaths') as any).placeholder;
        assert.doesNotMatch(controls, /[\u3040-\u30ff\u3400-\u9fff]/);
        assert.equal((doc.getElementById('chatDifficulty') as any).placeholder, 'Automatic');
        assert.equal((doc.getElementById('chatCost') as any).placeholder, 'Not Set');
        assert.match((window as any).wentianChatModelLabel('wentian-auto/local'), /local only/);
      }
    }
    const mode = doc.getElementById('chatMode') as any; mode.value = 'act'; mode.dispatchEvent(new window.Event('change'));
    for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r));
    assert.match(doc.getElementById('chatWorkspace')!.textContent, /Workspace: C:\/研究室 \/ Plan: research only/);
    (window as any).wentianChatToolEvent({ type: 'tool_start', name: 'read_file', arguments: '原文ログ' });
    assert.equal(doc.querySelector('#chatToolLog summary')!.textContent, 'Execution started: read_file');
    assert.equal(doc.querySelector('#chatToolLog pre')!.textContent, '原文ログ');
    assert.equal((doc.getElementById('chatAttempts') as any).value, '3');
    assert.equal((doc.getElementById('chatTokens') as any).value, '500000');
  } finally { await window.happyDOM.close(); }
});

test('会話はChatを既定とし、未編集の予算だけを暗黙指定から外す', async () => {
  const window = new Window({ url: 'http://localhost/#chat' });
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const script = [...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('window.wentianChatAgentRequest=payload'))!;
    window.eval(script[1]);
    const routeScript = [...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('window.wentianChatRoute=response'))!;
    window.eval(routeScript[1]);
    (window as any).wentianChatRoute(new window.Response('', { headers: { 'x-wentian-resolved-model': 'external/codex', 'x-wentian-fallback': 'external-agent' } }));
    assert.match(window.document.getElementById('chatSource')!.textContent, /external\/codex.*外部Agent/);
    (window as any).wentianChatRoute();
    assert.equal(window.document.getElementById('chatSource')!.textContent, '');
    assert.match((window as any).wentianChatModelLabel('wentian-auto/local'), /ローカルのみ/);
    const doc = window.document, request = (window as any).wentianChatAgentRequest;
    const payload = { model: 'wentian-auto/local', messages: [{ role: 'user', content: '你好！' }], wentian_budget: { maxAttempts: 3, maxRuntimeMs: 600000, maxTokens: 500000 }, stream: true };
    assert.equal((doc.getElementById('chatMode') as any).value, 'chat');
    assert.equal(request(payload).wentian_budget, undefined);
    const lower = { ...payload, wentian_budget: { ...payload.wentian_budget, maxTokens: 1000 } };
    assert.deepEqual(request(lower).wentian_budget, lower.wentian_budget);
    assert.deepEqual(request(payload).messages, payload.messages);
    // 利用者が上限に触れた場合は、初期値と同じ数値でも明示指定として保持します。
    doc.getElementById('chatTokens')!.dispatchEvent(new window.Event('input'));
    assert.deepEqual(request(payload).wentian_budget, payload.wentian_budget);
    (doc.getElementById('chatMode') as any).value = 'plan';
    assert.deepEqual(request(payload).options.wentian_budget, payload.wentian_budget);
  } finally { await window.happyDOM.close(); }
});

test('本人の知識庫を選ぶとChatをPlan経路へ送り、切替時は古い会話を消す', async () => {
  const window = new Window({ url: 'http://localhost/#chat' });
  window.fetch = (async () => new window.Response(JSON.stringify({ projects: [{ id: 'alpha', name: '本人の資料' }] }))) as any;
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const script = [...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m => m[1].includes('window.wentianChatAgentRequest=payload'))!;
    window.eval(script[1]);
    const doc = window.document;
    const details = doc.getElementById('chatToolSettings') as any;
    details.open = true; details.dispatchEvent(new window.Event('toggle'));
    for (let i = 0; i < 20; i++) await new Promise<void>(r => setImmediate(r));
    const project = doc.getElementById('chatKnowledgeProject') as any;
    assert.equal(project.options.length, 2);
    let resets = 0; doc.getElementById('chatNew')!.addEventListener('click', () => resets++);
    project.value = 'alpha'; project.dispatchEvent(new window.Event('change'));
    assert.equal(resets, 1);
    const request = (window as any).wentianChatAgentRequest;
    const payload = { model: 'mock', messages: [{ role: 'user', content: '資料で調べて' }] };
    assert.equal(request(payload).mode, 'plan');
    assert.equal(request(payload).knowledgeProjectId, 'alpha');
    (doc.getElementById('chatMode') as any).value = 'act';
    assert.equal(request(payload).mode, 'act');
    project.value = '';
    (doc.getElementById('chatMode') as any).value = 'chat';
    assert.equal(request(payload).knowledgeProjectId, undefined);
    assert.equal(request(payload).mode, undefined);
  } finally { await window.happyDOM.close(); }
});

test('実際の送信処理は選択した知識庫を会話Agent APIへ送る', async () => {
  const window = new Window({ url: 'http://localhost/#chat' });
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const scripts = [...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    window.eval(scripts.find(s => s.includes('window.wentianChatAgentRequest=payload'))!);
    const send = scripts.find(s => s.includes('async function sendChat()'))!.split('\n').find(line => line.startsWith('async function sendChat()'))!;
    window.eval(`const $=id=>document.getElementById(id);const t=v=>v;let chatMessages=[];function addChatMessage(role,text){const node=document.createElement('div');node.textContent=text;document.getElementById('chatLog').append(node);return node}\n${send}\nwindow.testSendChat=sendChat;`);
    const project = window.document.getElementById('chatKnowledgeProject') as any;
    const option = window.document.createElement('option'); option.value = 'alpha'; option.textContent = '本人の資料'; project.append(option); project.value = 'alpha';
    let sent = false;
    window.fetch = (async (url: string, options: any) => {
      assert.equal(url, '/api/chat/agent');
      const body = JSON.parse(options.body);
      assert.equal(body.knowledgeProjectId, 'alpha'); assert.equal(body.mode, 'plan');
      assert.equal(project.disabled, true); sent = true;
      let delivered = false;
      return { ok: true, headers: new window.Headers(), body: { getReader: () => ({ read: async () => delivered ? { done: true } : (delivered = true, { done: false, value: new TextEncoder().encode('data: {"type":"final","content":"引用付き回答"}\n\n') }) }) } };
    }) as any;
    (window.document.getElementById('chatInput') as any).value = '資料を確認して';
    await (window as any).testSendChat();
    assert.equal(sent, true);
    assert.equal(project.disabled, false);
    assert.match(window.document.getElementById('chatLog')!.textContent, /引用付き回答/);
  } finally { await window.happyDOM.close(); }
});
