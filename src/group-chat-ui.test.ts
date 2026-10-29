import assert from 'node:assert/strict';
import test from 'node:test';
import { Window, HTMLInputElement, HTMLButtonElement, HTMLElement } from 'happy-dom';
import { workbenchHtml } from './workbench-ui.js';

// UI（ユーザーインターフェース / User Interface）から参加・投稿・退出まで操作します。
async function open(role = 'admin') {
  const window = new Window({ url: 'http://127.0.0.1:8787/workbench#groups' });
  window.setInterval = (() => 0) as unknown as typeof window.setInterval;
  const id = 'group-12345678-1234-1234-1234-123456789abc';
  const group: any = { id, title: '設計相談', createdAt: new Date().toISOString(), members: [{ name: 'AI設計', role: '設計', model: 'mock/model' }], messages: [{ speaker: 'AI設計', content: '<script>実行しない本文</script>', at: new Date().toISOString() }] };
  const requests: Array<{ url: string; body: any }> = [];
  window.fetch = (async (url: unknown, options: any = {}) => {
    const address = String(url), body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url: address, body });
    let result: any = {};
    if (address === '/api/control-center/me') result = { user: { id: 'alice', displayName: 'Alice', role } };
    else if (address === '/api/workbench') result = { workspace: '.', goals: [], sessions: [], skills: [] };
    else if (address.endsWith('/models') || address.endsWith('/group-models')) result = { models: [{ id: 'mock/model' }] };
    else if (address === '/api/workbench/groups') result = { groups: [group] };
    else if (address.endsWith('/join')) { group.members.push({ name: 'Alice', userId: 'alice', kind: 'human', active: true, presence: body.presence, role: '人間', model: '' }); result = group; }
    else if (address.endsWith('/messages')) { const member = group.members.find((m: any) => m.userId === 'alice'); if (body.nickname) { const match = /^(.+)<(.+)>$/.exec(body.nickname)!; member.name = member.nickname = match[1]; member.email = match[2]; member.ipAddress = '127.0.0.1'; } group.messages.push({ speaker: member.name, userId: 'alice', kind: 'human', content: body.content, at: new Date().toISOString() }); result = group; }
    else if (address.endsWith('/leave')) { group.members.find((m: any) => m.userId === 'alice').active = false; result = group; }
    else if (address.endsWith('/avatar')) { group.members.find((m: any) => m.name === body.name).avatar = body.avatar; result = group; }
    else if (address.endsWith('/publication')) { group.publication = { published: body.published, summary: body.summary || '', showComposer: body.published && body.participation === true, participationAuth: body.participationAuth, updatedAt: new Date().toISOString() }; result = group; }
    else if (address.endsWith('/moderation')) { const member = group.members.find((m: any) => m.userId === body.userId); if (body.action === 'mute') member.muted = true; if (body.action === 'unmute') member.muted = false; if (body.action === 'kick') { member.active = false; member.banned = true; } if (body.action === 'unban') member.banned = false; result = group; }
    else if (address.endsWith('/execution')) { group.execution = body; result = group; }
    else if (address.endsWith('/autonomy')) { group.autonomy = body; result = group; }
    else if (address.endsWith(id)) result = group;
    return new window.Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof window.fetch;
  window.document.write(workbenchHtml.replace(/<script>[\s\S]*?<\/script>/g, ''));
  for (const match of workbenchHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(match[1]);
  await settle();
  return { window, group, requests };
}
async function settle() { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

test('管理者は参加者をミュート・解除・強制退会でき、一般利用者には管理操作を出さない', async () => {
  for (const role of ['admin', 'viewer']) {
    const { window, group, requests } = await open(role);
    try {
      const doc = window.document;
      group.members.push({ kind: 'human', userId: 'bob', name: 'Bob', role: '人間', model: '', active: true });
      (window as any).confirm = () => true;
      (window as any).wentianGroupChat.render(group);
      const find = (text: string) => Array.from(doc.querySelectorAll('#groupMembers button')).find(b => b.textContent === text) as HTMLButtonElement | undefined;
      assert.ok(doc.querySelector('a[href="/direct-messages?peer=bob"]'));
      if (role !== 'admin') { assert.equal(find('発言禁止'), undefined); assert.equal(find('強制退会'), undefined); continue; }
      find('発言禁止')!.click(); await settle(); assert.equal(requests.at(-1)!.body.action, 'mute');
      find('発言禁止を解除')!.click(); await settle(); assert.equal(requests.at(-1)!.body.action, 'unmute');
      find('強制退会')!.click(); await settle(); assert.equal(requests.at(-1)!.body.action, 'kick');
      find('参加禁止を解除')!.click(); await settle(); assert.equal(requests.at(-1)!.body.action, 'unban');
      group.members.push({ kind: 'human', userId: 'alice', name: 'Alice', role: '人間', model: '', active: true, muted: true });
      (window as any).wentianGroupChat.render(group);
      assert.equal((doc.getElementById('humanSend') as HTMLButtonElement).disabled, true);
      assert.equal(doc.getElementById('groupMyState')!.textContent, '発言禁止');
    } finally { await window.happyDOM.close(); }
  }
});

test('自律討論パネルは管理者だけに表示し、開始設定と停止操作を送る', async () => {
  const admin = await open();
  try {
    const doc = admin.window.document;
    assert.equal((doc.getElementById('groupAutonomyPanel') as HTMLElement).hidden, false);
    (doc.getElementById('groupAutonomyEnabled') as HTMLInputElement).checked = true;
    (doc.getElementById('groupAutonomyRounds') as HTMLInputElement).value = '3';
    (doc.getElementById('groupAutonomyMinutes') as HTMLInputElement).value = '5';
    (doc.getElementById('groupAutonomySave') as HTMLButtonElement).click(); await settle();
    assert.deepEqual(admin.requests.find(r => r.url.endsWith('/autonomy'))!.body, { enabled: true, maxRounds: 3, maxMinutes: 5, workflow:'deliverable', mode: 'bounded', restSeconds: 60 });
    (doc.getElementById('groupAutonomyStop') as HTMLButtonElement).click(); await settle();
    assert.deepEqual(admin.requests.filter(r => r.url.endsWith('/autonomy')).at(-1)!.body, { enabled: false });
    (doc.getElementById('groupAutonomyMode') as HTMLInputElement).value = 'continuous';
    doc.getElementById('groupAutonomyMode')!.dispatchEvent(new admin.window.Event('input'));
    (doc.getElementById('groupAutonomyEnabled') as HTMLInputElement).checked = true;
    (doc.getElementById('groupAutonomySave') as HTMLButtonElement).click(); await settle();
    assert.equal(admin.requests.filter(r => r.url.endsWith('/autonomy')).at(-1)!.body.mode, 'continuous');
  } finally { await admin.window.happyDOM.close(); }
  const viewer = await open('viewer');
  try { assert.equal((viewer.window.document.getElementById('groupAutonomyPanel') as HTMLElement).hidden, true); }
  finally { await viewer.window.happyDOM.close(); }
});

test('更新と参加の認証失効で古い画面を隠し、下書きを維持して再ログインを案内する', async () => {
  for (const buttonId of ['groupRefresh', 'groupJoin']) {
    const { window } = await open();
    try {
      const doc = window.document;
      (doc.getElementById('humanMessage') as HTMLInputElement).value = '残す下書き';
      window.fetch = (async () => new window.Response(JSON.stringify({ error: { message: 'ログインが必要です。' } }), { status: 401 })) as typeof window.fetch;
      (doc.getElementById(buttonId) as HTMLButtonElement).click(); await settle();
      assert.equal((doc.getElementById('app') as HTMLElement).hidden, true);
      assert.equal((doc.getElementById('login') as HTMLElement).hidden, false);
      assert.match(doc.getElementById('loginTitle')!.textContent!, /再ログイン/);
      assert.equal((doc.getElementById('humanMessage') as HTMLInputElement).value, '残す下書き');
    } finally { await window.happyDOM.close(); }
  }
});

test('人間の参加・発言・退出を吹き出しへ反映し、更新でも入力と表示を保持する', async () => {
  const { window, group, requests } = await open();
  try {
    const doc = window.document;
    assert.equal(doc.getElementById('groupChatTitle')!.textContent, '設計相談', doc.getElementById('notice')!.textContent + JSON.stringify(requests));
    assert.equal(doc.querySelectorAll('.group-bubble').length, 1);
    assert.equal(doc.querySelector('.group-bubble script'), null);
    assert.equal((doc.getElementById('humanSend') as HTMLButtonElement).disabled, true);
    (doc.getElementById('groupJoin') as HTMLButtonElement).click(); await settle();
    assert.equal((doc.getElementById('humanSend') as HTMLButtonElement).disabled, false);
    const input = doc.getElementById('humanMessage') as HTMLInputElement;
    input.value = '人間の意見';
    const nickname = doc.getElementById('humanNickname') as HTMLInputElement;
    nickname.value = '吉田<member@example.com>';
    nickname.dispatchEvent(new window.Event('input', { bubbles: true }));
    doc.getElementById('humanMessageForm')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(doc.querySelectorAll('.group-bubble').length, 2);
    assert.equal(doc.querySelector('.group-message.mine .group-bubble')!.textContent, '人間の意見');
    assert.equal(input.value, '');
    assert.equal(requests.find(r => r.url.endsWith('/messages'))!.body.nickname, '吉田<member@example.com>');
    assert.equal(group.members.find((m: any) => m.userId === 'alice').email, 'member@example.com');
    assert.match(doc.querySelector('.member-profile')!.textContent, /127.0.0.1/);
    assert.equal(nickname.value, '吉田<member@example.com>');
    input.value = '下書き';
    (doc.getElementById('groupRefresh') as HTMLButtonElement).click(); await settle();
    assert.equal(input.value, '下書き');
    assert.equal(doc.querySelectorAll('.group-bubble').length, 2);
    const generate = [...doc.querySelectorAll<HTMLButtonElement>('.member-actions button')].find(b => b.textContent === '画像を自動生成')!;
    generate.click(); await settle();
    assert.equal(requests.at(-1)!.body.avatar.type, 'generated');
    assert.equal(group.members[0].avatar.type, 'generated');
    assert.equal(doc.querySelector<HTMLInputElement>('.member-upload')!.accept, 'image/png,image/jpeg,image/webp');
    (doc.getElementById('groupLeave') as HTMLButtonElement).click(); await settle();
    assert.equal((doc.getElementById('humanSend') as HTMLButtonElement).disabled, true);
    assert.equal(doc.querySelectorAll('.group-bubble').length, 2);
    assert.equal((doc.getElementById('groupJoin') as HTMLElement).hidden, false);
  } finally { await window.happyDOM.close(); }
});

test('一般利用者はグループ画面だけを開き、AI実行や他人の画像編集を表示しない', async () => {
  const { window, requests } = await open('viewer');
  try {
    const doc = window.document;
    assert.equal(doc.getElementById('viewTitle')!.textContent, 'AIグループ');
    assert.equal(doc.querySelectorAll('.nav-rail nav button:not([hidden])').length, 1);
    assert.equal((doc.getElementById('memberEditor') as HTMLElement).hidden, true);
    assert.equal((doc.getElementById('groupAIDiscussion') as HTMLElement).hidden, true);
    assert.equal((doc.getElementById('groupPublication') as HTMLElement).hidden, true);
    assert.equal((doc.getElementById('groupExecutionForm') as HTMLElement).hidden, true);
    assert.equal(requests.some(r => r.url === '/api/workbench'), false);
    assert.equal(doc.querySelectorAll('.member-actions button').length, 0);
    (doc.getElementById('groupJoin') as HTMLButtonElement).click(); await settle();
    assert.equal(doc.querySelectorAll('.member-actions button').length, 2, doc.getElementById('notice')!.textContent + JSON.stringify(requests));
    assert.equal(doc.querySelectorAll('.group-message img').length, 1);
  } finally { await window.happyDOM.close(); }
});

test('Planを既定表示し、モデル選択なしでActionの対象を保存できる', async () => {
  const { window, group, requests } = await open();
  try {
    const doc = window.document;
    const mode = doc.getElementById('groupExecutionMode') as HTMLInputElement;
    assert.equal(mode.value, 'plan');
    assert.equal((doc.getElementById('groupActionSettings') as HTMLElement).hidden, true);
    mode.value = 'action'; mode.dispatchEvent(new window.Event('change', { bubbles: true })); await settle();
    assert.equal((doc.getElementById('groupActionSettings') as HTMLElement).hidden, false);
    (doc.getElementById('groupRepository') as HTMLInputElement).value = 'C:/workspace/example';
    doc.getElementById('groupExecutionForm')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(group.execution.mode, 'action');
    assert.equal(requests.find(r => r.url.endsWith('/execution'))!.body.model, undefined);
    assert.equal(doc.getElementById('groupActionModel'), null);
    assert.match(doc.getElementById('groupModeBadge')!.textContent, /Action/);
    mode.value = 'plan'; mode.dispatchEvent(new window.Event('change', { bubbles: true }));
    doc.getElementById('groupExecutionForm')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
    assert.equal(group.execution.mode, 'plan');
  } finally { await window.happyDOM.close(); }
});

// 公開・閉鎖は会話履歴を変更せず、ボタンの状態と公開説明だけを更新します。
test('管理者が公開と閉鎖を切り替えるとボタン状態が更新される', async () => {
  const { window, group, requests } = await open();
  try {
    const doc = window.document;
    const publish = doc.getElementById('groupPublish') as HTMLButtonElement;
    const close = doc.getElementById('groupClose') as HTMLButtonElement;
    const summary = doc.getElementById('groupPublicSummary') as HTMLInputElement;
    assert.equal(publish.disabled, false);
    assert.equal(close.disabled, true);
    summary.value = '開発の相談はこちら';
    summary.dispatchEvent(new window.Event('input', { bubbles: true }));
    const participation = doc.getElementById('groupPublicParticipation') as HTMLInputElement;
    participation.value = 'allow'; participation.dispatchEvent(new window.Event('change'));
    publish.click(); await settle();
    assert.equal(group.publication.published, true);
    assert.equal(requests.find(r => r.url.endsWith('/publication'))!.body.summary, '開発の相談はこちら');
    assert.equal(publish.disabled, false);
    assert.equal(requests.find(r => r.url.endsWith('/publication'))!.body.participation, true);
    const presence = doc.getElementById('humanPresence') as HTMLInputElement;
    presence.value = 'offline';
    publish.click(); await settle();
    assert.equal(requests.filter(r => r.url.endsWith('/publication')).at(-1)!.body.participation, true);
    participation.value = 'login'; participation.dispatchEvent(new window.Event('change'));
    (doc.getElementById('groupParticipationSave') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(requests.filter(r => r.url.endsWith('/publication')).at(-1)!.body.participationAuth, 'login');
    assert.equal(participation.value, 'login');
    participation.value = 'deny'; participation.dispatchEvent(new window.Event('change'));
    (doc.getElementById('groupParticipationSave') as HTMLButtonElement).click(); await settle();
    assert.equal(requests.filter(r => r.url.endsWith('/publication')).at(-1)!.body.participation, false);
    assert.equal(group.publication.showComposer, false);
    assert.equal(close.disabled, false);
    close.click(); await settle();
    assert.equal(group.publication.published, false);
    assert.equal(publish.disabled, false);
    assert.equal(close.disabled, true);
    assert.equal(group.messages.length, 1);
  } finally { await window.happyDOM.close(); }
});
