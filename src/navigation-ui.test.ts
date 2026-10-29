import assert from 'node:assert/strict';
import test from 'node:test';
import { Window, HTMLInputElement, HTMLButtonElement, HTMLElement } from 'happy-dom';
import { managerDashboardHtml } from './dashboard.js';
import { workbenchHtml } from './workbench-ui.js';
import { navigationIcons } from './navigation-icons.js';
import { navigationRail } from './navigation-ui.js';

test('ホーム・タスク・独立画面は同じ順序・名前・行先の左メニューを使う', async () => {
  const menus: unknown[] = [];
  for (const [wb, external] of [[false,false],[true,false],[false,true]] as const) {
    const window = new Window();
    try {
      window.document.write(navigationRail(wb, '', external));
      menus.push(Array.from(window.document.querySelectorAll('nav button,nav a')).map(node => {
        const id = node.getAttribute('data-view');
        const href = node.getAttribute('href') || (['tasks','groups','skills'].includes(id!) ? '/workbench#' : '/#') + id;
        return [node.textContent, href];
      }));
      assert.equal(window.document.querySelector('a[href="/workbench"]'), null);
      assert.equal(window.document.querySelector('[data-view=create]'), null);
      assert.equal(window.document.querySelector('[data-view=connection]'), null);
    } finally { await window.happyDOM.close(); }
  }
  assert.deepEqual(menus[0], menus[1]); assert.deepEqual(menus[0], menus[2]);
});

test('タスク内の依頼・進捗・成果を切り替えても下書きと左メニュー選択を保持する', async () => {
  const window = new Window({ url: 'http://localhost/workbench#create' });
  try {
    const doc = window.document;
    doc.write(workbenchHtml.replace(/<script>[\s\S]*?<\/script>/g, '')); window.eval(navigationScript(workbenchHtml));
    const title = doc.getElementById('title') as HTMLInputElement; title.value = '保持する依頼';
    doc.getElementById('tasks')!.innerHTML = '<button>完了レポート · 完了</button><button>確認資料 · 検証待ち</button><button>実行中案件 · 実行中</button>';
    for (const tab of ['tasks','results','create']) {
      (doc.querySelector('[data-task-tab='+tab+']') as HTMLButtonElement).click();
      assert.equal(doc.querySelector('.nav-rail [aria-current=page]')?.getAttribute('data-view'), 'tasks');
      assert.equal(doc.getElementById('viewTitle')!.textContent, 'タスク・成果');
      assert.equal(doc.querySelector('#taskTabs [aria-selected=true]')?.getAttribute('data-task-tab'), tab);
      if (tab === 'results') { assert.equal(doc.querySelectorAll('#tasks button:not([hidden])').length, 2); assert.doesNotMatch(Array.from(doc.querySelectorAll('#tasks button:not([hidden])')).map(b=>b.textContent).join(''), /実行中案件/); }
    }
    assert.equal(title.value, '保持する依頼');
    window.location.hash = 'results'; window.dispatchEvent(new window.Event('hashchange'));
    assert.equal(doc.querySelector('#taskTabs [aria-selected=true]')?.getAttribute('data-task-tab'), 'results');
  } finally { await window.happyDOM.close(); }
});

test('別画面へ移ってもメニューの開閉設定を復元する', async () => {
  const window = new Window({ url: 'http://localhost/workbench' });
  try {
    window.sessionStorage.setItem('wentian-navigation-groups', JSON.stringify({ '高度な機能': true, '業務・作業': false }));
    window.document.write(workbenchHtml.replace(/<script>[\s\S]*?<\/script>/g, '')); window.eval(navigationScript(workbenchHtml));
    assert.equal((window.document.querySelector('[data-nav-group="高度な機能"]') as HTMLElement).hasAttribute('open'), true);
    // 現在のタスクを含む分類は、保存値が閉じていても現在位置を示すために開きます。
    assert.equal((window.document.querySelector('[data-nav-group="業務・作業"]') as HTMLElement).hasAttribute('open'), true);
  } finally { await window.happyDOM.close(); }
});

