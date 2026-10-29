/**
 * 並列工程編集画面（Workflow Center）の試験
 *
 * 1) Fastify注入（Fastify inject）: GET /workflows の権限・CSP・配信内容を確認。
 * 2) happy-dom操作: 実サーバー起動なしで、画面のfetchをFastify injectへ橋渡し（Bridge）し、
 *    作成 → 初回実行 → 失敗 → 失敗だけ再試行（Partial Re-run）までを実エンジン・実ファイルで検証する。
 *    （外部ネットワーク・外部サービスは一切使わない / Offline only）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Window, HTMLTextAreaElement, HTMLInputElement } from 'happy-dom';
import { registerParallelWorkflowRoutes } from './parallel-workflow-routes.js';
import { registerWorkflowCenter, workflowCenterHtml } from './workflow-center.js';

/** 画面のfetch要求をFastify injectへ変換し、試験でも実API経路（Real Code Path）を通す。 */
function bridge(window: Window, app: ReturnType<typeof Fastify>, admin: boolean) {
  window.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const injection = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST', url: String(url),
      headers: admin ? { 'x-test-admin': 'yes' } : {},
      payload: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new window.Response(injection.body, { status: injection.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;
}

/** 配信HTMLをhappy-domへ読み込み、内联スクリプト（Inline Script）だけを実行する。 */
async function openWindow(app: ReturnType<typeof Fastify>, admin: boolean) {
  const window = new Window({ url: 'http://127.0.0.1:8787/workflows' });
  window.setInterval = (() => 0) as unknown as typeof window.setInterval; // 自動更新タイマーを作らせない
  bridge(window, app, admin);
  window.document.write(workflowCenterHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const match of workflowCenterHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(match[1]);
  return window;
}

/** 画面側fetch（非同期）が落ち着くまで待って条件文字列を返す（実I/O進む5ms間隔ポーリング）。 */
async function until(window: Window, probe: () => string | undefined, label: string): Promise<string> {
  for (let i = 0; i < 1200; i++) { const value = probe(); if (value !== undefined) return value; await new Promise<void>(resolve => setTimeout(resolve, 5)); }
  const dump = ['notice', 'detailMeta', 'list', 'nodes'].map(id => `${id}=${window.document.getElementById(id)?.textContent?.slice(0, 160) ?? '(null)'}`).join(' | ');
  throw new Error(`画面が反応しません: ${label} / ${dump}`);
}

/** 台帳・作業場所・アプリ・画面をまとめて用意する（Workspace Harness）。 */
async function harness(options: { failFirstFlakyAttempt?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-center-'));
  const workspace = path.join(root, 'source'); await mkdir(workspace, { recursive: true });
  const app = Fastify();
  registerParallelWorkflowRoutes(app, {
    root: path.join(root, 'state'), workspace, authorize: req => req.headers['x-test-admin'] === 'yes',
    executor: async context => {
      // flakyノードは初回試行だけ失敗させ、失敗だけの再試行と成功ノードの再利用を観察できるようにする。
      if (options.failFirstFlakyAttempt && context.node.id === 'flaky' && context.attempt === 1) throw new Error('初回は意図的に失敗します。');
      // 実行関数（ホスト固定）は隔離コピー（Isolated Copy）内へ成果を書く。基準に無いフォルダは作る。
      const target = path.join(context.directory, context.node.allowedWritePaths[0]);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, '要約: 固定合格条件');
    },
  });
  registerWorkflowCenter(app, req => req.headers['x-test-admin'] === 'yes');
  return { app, workspace, window: await openWindow(app, true) };
}

test('GET /workflows は未認証で403、管理者へはCSP付き日本語画面を配信し、秘密情報の保存領域がない', async () => {
  const app = Fastify();
  registerWorkflowCenter(app, req => req.headers['x-test-admin'] === 'yes');
  const denied = await app.inject({ url: '/workflows' });
  assert.equal(denied.statusCode, 403);
  const allowed = await app.inject({ url: '/workflows', headers: { 'x-test-admin': 'yes' } });
  assert.equal(allowed.statusCode, 200);
  assert.match(String(allowed.headers['content-type']), /text\/html/);
  assert.match(String(allowed.headers['content-security-policy']), /default-src 'none'/);
  assert.match(allowed.body, /並列工程センター（Workflow Center）/);
  // XSS回避（textContent描画）と秘密情報保存の禁止を、配信された内容そのもので確認する。
  assert.doesNotMatch(allowed.body, /innerHTML/);
  assert.doesNotMatch(allowed.body, /document\.cookie/);
  // 共通メニューの開閉・スクロール位置だけを許可し、作業内容や認証値を保存しません。
  assert.deepEqual([...new Set([...allowed.body.matchAll(/sessionStorage\.setItem\('([^']+)'/g)].map(match => match[1]))].sort(), ['wentian-navigation-collapsed','wentian-navigation-groups','wentian-navigation-scroll']);
  // 共通テーマと表示言語だけを保存し、プラン・認証値の保存は追加しません。
  assert.deepEqual([...allowed.body.matchAll(/localStorage\.setItem\('([^']+)'/g)].map(match => match[1]).sort(), ['wentian-language', 'wentian-theme']);
  await app.close();
});

test('画面操作だけで作成 → 初回実行が通り、実ファイルへ反映され、ノード状態・差分・統合結果が表示される', async () => {
  const { app, workspace, window } = await harness();
  const doc = window.document;
  const click = (id: string) => { (doc.getElementById(id) as unknown as { click(): void }).click() };
  const nodesText = () => String(doc.getElementById('nodes')?.textContent ?? '');
  try {
    (doc.getElementById('plan') as HTMLTextAreaElement).value = JSON.stringify([{ id: 'docs', dependencies: [], inputs: [], allowedWritePaths: ['docs/notes.md'], acceptance: '要約を作る', sideEffect: false }]);
    (doc.getElementById('checks') as HTMLTextAreaElement).value = JSON.stringify([{ path: 'docs/notes.md', contains: '固定合格条件' }]);
    (doc.getElementById('concurrency') as HTMLInputElement).value = '3';
    click('create');
    assert.match(await until(window, () => doc.querySelector('#list button')?.textContent ?? undefined, '作成後の一覧'), /\d+/);
    // 初回実行はdraft時のみ有効。ボタンが有効になっていることを確認してから押す。
    await until(window, () => (doc.getElementById('run') && !(doc.getElementById('run') as unknown as { disabled: boolean }).disabled ? 'ready' : undefined), '初回実行ボタン');
    click('run');
    assert.match(await until(window, () => (doc.getElementById('detailMeta')?.textContent?.includes('完了') ? doc.getElementById('detailMeta')!.textContent! : undefined), '初回実行の完了'), /状態: 完了/);
    assert.equal(await readFile(path.join(workspace, 'docs', 'notes.md'), 'utf8'), '要約: 固定合格条件');
    assert.match(nodesText(), /成功/, 'ノード状態（Node Status）');
    assert.match(nodesText(), /added docs\/notes\.md/, '差分（Diff）表示');
    assert.match(doc.getElementById('merge')!.textContent ?? '', /published/, '統合反映（Publish）の状態');
  } finally { await window.happyDOM.close(); await app.close(); }
});

test('失敗ノードは失敗だけ再試行で回収し、成功ノードは再利用（Reuse）される', async () => {
  const { app, workspace, window } = await harness({ failFirstFlakyAttempt: true });
  const doc = window.document;
  const click = (id: string) => { (doc.getElementById(id) as unknown as { click(): void }).click() };
  const nodesText = () => String(doc.getElementById('nodes')?.textContent ?? '');
  try {
    (doc.getElementById('plan') as HTMLTextAreaElement).value = JSON.stringify([
      { id: 'stable', dependencies: [], inputs: [], allowedWritePaths: ['stable.txt'], acceptance: '安定ノード', sideEffect: false },
      { id: 'flaky', dependencies: [], inputs: [], allowedWritePaths: ['flaky.txt'], acceptance: '初回失敗ノード', sideEffect: false },
    ]);
    (doc.getElementById('checks') as HTMLTextAreaElement).value = JSON.stringify([{ path: 'stable.txt', contains: '固定合格条件' }, { path: 'flaky.txt', contains: '固定合格条件' }]);
    click('create');
    await until(window, () => doc.querySelector('#list button')?.textContent ?? undefined, '作成');
    click('run');
    assert.match(await until(window, () => (doc.getElementById('detailMeta')?.textContent?.includes('失敗') ? 'failed' : undefined), '失敗状態'), /failed/);
    assert.match(nodesText(), /初回は意図的に失敗します/, '失敗理由（Error）の表示');
    assert.equal(await readFile(path.join(workspace, 'stable.txt'), 'utf8').catch(() => undefined), undefined, '未完了時は原本へ反映しない');
    // 本文なしPOST（retry）で失敗ノードだけが再実行され、成功ノードはハッシュ再利用になる。
    click('retry');
    assert.match(await until(window, () => (doc.getElementById('detailMeta')?.textContent?.includes('完了') ? 'completed' : undefined), '再試行の完了'), /completed/);
    assert.equal(await readFile(path.join(workspace, 'flaky.txt'), 'utf8'), '要約: 固定合格条件');
    assert.match(nodesText(), /再利用/, '成功ノードの再利用表示');
  } finally { await window.happyDOM.close(); await app.close(); }
});

test('権限のない利用者の一覧更新はエラー通知だけが表示され、偽成功しない', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-center-deny-'));
  const app = Fastify();
  registerParallelWorkflowRoutes(app, { root: path.join(root, 'state'), workspace: root, authorize: () => false });
  registerWorkflowCenter(app, () => false);
  const window = await openWindow(app, false);
  const doc = window.document;
  try {
    assert.match(await until(window, () => (doc.getElementById('notice')?.textContent || undefined), 'エラー通知'), /管理権限が必要です/);
    assert.match(doc.getElementById('list')!.textContent ?? '', /まだ読み込んでいません/, '一覧は空のまま');
  } finally { await window.happyDOM.close(); await app.close(); }
});

test('フォームで依存工程と受入条件を追加し、一覧検索と進捗を表示する', async () => {
  const { app, window } = await harness();
  const doc = window.document;
  const click = (id: string) => (doc.getElementById(id) as any).click();
  try {
    for (const [id, value] of [['nodeId', 'review'], ['nodeDependencies', 'docs'], ['nodeInputs', 'docs/notes.md'], ['nodeWrites', 'docs/review.md'], ['nodeAcceptance', 'レビューを作成']]) (doc.getElementById(id) as any).value = value;
    click('addNode');
    await until(window, () => doc.getElementById('planPreview')!.textContent.includes('review') ? 'ready' : undefined, 'フォーム追加');
    const plan = JSON.parse((doc.getElementById('plan') as HTMLTextAreaElement).value);
    assert.deepEqual(plan[1].dependencies, ['docs']); assert.deepEqual(plan[1].inputs, ['docs/notes.md']);
    (doc.getElementById('checkPath') as HTMLInputElement).value = 'docs/review.md';
    click('addCheck');
    await until(window, () => doc.getElementById('checkPreview')!.textContent.includes('docs/review.md') ? 'ready' : undefined, '条件追加');
    click('create');
    await until(window, () => doc.querySelector('#list button')?.textContent || undefined, '作成');
    assert.equal(doc.querySelectorAll('#dependencyView .node-card').length, 2);
    assert.match(doc.getElementById('progressLabel')!.textContent, /0 \/ 2/);
    const search = doc.getElementById('workflowSearch') as HTMLInputElement;
    search.value = '一致しないID'; search.dispatchEvent(new window.Event('input'));
    assert.match(doc.getElementById('list')!.textContent, /一致する工程がありません/);
  } finally { await window.happyDOM.close(); await app.close(); }
});
