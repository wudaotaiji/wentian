import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { parseGroupMentions } from './group-mentions.js';
import { groupMentionScript } from './group-mentions-ui.js';
import { AgentGroupStore, namedMembers } from './agent-group.js';

test('明示的な@記法を三言語・空白名・全員・オンラインで解決し、メールとコードを除外する', () => {
  const members = [{ name: '医学教授' }, { name: 'John Smith' }, { name: 'all' }, { name: 'Alice', kind: 'human', userId: 'alice', active: true, presence: 'online' }, { name: 'Bob', kind: 'human', userId: 'bob', active: true, presence: 'offline' }, { name: '退出者', kind: 'human', userId: 'gone', active: false }];
  const mentions = parseGroupMentions('@医学教授 お願いします @"John Smith" please @"all" @here', members);
  assert.deepEqual(mentions.map(m => m.mode), ['member', 'member', 'member', 'here']);
  assert.deepEqual(mentions[1].targets, ['ai:John Smith']);
  assert.ok(mentions[3].targets.includes('human:alice')); assert.ok(!mentions[3].targets.includes('human:bob'));
  assert.ok(parseGroupMentions('@EVERYONE', members)[0].targets.includes('human:bob'));
  assert.deepEqual(parseGroupMentions('a@医学教授 example@example.com @unknown @退出者 `@all`\n```\n@everyone\n```', members), []);
});

test('投稿時の宛先を保存し、指定AIだけが返答する。人間だけの指定ではAIを呼ばない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-mentions-'));
  try {
    const store = new AgentGroupStore(root), group = await store.create('メンション', namedMembers(['教授', '助手']));
    await store.participate(group.id, { id: 'alice', name: 'Alice' }, 'join');
    await store.participate(group.id, { id: 'bob', name: 'Bob' }, 'join', 'offline');
    let saved = await store.post(group.id, 'alice', '@教授 確認してください');
    assert.deepEqual(saved.messages.at(-1)!.mentions![0].targets, ['ai:教授']);
    const called: string[] = []; const respond = async (member: { name: string }) => { called.push(member.name); return '確認しました'; };
    await store.replyToHuman(group.id, '@教授 確認してください', respond); assert.deepEqual(called, ['教授']);
    called.length = 0; await store.replyToHuman(group.id, '@Bob 連絡です', respond); assert.deepEqual(called, []);
    await store.replyToHuman(group.id, '通常の投稿', respond); assert.deepEqual(called, ['教授', '助手']);
    saved = await store.post(group.id, 'alice', '@here 連絡です'); const snapshot = saved.messages.at(-1)!.mentions!;
    await store.participate(group.id, { id: 'bob', name: 'Bob' }, 'presence', 'online');
    assert.ok(!snapshot[0].targets.includes('human:bob'));
    assert.deepEqual((await store.load(group.id)).messages.find(m => m.content === '@here 連絡です')!.mentions, snapshot);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('補完・強調・本人宛の未読と既読を安全に表示し、既読を群と利用者ごとに保持する', async () => {
  const window = new Window({ url: 'http://localhost/workbench#groups' });
  try {
    window.document.write('<form><textarea id="humanMessage"></textarea></form>');
    (window as any).wentianGroupUser = { id: 'alice' };
    window.eval(groupMentionScript.slice(8, -9));
    const ui = (window as any).wentianMentions;
    const members = [{ name: 'John Smith' }, { name: 'Alice', kind: 'human', userId: 'alice', active: true, presence: 'online' }];
    const content = '@Alice <img src=x onerror=alert(1)>';
    assert.ok(window.document.querySelector('.mention-help')!.textContent!.includes('@here'));
    const group = { id: 'group-test', members, messages: [{ id: 'm1', at: '2026-10-19T00:00:00.000Z', speaker: 'John Smith', content, mentions: parseGroupMentions(content, members) }] };
    ui.update(group);
    const input = window.document.getElementById('humanMessage') as any;
    input.value = '@John'; input.setSelectionRange(5, 5); input.dispatchEvent(new window.Event('input'));
    assert.equal((window.document.getElementById('groupMentionPicker') as any).hidden, false);
    (window.document.querySelector('#groupMentionPicker button') as any).click();
    assert.equal(input.value, '@"John Smith" ');
    const bubble = window.document.createElement('div'); ui.render(bubble, content, group.messages[0].mentions);
    assert.equal(bubble.querySelector('img'), null); assert.equal(bubble.querySelector('mark')!.textContent, '@Alice'); assert.equal(bubble.textContent, content);
    assert.equal((window.document.querySelector('.mention-notice') as any).hidden, false);
    (window.document.querySelector('.mention-notice button') as any).click(); ui.update(group);
    assert.equal((window.document.querySelector('.mention-notice') as any).hidden, true);
    group.messages.push({ ...group.messages[0], id: 'm2' }); ui.update(group);
    assert.equal((window.document.querySelector('.mention-notice') as any).hidden, false);
    (window as any).wentianGroupUser = { id: 'other' }; ui.update(group);
    assert.equal((window.document.querySelector('.mention-notice') as any).hidden, true);
  } finally { await window.happyDOM.close(); }
});
