import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, managerDashboardHtml } from './dashboard.js';
import { Window, HTMLButtonElement, HTMLInputElement } from 'happy-dom';

test('ダッシュボードは必要な管理APIと操作部品を含む', () => {
  for (const endpoint of ['/v1/manager/status', '/v1/manager/models', '/v1/providers', '/v1/metrics', '/v1/routing/recent', '/v1/manager/external-agents', '/v1/manager/agent-marketplace']) {
    assert.match(managerDashboardHtml, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
  assert.match(managerDashboardHtml, /type="password"/);
  assert.match(managerDashboardHtml, /Refresh/);
  assert.match(managerDashboardHtml, /Wentian Control Center/);
  assert.match(managerDashboardHtml, /タスク・成果/);
  assert.doesNotMatch(managerDashboardHtml.match(/<header>[\s\S]*?<\/header>/)?.[0] || '', /Task Workbench|タスク作業台/);
  assert.match(managerDashboardHtml, /外部エージェント/);
  assert.match(managerDashboardHtml, /人気エージェント自動登録/);
  assert.match(managerDashboardHtml, /data-install-agent/);
  assert.match(managerDashboardHtml, /agentRegister/);
  assert.match(managerDashboardHtml, /api\/providers/);
  assert.match(managerDashboardHtml, /Providerを追加/);
  assert.match(managerDashboardHtml, /data-provider-edit/);
  assert.match(managerDashboardHtml, /data-provider-delete/);
  assert.match(managerDashboardHtml, /body===undefined\?\{\}:\{'content-type':'application\/json'\}/, '本文のないDELETEにはJSON Content-Typeを付けません');
  assert.match(managerDashboardHtml, /provider\?\.tokenPrice\?JSON\.stringify\(provider\.tokenPrice,null,2\):''/, '未設定の価格は空欄のまま送信します');
  assert.match(managerDashboardHtml, /リアルタイム状態/);
  assert.match(managerDashboardHtml, /startTimer\(/);
assert.match(managerDashboardHtml, /sectionTimers/);
  assert.match(managerDashboardHtml, /startTimer\('memory',renderMemorySafe,10000\)/);
  assert.match(managerDashboardHtml, /startTimer\('metrics',renderMetricsSafe,15000,METRICS_AUTO_ENABLED\)/);
  assert.match(managerDashboardHtml, /startAllTimers\(\)/);
  assert.match(managerDashboardHtml, /\$\('autoMetrics'\)\.addEventListener\('change'/);
  assert.match(managerDashboardHtml, /startAllTimers\(\)/);
  assert.doesNotMatch(managerDashboardHtml, /startAllTimers\(\);refreshNow\(\)/);
  // 表示設定だけを端末へ保存し、認証情報は保存しません。
  assert.match(managerDashboardHtml, /wentian-theme/);
  assert.match(managerDashboardHtml, /wentian-language/);
  assert.doesNotMatch(managerDashboardHtml, /document\.cookie/);
  assert.deepEqual([...new Set([...managerDashboardHtml.matchAll(/sessionStorage\.setItem\('([^']+)'/g)].map(match => match[1]))].sort(), ['wentian-navigation-collapsed','wentian-navigation-groups','wentian-navigation-scroll']);
  assert.match(managerDashboardHtml, /api\/control-center\/login/);
});

test('Web画面はモデル選択・複数ターン・SSEストリーミング会話を提供する', () => {
  assert.match(managerDashboardHtml, /id="chatModel"/);
  assert.match(managerDashboardHtml, /id="chatForm"/);
  assert.match(managerDashboardHtml, /chatMessages\.push/);
  assert.match(managerDashboardHtml, /stream:true/);
  assert.match(managerDashboardHtml, /response\.body\.getReader/);
  assert.match(managerDashboardHtml, /data==='\[DONE\]'/);
});

test('HTMLエスケープは表示値によるスクリプト注入を防ぐ', () => {
  assert.equal(escapeHtml(`<script>alert("x")</script> & 'test'`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;test&#39;');
  assert.match(managerDashboardHtml, /replace\(\/\[&<>"'\]\//);
});

test('埋め込みJavaScriptは構文エラーなく解析できる', () => {
  const script = managerDashboardHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'ダッシュボード内にJavaScriptが必要です');
  assert.doesNotThrow(() => new Function(script));
});

test('外部エージェント見出しをMutationObserverで自己更新しない', () => {
  // 言語切替用の独立したObserverではなく、見出しを描画する本体だけを確認します。
  const dashboardScript = [...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('function renderAgentStages('));
  assert.ok(dashboardScript);
  assert.doesNotMatch(dashboardScript, /new MutationObserver/);
  assert.match(managerDashboardHtml, /<th>リアルタイム状態<\/th>/);
});

for (const [language, expected, permission] of [['ja','保守保留','実行許可待ち・保守保留'],['en','Maintenance deferred','Execution permission required; maintenance deferred'],['zh','维护暂缓','等待执行许可・维护暂缓']]) {
  test(`${language}で保守保留の接続を実行中と表示しない`, async () => {
    const window = new Window({ url: 'http://localhost/#agents' });
    try {
      window.localStorage.setItem('wentian-language', language);
      window.document.write('<html><body><div id="result"></div></body></html>');
      const scripts = [...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
      window.eval(scripts.find(script => script.includes('window.wentianUi={t,apply,language}'))!);
      const dashboard = scripts.find(script => script.includes('function renderAgentStages('))!;
      // 通信やタイマーを起動せず、実際の段階表示だけを三言語で検証します。
      for (const name of ['agentStage','renderAgentStages']) {
        window.eval(dashboard.split('\n').find(line => line.startsWith(`function ${name}(`))!);
      }
      window.eval("function t(value){return window.wentianUi.t(value)};function esc(value){return String(value)};document.getElementById('result').innerHTML=renderAgentStages({connection:{status:'pending',maintenanceDeferred:true}});window.wentianUi.apply()");
      const connection = window.document.querySelectorAll('.agent-stage')[1];
      assert.ok(connection);
      assert.match(connection.textContent!, new RegExp(expected));
      assert.doesNotMatch(connection.outerHTML, /running/);
      assert.equal(window.eval("window.wentianUi.t('実行許可待ち・保守保留')"), permission);
    } finally { await window.happyDOM.close(); }
  });
}

test('各行の操作が対象IDへ送信され、禁止・許可とコマンドを表示する', async () => {
  const window = new Window({ url: 'http://127.0.0.1:8787/#agents' });
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  const calls: Array<{ id: string; action: string }> = [];
  const registrationCalls: string[] = [];
  const modelSelectionCalls:Array<{id:string;manual:boolean}>=[];
  const candidate = { id: 'codex', name: 'Codex', repository: 'openai/codex', installed: true, registered: false, liveState: 'healthy' };
  const agents = ['goose', 'crush'].map(id => ({ id, name: id, state: 'available', stateLabel: id === 'goose' ? '実作業検証済み' : '実作業検証失敗・再試行待ち', note: 'CLI確認済み', excluded: false, liveState: id === 'goose' ? 'healthy' : 'probe_failed', connection: { status: id === 'goose' ? 'verified' : 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString() }, workEvidence: { capabilities: { reading: true, coding: true, testing: true, verification: false } }, healthCheckCommand: `& '${id}' --version` }));
  Object.assign(agents[0], { lastObservedAt: '2026-10-21T01:02:03Z', currentScore: 93734.1 });
  Object.assign(agents[1], { currentScore: null, scoreCoolingDown: true });
  window.fetch = (async (url: unknown, options: any = {}) => {
    const address = String(url);
    let body: unknown = {};
    if (address.endsWith('/me')) body = { user: { id: 'admin', displayName: '管理者', role: 'admin' } };
    else if (address.endsWith('/users')) body = [];
    else if (address.endsWith('/models')) body = [];
    else if (address.includes('external-agents')) {
      if(options.method==='POST'&&address.endsWith('/model-selection')){
        const id=address.split('/').at(-2)!,manual=JSON.parse(options.body).manual;modelSelectionCalls.push({id,manual});Object.assign(agents.find(item=>item.id===id)!,{manualModel:manual});
      }else if (options.method === 'POST') {
        const id = address.split('/').at(-2)!;
        const action = JSON.parse(options.body).action;
        calls.push({ id, action });
        if (action === 'force') agents.forEach(item => Object.assign(item, { forceUse: item.id === id }));
        else if (action === 'unforce') Object.assign(agents.find(item => item.id === id)!, { forceUse: false });
        else if (action !== 'recheck') agents.find(item => item.id === id)!.excluded = action === 'pause';
      }
      body = { agents, summary: { total: 2 } };
    } else if (address.includes('agent-marketplace')) {
      if (options.method === 'POST') { const action = JSON.parse(options.body).action; registrationCalls.push(action); candidate.registered = action === 'add'; body = { id: candidate.id, registered: candidate.registered, snapshot: { agents, summary: { total: 2 } } }; }
      else body = { candidates: [candidate] };
    }
    return new window.Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    for (const match of managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(match[1]);
    const settle = async () => { for (let i = 0; i < 25; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
    await settle();
    const button = (id: string, action: string) => window.document.querySelector<HTMLButtonElement>(`[data-agent-id="${id}"][data-agent-action="${action}"]`)!;
    assert.equal(window.document.querySelectorAll('[data-agent-action]').length, 10, window.document.getElementById('message')?.textContent ?? '');
    assert.deepEqual([...window.document.querySelectorAll('#externalAgents th')].map(item=>item.textContent),['No','外部エージェント','モデル','リアルタイム状態','最終確認','補足','操作']);
    assert.equal(window.document.querySelector('#externalAgents td:nth-child(4) button'),null,'状態列に操作ボタンを置きません');
    const check = window.document.querySelector('#externalAgents td:nth-child(5)')!;
    assert.ok(check.firstElementChild!.textContent!.includes('2026'));
    assert.match(check.querySelector('.agent-current-score')!.textContent!, /現在の評価: 93,734/);
    assert.match(window.document.querySelectorAll('.agent-current-score')[1].textContent!, /冷却中/);
    assert.equal(window.document.querySelectorAll('#externalAgents td:nth-child(7) [data-agent-action]').length,10);
    assert.equal(window.document.querySelectorAll('#externalAgents td:nth-child(3) [data-agent-model]').length, 2, 'モデル列で行ごとに変更できます');
    const fixed=(id:string)=>window.document.querySelector<HTMLInputElement>(`[data-agent-model-manual="${id}"]`)!;
    const change=(id:string)=>window.document.querySelector<HTMLButtonElement>(`[data-agent-model="${id}"]`)!;
    assert.equal(fixed('goose').checked,false);assert.equal(change('goose').disabled,true);assert.equal(change('crush').disabled,true);
    assert.equal(fixed('goose').parentElement!.nextElementSibling,change('goose'),'指定切替をモデル変更ボタンの直前に配置します');
    fixed('goose').checked=true;fixed('goose').dispatchEvent(new window.Event('change',{bubbles:true}));await settle();
    assert.equal(change('goose').disabled,false);assert.equal(change('crush').disabled,true);
    fixed('goose').checked=false;fixed('goose').dispatchEvent(new window.Event('change',{bubbles:true}));await settle();assert.equal(change('goose').disabled,true);
    assert.deepEqual(modelSelectionCalls,[{id:'goose',manual:true},{id:'goose',manual:false}]);
    assert.equal(button('goose','up').disabled,true);
    assert.equal(button('crush','down').disabled,true);
    assert.match(window.document.getElementById('externalAgents')!.textContent!, /& 'goose' --version/);
    assert.ok(window.document.querySelector('#externalAgents .agent-stage.passed'), '合格した段階を緑で表示します');
    assert.ok(window.document.querySelector('#externalAgents .agent-stage.running'), '実行中の段階を強調表示します');
    assert.ok(window.document.querySelector('#externalAgents .agent-stage.failed'), '失敗した段階を赤で表示します');
    assert.ok(window.document.querySelector('#externalAgents .agent-stage.not-run'), '未実行の能力を灰色で表示します');
    assert.ok(window.document.querySelectorAll('#externalAgents .agent-stage.not-run').length >= 5, '未実行の読取・編集・試験・検収をすべて表示します');
    assert.equal(button('goose', 'pause').disabled, false);
    const marketplaceButton = (action: string) => window.document.querySelector<HTMLButtonElement>(`[data-marketplace-action="${action}"][data-agent-id="codex"]`)!;
    assert.equal(marketplaceButton('add').disabled, false);
    marketplaceButton('add').click(); await settle();
    assert.equal(marketplaceButton('add').disabled, true);
    assert.deepEqual(registrationCalls, ['add']);
    button('goose', 'pause').click(); await settle();
    assert.equal(window.document.querySelector('[data-agent-id=goose][data-agent-action=pause]'), null);
    assert.equal(button('goose', 'resume').disabled, false);
    assert.equal(button('crush', 'pause').disabled, false, 'ほかの行は変更しません');
    button('goose', 'recheck').click(); await settle();
    button('goose', 'resume').click(); await settle();
    assert.deepEqual(calls, [{ id: 'goose', action: 'pause' }, { id: 'goose', action: 'recheck' }, { id: 'goose', action: 'resume' }]);
    assert.equal(button('goose', 'pause').disabled, false);
    const force = (id: string) => window.document.querySelector<HTMLInputElement>(`[data-agent-force="${id}"]`)!;
    assert.equal(force('goose').checked, false);
    force('goose').checked = true; force('goose').dispatchEvent(new window.Event('change', { bubbles: true })); await settle();
    assert.equal(force('goose').checked, true); assert.equal(force('crush').checked, false);
    force('crush').checked = true; force('crush').dispatchEvent(new window.Event('change', { bubbles: true })); await settle();
    assert.equal(force('goose').checked, false); assert.equal(force('crush').checked, true);
    force('crush').checked = false; force('crush').dispatchEvent(new window.Event('change', { bubbles: true })); await settle();
    assert.equal(force('crush').checked, false);
    for (const [language, label] of [['zh', '当前评分'], ['en', 'Current score']]) {
      window.localStorage.setItem('wentian-language', language);
      window.eval('window.wentianUi.apply()');
      assert.ok(window.document.querySelector('.agent-current-score')!.textContent!.includes(label));
      assert.ok(force('goose').parentElement!.textContent!.includes(language === 'zh' ? '强制使用' : 'Force use'));
    }
  } finally { await window.happyDOM.close(); }
});