/** 後続の独立機能が増えても、ナビゲーション（Navigation）自身を明示して検証します。 */
function navigationScript(html:string):string {
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).filter(source=>source.includes('const definitions=wb?'));
  assert.equal(scripts.length,1,'ナビゲーションの初期化処理は1つ必要です。');
  return scripts[0];
}

for (const [name, html] of [['ホーム', managerDashboardHtml], ['作業台', workbenchHtml]] as const) {
  test(`${name}の全メニューは三言語を往復しても混在しない`, async () => {
    const window = new Window({ url: 'http://localhost/' });
    try {
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
      window.eval(navigationScript(html));
      const appearance = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('window.wentianUi={t,apply,language}'))!;
      window.eval(appearance);
      for (const language of ['zh', 'en', 'ja', 'zh', 'en', 'ja']) {
        window.localStorage.setItem('wentian-language', language);
        (window as any).wentianUi.apply();
        const rail = window.document.querySelector('.nav-rail')!;
        const labels = rail.querySelector('nav')!.textContent;
        assert.ok(labels.includes(language === 'zh' ? '我的书房' : language === 'en' ? 'My Study' : '書斎'));
        assert.ok(labels.includes(language === 'zh' ? '群组管理' : language === 'en' ? 'Group Management' : 'AIグループ一覧・管理'));
        if (language === 'zh') assert.doesNotMatch(labels, /[ぁ-ゖァ-ヺA-Za-z]/);
        if (language === 'en') assert.doesNotMatch(labels, /[\u3040-\u30ff\u3400-\u9fff]/);
        if (language === 'ja') assert.doesNotMatch(labels, /我的书房|创业孵化器|工作与项目/);
      }
    } finally { await window.happyDOM.close(); }
  });
}

test('運用項目は折りたたみ、直接リンクで展開し、独立画面の入口を保持する', async () => {
  const window = new Window({url:'http://127.0.0.1:8787/'});
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    window.eval(navigationScript(managerDashboardHtml));
    const doc = window.document;
    const group = doc.querySelector('[data-view=improvements]')!.closest('details')!;
    assert.equal(group.hasAttribute('open'), false);
    for (const id of ['evaluation','verification','evidence']) assert.equal(doc.querySelector(`[data-view=${id}]`)!.closest('details'), group);
    for (const route of ['/operations','/workflows','/projects','/mcp-connections','/model-training']) assert.equal(doc.querySelectorAll(`.nav-rail nav a[href="${route}"]`).length, 1);
    window.location.hash='evidence';
    window.dispatchEvent(new window.Event('hashchange'));
    await window.happyDOM.whenAsyncComplete();
    assert.equal(group.hasAttribute('open'), true);
    assert.equal(doc.querySelector('.nav-view:not([hidden])')?.getAttribute('data-view'), 'evidence');
    assert.equal(doc.querySelectorAll('.nav-number').length, 0);
  } finally {await window.happyDOM.close();}
});

