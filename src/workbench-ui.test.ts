import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import Fastify from 'fastify';
import { workbenchHtml } from './workbench-ui.js';
import { registerWorkbench } from './workbench.js';
import { Window, HTMLButtonElement } from 'happy-dom';

test('削除操作は確認取消・実行中を拒否し、最後のタスク削除後に詳細をクリアする', async () => {
  const window = new Window({ url: 'http://127.0.0.1:8787/workbench' });
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  let deleted = false, confirmations = 0, approved = false;
  const goal = { id: 'goal-2026-10-04-delete-abc', title: '削除テスト', description: '説明', running: false, status: 'paused', todos: [], metrics: { completedCount: 0, totalAttempts: 0 }, stop: { maxTotalAttempts: 10 } };
  const snapshot = () => ({ goals: deleted ? [] : [goal], workspace: 'test', skills: [], sessions: [] });
  window.fetch = (async (url: any) => {
    const address = String(url);
    if (address.endsWith('/delete')) { deleted = true; return new window.Response(JSON.stringify({ deleted: true })); }
    if (address === '/api/workbench') return new window.Response(JSON.stringify(snapshot()));
    if (address.endsWith('/me')) return new window.Response('{}', { status: 401 });
    return new window.Response(JSON.stringify({ needsSetup: false, text: '' }));
  }) as typeof window.fetch;
  Object.assign(window, { confirm: () => { confirmations++; return approved; } });
  try {
    window.document.write(workbenchHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const script = [...workbenchHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('function render(){const goals=state.goals'))![1];
    window.eval(script + `\nstate=${JSON.stringify(snapshot())};render();window.testRunning=value=>{state.goals[0].running=value;render()};`);
    const button = window.document.getElementById('deleteTask') as HTMLButtonElement;
    button.click(); assert.equal(deleted, false); assert.equal(confirmations, 1);
    (window as any).testRunning(true);
    assert.equal(button.disabled, true); button.click(); assert.equal(confirmations, 1);
    (window as any).testRunning(false);
    approved = true; button.click();
    for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(deleted, true);
    assert.equal(button.disabled, true);
    assert.equal(window.document.getElementById('detailTitle')!.textContent, 'タスクを選択');
    assert.equal(window.document.getElementById('detailDescription')!.textContent, '');
  } finally { await window.happyDOM.close(); }
});

test('複数選択は更新後も保持し、表示中の停止済みタスクだけ全選択して一括削除する', async () => {
  const window = new Window({ url: 'http://127.0.0.1:8787/workbench' });
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  let approved = false;
  const requests: string[][] = [];
  let goals = ['one', 'two', 'running'].map(id => ({ id, title: id, description: '', running: id === 'running', status: 'paused', todos: [], metrics: { completedCount: 0, totalAttempts: 0 }, stop: { maxTotalAttempts: 10 } }));
  const snapshot = () => ({ goals, workspace: 'test', skills: [], sessions: [] });
  Object.assign(window, { confirm: () => approved });
  window.fetch = (async (url: any, options: any) => {
    const address = String(url);
    if (address.endsWith('/bulk-delete')) {
      const ids = JSON.parse(options.body).ids as string[]; requests.push(ids); goals = goals.filter(goal => !ids.includes(goal.id));
      return new window.Response(JSON.stringify({ deleted: ids, failed: [] }));
    }
    if (address === '/api/workbench') return new window.Response(JSON.stringify(snapshot()));
    if (address.endsWith('/me')) return new window.Response('{}', { status: 401 });
    return new window.Response(JSON.stringify({ needsSetup: false, text: '' }));
  }) as typeof window.fetch;
  try {
    window.document.write(workbenchHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const script = [...workbenchHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('function render(){const goals=state.goals'))![1];
    window.eval(script + `\nstate=${JSON.stringify(snapshot())};render();window.testRender=()=>render();`);
    const doc = window.document;
    const click = (id: string) => (doc.getElementById(id) as HTMLButtonElement).click();
    const checkbox = (id: string) => doc.querySelector(`input[data-task-id="${id}"]`) as any;
    assert.equal(checkbox('running').disabled, true);
    doc.querySelectorAll('.task-row')[1].setAttribute('hidden', '');
    click('selectTasks');
    assert.equal(checkbox('one').checked, true); assert.equal(checkbox('two').checked, false);
    (window as any).testRender(); assert.equal(checkbox('one').checked, true);
    click('clearTasks'); assert.equal(checkbox('one').checked, false);
    click('selectTasks');
    click('deleteTasks'); assert.equal(requests.length, 0);
    approved = true; click('deleteTasks');
    for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(requests, [['one', 'two']]);
    assert.equal(doc.querySelectorAll('#tasks input').length, 1);
    assert.equal((doc.getElementById('deleteTasks') as HTMLButtonElement).disabled, true);
    assert.equal(doc.getElementById('taskSelection')!.textContent, '0件選択');
  } finally { await window.happyDOM.close(); }
});

test('工作台の日本語をUnicodeエスケープ文字列として表示せず、埋め込みコードも有効にする', async () => {
  assert.match(workbenchHtml, /0\.6 · 計画から、確かめられる成果へ/);
  assert.match(workbenchHtml, /AI会話グループ/);
  assert.doesNotMatch(workbenchHtml, /\\u[0-9a-f]{4}/i);
  new Script(workbenchHtml.match(/<script>([\s\S]*?)<\/script>/)![1]);
  const app = Fastify();
  registerWorkbench(app, { workspace: process.cwd(), authorize: () => true, models: async () => [], providerSaved: () => {}, testModel: async () => '' });
  try {
    const response = await app.inject('/workbench');
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type']!, /text\/html; charset=utf-8/);
    assert.match(response.body, /計画から、確かめられる成果へ/);
  } finally { await app.close(); }
});
