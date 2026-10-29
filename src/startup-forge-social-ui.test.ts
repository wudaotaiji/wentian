import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { startupForgeRoomHtml } from './startup-forge-room.js';
import { workbenchHtml } from './workbench-ui.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
async function fixture(role = 'admin', joined = true, assets: any[] = [], language = 'zh') {
  const window = new Window({ url: 'http://localhost/startup-forge#groups' });
  window.localStorage.setItem('wentian-language', language);
  const group: any = { id: 'group-11111111-1111-1111-1111-111111111111', title: '試験群', members: [{ name: 'AI', role: '企画', model: 'mock' }, ...(joined ? [{ name: '本人', userId: 'me', kind: 'human', active: true, role: '参加者', avatar: { type: 'upload', dataUrl: png } }] : [])], messages: [{ speaker: '本人', userId: 'me', kind: 'human', content: '<b>人間の発言</b>', at: new Date().toISOString() }] };
  const requests: Array<{ url: string; body: any }> = [];
  window.fetch = (async (input: any, options: any = {}) => { const url = String(input), body = options.body ? JSON.parse(options.body) : undefined; if (body) requests.push({ url, body });
    if (url.endsWith('/avatar')) group.members.find((m: any) => m.name === body.name).avatar = body.avatar;
    if (url.endsWith('/publication')) group.publication = { published: body.published, summary: body.summary || '', updatedAt: new Date().toISOString() };
    const value = url === '/api/control-center/me' ? { user: { id: 'me', role, displayName: '本人' } } : url === '/api/workbench' ? { workspace: '.', goals: [], sessions: [], skills: [] } : url === '/api/workbench/groups' ? { groups: [group] } : url.endsWith('/group-models') ? { models: [] } : url === '/api/site-admin' ? { pages: [{ slug: '', title: 'トップ', href: '/' }] } : url === '/api/visual-assets' ? { assets } : url.endsWith('/forge') ? { state: null } : group;
    return new window.Response(JSON.stringify(value));
  }) as any;
  // 画像の読込とCanvasだけを模擬し、ブラウザーの画像処理や外部APIを試験から起動しません。
  (window as any).Image = class { width = 1536; height = 1024; onload?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()); } };
  (window as any).FileReader = class { result = png; onload?: () => void; readAsDataURL() { queueMicrotask(() => this.onload?.()); } };
  (window.HTMLCanvasElement.prototype as any).getContext = () => ({ drawImage: () => {} });
  (window.HTMLCanvasElement.prototype as any).toDataURL = () => png;
  const html = startupForgeRoomHtml(workbenchHtml); window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(m[1]);
  const settle = async () => { for (let n = 0; n < 40; n++) await new Promise<void>(r => setImmediate(r)); };
  await settle(); window.document.getElementById('groupSelect')!.dispatchEvent(new window.Event('change')); await settle();
  return { window, group, requests, settle };
}
test('孵化器の共有成果を実際の表示領域へ移し、三言語と安全な本文表示を維持する', async () => {
  const f=await fixture('admin',false,[],'en'),doc=f.window.document;
  try {
    assert.ok(doc.querySelector('.world-main #groupOutcome'));assert.ok(doc.querySelector('.world-discussion #groupWorkflow'));
    (f.group as any).outcome={status:'complete',objective:'<img src=x>成果',version:1,round:1,nextMember:null,reason:'終了',draft:'<script>実行しない</script>',criteria:[{id:'c1',text:'条件'}],issues:[],review:{checks:[{id:'c1',passed:true,reason:'記載あり'}]},files:[{url:'/study/jupyter/lab/tree/artifacts/forge/report.md'}]};
    (f.window as any).wentianGroupChat.renderOutcome(f.group,true);(f.window as any).wentianUi.apply();
    assert.equal((doc.getElementById('groupOutcome') as any).hidden,false);assert.match(doc.getElementById('outcomeStatus')!.textContent!,/AI Reviewed/);assert.equal(doc.querySelector('#outcomeDraft script'),null);assert.match(doc.getElementById('outcomeDraft')!.textContent!,/実行しない/);assert.ok(doc.querySelector('#outcomeFiles a[href^="/study/jupyter/"]'));
    (doc.getElementById('groupWorkflow') as any).value='free';doc.getElementById('groupWorkflow')!.dispatchEvent(new f.window.Event('change'));(doc.getElementById('groupWorkflowSave') as any).click();await f.settle();assert.equal(f.requests.filter(r=>r.url.endsWith('/autonomy')).at(-1)!.body.workflow,'free');
  } finally {await f.window.happyDOM.close()}
});