// DOM（ドキュメントオブジェクトモデル / Document Object Model）上で配置と操作を検証します。
// 実APIやモデルは呼び出さず、既存の入力要素とイベントが移動後も保たれることを確認します。
for (const [name, html, first] of [['管理画面', managerDashboardHtml, 'home'], ['工作台', workbenchHtml, 'tasks']] as const) {
  test(`${name}のメニュー切替・検索・直接リンクと入力保持`, async () => {
    const window = new Window({ url: 'http://127.0.0.1:8787/' });
    try {
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
      window.eval(navigationScript(html));
      const doc = window.document;
      if (first === 'tasks') {
        assert.equal(doc.querySelector('.nav-rail [data-view=sessions]'), null);
        const search = doc.getElementById('navSearch') as HTMLInputElement;
        search.value = '会話履歴'; search.dispatchEvent(new window.Event('input'));
        assert.equal(doc.querySelectorAll('#navResults button').length, 0);
        search.value = ''; search.dispatchEvent(new window.Event('input'));
        const model = doc.getElementById('model') as HTMLInputElement;
        model.innerHTML = '<option value="test/a">モデルA</option><option value="test/b">モデルB</option>';
        doc.dispatchEvent(new window.Event('wentian-models-updated'));
        const runner = doc.getElementById('runModel') as HTMLInputElement;
        runner.value = 'test/b'; runner.dispatchEvent(new window.Event('change'));
        assert.equal(model.value, 'test/b');
        model.value = 'test/a'; model.dispatchEvent(new window.Event('change'));
        assert.equal(runner.value, 'test/a');
        const tasks = doc.getElementById('tasks')!;
        tasks.innerHTML = '<button>レポート · 完了</button><button>調査 · 実行中</button>';
        const filter = doc.getElementById('taskFilter') as HTMLInputElement;
        filter.value = '実行中'; filter.dispatchEvent(new window.Event('change'));
        assert.equal(tasks.querySelectorAll('button:not([hidden])').length, 1);
        assert.match(tasks.querySelector('button:not([hidden])')!.textContent!, /調査/);
      }
      assert.equal(doc.querySelector('.nav-view:not([hidden])')?.getAttribute('data-view'), first);
      const input = doc.querySelector<HTMLInputElement>(first === 'tasks' ? '#title' : '#chatInput')!;
      input.value = '保持する入力';
      let clicks = 0;
      input.addEventListener('click', () => clicks++);
      for (const button of doc.querySelectorAll<HTMLButtonElement>('.nav-rail nav button:not([hidden])')) {
        button.click();
        assert.equal(doc.querySelectorAll('.nav-view:not([hidden])').length, 1);
        assert.equal(doc.querySelector('.nav-view:not([hidden])')?.getAttribute('data-view'), button.dataset.view);
        assert.equal(button.getAttribute('aria-current'), 'page');
      }
      assert.equal(input.value, '保持する入力');
      input.click(); assert.equal(clicks, 1);
      const search = doc.getElementById('navSearch') as HTMLInputElement;
      search.value = first === 'tasks' ? 'グループ' : 'モデル';
      search.dispatchEvent(new window.Event('input'));
      const result = doc.querySelector<HTMLButtonElement>('#navResults button');
      assert.ok(result); result.click();
      assert.equal((doc.getElementById('navResults') as HTMLElement).hidden, true);
      doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
      assert.equal(doc.activeElement, search);
      window.location.hash = first;
      window.dispatchEvent(new window.Event('hashchange'));
      assert.equal(doc.querySelector('.nav-view:not([hidden])')?.getAttribute('data-view'), first);
      search.value = '存在しない機能'; search.dispatchEvent(new window.Event('input'));
      assert.match(doc.getElementById('navResults')!.textContent!, /一致する機能がありません/);
      // 全ての既存IDが重複なく保存され、フォームの参照先が失われていないことを検証します。
      const original = new Window(); original.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
      for (const element of original.document.querySelectorAll('[id]')) assert.equal(doc.querySelectorAll('#' + element.id).length, 1, element.id);
      await original.happyDOM.close();
    } finally { await window.happyDOM.close(); }
  });
}

test('認証後に生成したユーザー管理を管理者メニューへ追加する', async () => {
  const window = new Window();
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    window.eval(navigationScript(managerDashboardHtml));
    const button = window.document.querySelector<HTMLButtonElement>('.nav-rail [data-view=users]')!;
    assert.equal(button.hidden, true);
    const panel = window.document.createElement('section'); panel.id = 'userPanel';
    window.document.querySelector('main')!.append(panel);
    window.document.dispatchEvent(new window.Event('wentian-user-panel'));
    assert.equal(button.hidden, false); button.click();
    assert.equal((panel.parentElement as HTMLElement)?.dataset.view, 'users');
    assert.equal((panel.parentElement as HTMLElement)?.hidden, false);
  } finally { await window.happyDOM.close(); }
});

test('初回の入口・業務への検索・高度な機能の直接リンクを日本語と中国語で使える', async () => {
  const window = new Window({url:'http://127.0.0.1:8787/'});
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    const appearance=[...managerDashboardHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match=>match[1].includes('const entries='))![1];
    window.eval(appearance);window.eval(navigationScript(managerDashboardHtml));
    const doc=window.document;
    assert.equal(doc.querySelector('.nav-view:not([hidden])')?.getAttribute('data-view'),'home');
    assert.equal(doc.querySelectorAll('.welcome-cards a').length,3);
    assert.ok(doc.querySelector('.welcome-cards a[href="/sites/mail-solutions/"]'));
    const search=doc.getElementById('navSearch') as HTMLInputElement;
    search.value='メール';search.dispatchEvent(new window.Event('input'));
    assert.ok(doc.querySelector('#navResults a[href="/sites/mail-solutions/"]'));
    window.location.hash='evidence';window.dispatchEvent(new window.Event('hashchange'));
    let group=doc.querySelector('.nav-rail [data-view=evidence]')!.closest('details');
    while(group){assert.equal(group.hasAttribute('open'),true);group=group.parentElement!.closest('details');}
    const language=doc.getElementById('language') as HTMLInputElement;
    language.value='zh';language.dispatchEvent(new window.Event('change',{bubbles:true}));
    assert.match(doc.querySelector('.welcome-guide')!.textContent!,/初次使用指南/);
    assert.match(doc.querySelector('.welcome-cards')!.textContent!,/创建任务/);
    search.value='邮件';search.dispatchEvent(new window.Event('input'));
    assert.ok(doc.querySelector('#navResults a[href="/sites/mail-solutions/"]'));
  } finally {await window.happyDOM.close();}
});

test('更新間隔と更新ボタンは稼働状況の見出し下だけに表示する', async () => {
  const window = new Window({url:'http://127.0.0.1:8787/#overview'});
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    window.eval(navigationScript(managerDashboardHtml));
    const doc=window.document, controls=doc.getElementById('overviewControls') as HTMLElement;
    assert.equal(doc.querySelectorAll('#refresh').length,1);
    assert.equal(doc.querySelectorAll('#auto').length,1);
    assert.equal(controls.querySelector('#refresh'),doc.getElementById('refresh'));
    assert.equal(controls.querySelector('#auto'),doc.getElementById('auto'));
    assert.equal(controls.parentElement,doc.querySelector('.view-head>div'));
    assert.equal(controls.hidden,false);
    assert.equal(doc.querySelector('header #refresh'),null);
    assert.match(controls.textContent!,/Auto 10s|毎10秒自動更新/);
    window.location.hash='chat';window.dispatchEvent(new window.Event('hashchange'));
    assert.equal(controls.hidden,true);
    window.location.hash='overview';window.dispatchEvent(new window.Event('hashchange'));
    assert.equal(controls.hidden,false);
  } finally {await window.happyDOM.close();}
});


test('全メニューと分類は重複のない専用アイコンを持つ', () => {
  const window = new Window();
  try {
    window.document.write(navigationRail());
    const entries = [...window.document.querySelectorAll('nav a,nav button,summary')];
    const keys = entries.map(node => node.getAttribute('data-nav-icon')!);
    assert.equal(new Set(keys).size, entries.length);
    assert.ok(keys.every(key => !!navigationIcons[key]));
    assert.equal(new Set(keys.map(key => navigationIcons[key])).size, entries.length);
  } finally { window.happyDOM.close(); }
});

test('縮小中の分類操作は通常幅へ戻して分類を開く', async () => {
  const window = new Window({url:'http://localhost/'});
  try {
    window.document.write(managerDashboardHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
    window.eval(navigationScript(managerDashboardHtml));
    assert.equal(window.document.documentElement.classList.contains('nav-collapsed'), true);
    const summary=window.document.querySelector('[data-nav-group="業務・作業"] summary') as HTMLElement;
    summary.click();
    assert.equal(window.document.documentElement.classList.contains('nav-collapsed'), false);
    assert.equal(summary.parentElement!.hasAttribute('open'), true);
    (window.document.querySelector('.nav-collapse') as HTMLElement).click();
    assert.equal(window.sessionStorage.getItem('wentian-navigation-collapsed'), 'true');
  } finally { await window.happyDOM.close(); }
});