test('既存人物に司会と記録係を表示し、共有成果へ担当と議事録を表示する',async()=>{
 const f=await fixture('admin',true,[],'zh'),doc=f.window.document;
 try{
  f.group.outcome={status:'complete',objective:'試験成果',version:1,round:1,nextMember:null,reason:'完了',draft:'案',criteria:[],issues:[],officers:{chair:'AI',recorder:'AI',reason:'一人なので兼任'},minutes:'決定事項は未承認。'};
  doc.getElementById('groupSelect')!.dispatchEvent(new f.window.Event('change'));await f.settle();
  assert.match(doc.getElementById('outcomeOfficers')!.textContent!,/主持人: AI/);
  assert.match(doc.getElementById('outcomeOfficers')!.textContent!,/会议记录员: AI/);
  assert.equal(doc.getElementById('outcomeMinutes')!.textContent,'決定事項は未承認。');
  assert.equal(doc.querySelectorAll('.world-actor').length,1);
  assert.match(doc.querySelector('.actor-tag')!.textContent!,/主持人/);
  assert.match(doc.querySelector('.actor-tag')!.textContent!,/会议记录员/);
 }finally{await f.window.happyDOM.close();}
});

test('孵化器の動的な見出しとアバター説明を三言語で統一し、会話と名前を保持する', async () => {
  const f = await fixture('admin', false, [], 'en'), doc = f.window.document;
  try {
    for (const [language, title, avatar, hint] of [
      ['en', 'Startup Forge', 'My Avatar', 'Click “Join Discussion” before setting your avatar.'],
      ['ja', '起業インキュベーター', '自分のアバター', '先に「議論に参加」を押して、自分のアバターを設定してください。'],
      ['zh', '创业孵化器', '我的人物形象', '请先点击「加入讨论」，再设置自己的形象。'],
      ['en', 'Startup Forge', 'My Avatar', 'Click “Join Discussion” before setting your avatar.'],
    ]) {
      f.window.localStorage.setItem('wentian-language', language);
      (f.window as any).wentianUi.apply();
      assert.equal(doc.querySelector('.world-top h1')!.textContent, title);
      assert.equal(doc.querySelector('#forgeMyAvatar h3')!.textContent, avatar);
      assert.equal(doc.getElementById('forgeAvatarHint')!.textContent, hint);
      doc.dispatchEvent(new f.window.CustomEvent('wentian-forge-group', { detail: f.group })); await f.settle();
      assert.equal(doc.getElementById('forgeAvatarHint')!.textContent, hint);
      assert.ok(doc.getElementById('worldLog')!.textContent.includes('<b>人間の発言</b>'));
    }
  } finally { await f.window.happyDOM.close(); }
});

test('孵化器から公開・閉鎖でき、既存の公開先選択とAPIを維持する', async () => {
  const f = await fixture(); const doc = f.window.document;
  try { assert.ok(doc.querySelector('.world-dock #groupPublication')); assert.equal((doc.getElementById('groupPublication') as any).hidden, false);
    (doc.getElementById('groupPublicSummary') as any).value = '公開する説明'; doc.getElementById('groupPublicSummary')!.dispatchEvent(new f.window.Event('input'));
    (doc.getElementById('groupPublish') as any).click(); await f.settle(); assert.equal(f.group.publication.published, true);
    const sceneIndex = f.requests.findIndex(r => r.url.endsWith('/forge-scene'));
    const publicationIndex = f.requests.findIndex(r => r.url.endsWith('/publication'));
    assert.ok(sceneIndex >= 0 && sceneIndex < publicationIndex);
    const scene = f.requests[sceneIndex].body;
    assert.equal(scene.background, '/assets/startup-forge/office.png');
    assert.equal(scene.actors[0].sprite, 0);
    assert.equal(scene.actors[0].fixed, true);
    assert.equal(scene.actors[1].fixed, false);
    assert.doesNotMatch(JSON.stringify(scene), /userId|email|ipAddress/);
    (doc.getElementById('groupClose') as any).click(); await f.settle(); assert.equal(f.group.publication.published, false); assert.equal(f.group.members.length, 2); assert.equal(f.group.messages.length, 1);
  } finally { await f.window.happyDOM.close(); }
});
test('人間のカートゥーンと写真を本人のアバターとして保存し、舞台と吹き出しへ表示する', async () => {
  const f = await fixture(); const doc = f.window.document;
  try { assert.equal(doc.querySelectorAll('#forgeAvatarChoices button').length, 8); assert.equal(doc.querySelectorAll('.forge-human').length, 1); assert.equal((doc.querySelector('.forge-human img') as any).src, png); assert.ok(doc.querySelector('.forge-human .comic-bubble')!.textContent.includes('<b>人間の発言</b>')); assert.equal(doc.querySelector('.forge-human .comic-bubble b'), null);
    (doc.querySelector('#forgeAvatarChoices button') as any).click(); await f.settle(); assert.equal(f.requests.filter(r => r.url.endsWith('/avatar')).at(-1)!.body.name, '本人'); assert.equal(f.requests.filter(r => r.url.endsWith('/avatar')).at(-1)!.body.avatar.type, 'upload'); assert.equal((doc.getElementById('forgeAvatarPreview') as any).hidden, false);
    const input = doc.getElementById('forgeAvatarPhoto') as any; Object.defineProperty(input, 'files', { configurable: true, value: [new f.window.File(['写真の試験'], 'self.jpg', { type: 'image/jpeg' })] }); input.dispatchEvent(new f.window.Event('change')); await f.settle(); assert.equal(f.requests.filter(r => r.url.endsWith('/avatar')).length, 2, doc.getElementById('forgeAvatarStatus')!.textContent);
  } finally { await f.window.happyDOM.close(); }
});
test('追加人物を本人の形象に保存でき、再読込で重複せず新素材も増える', async () => {
  const assets = [{ id: 'medical-professor', kind: 'character', name: '医学教授', url: '/assets/startup-forge/medical-professor.png' }, { id: 'medical-lab', kind: 'background', name: '研究室', url: '/assets/startup-forge/medical-lab.png' }];
  const f = await fixture('admin', true, assets), doc = f.window.document;
  try {
    assert.equal(doc.querySelectorAll('#forgeAvatarChoices button').length, 9);
    (doc.querySelector('#forgeAvatarChoices [data-asset-id="medical-professor"]') as any).click(); await f.settle();
    assert.equal(f.requests.filter(r => r.url.endsWith('/avatar')).at(-1)!.body.name, '本人');
    assert.equal(f.requests.filter(r => r.url.endsWith('/avatar')).at(-1)!.body.avatar.type, 'upload');
    assert.equal(doc.querySelector('#forgeAvatarChoices [data-asset-id="medical-professor"]')!.getAttribute('aria-pressed'), 'true');
    assets.push({ id: 'new-character', kind: 'character', name: '新しい人物', url: '/api/visual-assets/12345678-1234-4234-8234-123456789abc/content' });
    f.window.dispatchEvent(new f.window.Event('focus')); await f.settle();
    assert.equal(doc.querySelectorAll('#forgeAvatarChoices button').length, 10);
    f.window.dispatchEvent(new f.window.Event('focus')); await f.settle();
    assert.equal(doc.querySelectorAll('#forgeAvatarChoices button').length, 10);
  } finally { await f.window.happyDOM.close(); }
});

test('既存群で書記を画像選択でき、再読み込みでAI用と本人用の両方に追加人物が現れる',async()=>{
 const assets=[{id:'meeting-scribe',kind:'character',name:'書記・議事録係',url:'/assets/startup-forge/meeting-scribe.png'}];
 const f=await fixture('admin',true,assets),doc=f.window.document;
 try{
  const scribe=doc.querySelector('#forgeLookChoices [data-asset-id="meeting-scribe"]') as any;
  assert.ok(scribe);assert.equal(scribe.disabled,false);scribe.click();await f.settle();
  assert.equal((doc.getElementById('worldLook') as any).value,'meeting-scribe');
  assert.match((doc.querySelector('.actor-sprite') as any).style.backgroundImage,/meeting-scribe/);
  assert.ok(doc.querySelector('#forgeAvatarChoices [data-asset-id="meeting-scribe"]'));
  assets.push({id:'added-scribe',kind:'character',name:'追加の書記',url:'/assets/startup-forge/added-scribe.png'});
  (doc.getElementById('forgeReloadAssets') as any).click();await f.settle();
  assert.ok(doc.querySelector('#forgeLookChoices [data-asset-id="added-scribe"]'));
  assert.ok(doc.querySelector('#forgeAvatarChoices [data-asset-id="added-scribe"]'));
  (doc.getElementById('forgeReloadAssets') as any).click();await f.settle();
  assert.equal(doc.querySelectorAll('#forgeLookChoices [data-asset-id="added-scribe"]').length,1);
  assert.equal(f.group.members.filter((m:any)=>m.kind!=='human').length,1);
 }finally{await f.window.happyDOM.close();}
});

test('人間のダブルクリックではアバター編集へスクロールしない', async () => {
  const f = await fixture();
  const originalSet = f.window.setTimeout, originalClear = f.window.clearTimeout;
  const pending = new Map<number, { callback: () => void; delay: number }>(); let next = 0;
  try {
    // 時刻待ちをせず、単クリック用の予約が二回目のクリックで取り消されることを確認します。
    (f.window as any).setTimeout = (callback: () => void, delay: number) => { pending.set(++next, { callback, delay }); return next; };
    (f.window as any).clearTimeout = (id: number) => { pending.delete(id); };
    const human = f.window.document.querySelector('.forge-human')!;
    human.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, detail: 1 }));
    assert.equal(pending.size, 1);
    human.dispatchEvent(new f.window.MouseEvent('click', { bubbles: true, detail: 2 }));
    human.dispatchEvent(new f.window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    assert.equal([...pending.values()].filter(entry => entry.delay === 500).length, 0);
  } finally { f.window.setTimeout = originalSet; f.window.clearTimeout = originalClear; await f.window.happyDOM.close(); }
});

test('非管理者には公開操作を表示せず、未参加者の画像保存を無効にする', async () => {
  const f = await fixture('viewer', false); const doc = f.window.document;
  try { assert.equal((doc.getElementById('groupPublication') as any).hidden, true); assert.equal((doc.getElementById('forgeAvatarPhoto') as any).disabled, true); assert.equal((doc.querySelector('#forgeAvatarChoices button') as any).disabled, true); assert.equal(f.requests.filter(r => r.url.endsWith('/avatar')).length, 0); } finally { await f.window.happyDOM.close(); }
});
test('人間への返答中は過去の自律討論停止を優先表示せず、進行件数を示す', async () => {
  const f = await fixture(); const doc = f.window.document;
  try {
    f.group.discussion = { status: 'inconclusive', completedTurns: 8, totalTurns: 8 };
    f.group.humanReply = { status: 'running', completedTurns: 2, totalTurns: 8, startedAt: new Date().toISOString() };
    doc.getElementById('groupSelect')!.dispatchEvent(new f.window.Event('change')); await f.settle();
    assert.match(doc.getElementById('worldState')!.textContent, /AI正在回复人类.*2\/8/);
    assert.match(doc.getElementById('groupRunState')!.textContent, /AIが人間へ返答中.*2\/8/);
  } finally { await f.window.happyDOM.close(); }
});
