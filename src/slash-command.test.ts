import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSlashCommands, formatSlashCommandCandidates, parseSlashCommand, parseSlashCommandPrefix, slashCommandHelp } from './slash-command.js';

test('Codex風Slash Commandと引数を解析する', () => {
  assert.deepEqual(parseSlashCommand('/status'), { name: 'status', argument: '' });
  assert.deepEqual(parseSlashCommand('/model ollama/qwen2.5:7b'), { name: 'model', argument: 'ollama/qwen2.5:7b' });
  assert.deepEqual(parseSlashCommand('/image "C:\\temp\\a.png"'), { name: 'image', argument: '"C:\\temp\\a.png"' });
  assert.deepEqual(parseSlashCommand('/update apply token-123'), { name: 'update', argument: 'apply token-123' });
  assert.deepEqual(parseSlashCommand('/goal start goal-2026-09-07-demo-abc123'), { name: 'goal', argument: 'start goal-2026-09-07-demo-abc123' });
  assert.deepEqual(parseSlashCommand('/copy 2'), { name: 'copy', argument: '2' });
});

test('未対応コマンドと通常文章はSlash Commandにしない', () => {
  assert.equal(parseSlashCommand('/unknown'), undefined);
  assert.equal(parseSlashCommand('https://example.com/'), undefined);
  assert.match(slashCommandHelp(), /\/status/);
  assert.match(slashCommandHelp(), /\/goal start ID/);
  assert.match(slashCommandHelp(), /\/copy \[N\]/);
});

test('入力途中のSlash Commandプレフィックスを抽出する', () => {
  // `/` のみのときは空オブジェクト相当として扱い、絞り込み側では全件表示を許可します。
  assert.deepEqual(parseSlashCommandPrefix('/'), { name: '', raw: '', hasSpace: false });
  assert.deepEqual(parseSlashCommandPrefix('/st'), { name: 'st', raw: 'st', hasSpace: false });
  assert.deepEqual(parseSlashCommandPrefix('/image "C:\\temp'), { name: 'image', raw: 'image', hasSpace: true });
  assert.equal(parseSlashCommandPrefix('hello /st'), undefined);
  assert.equal(parseSlashCommandPrefix('https://example.com/'), undefined);
});

test('プレフィックスで内部コマンド候補を絞り込む', () => {
  const matched = filterSlashCommands('st');
  assert.ok(matched.length >= 1);
  assert.ok(matched.every(entry => entry.name.startsWith('st')));
  const help = filterSlashCommands('hel');
  assert.ok(help.some(entry => entry.name === 'help'));
  assert.equal(filterSlashCommands('zzz').length, 0);
});

test('空プレフィックスは全Slash Commandを返す', () => {
  const all = filterSlashCommands(undefined);
  assert.ok(all.length >= 14);
  assert.ok(all.some(entry => entry.name === 'exit'));
  assert.ok(all.some(entry => entry.name === 'copy'));
});

test('候補整形はプレフィックスなしでも見やすく表示する', () => {
  const full = formatSlashCommandCandidates(undefined);
  assert.match(full, /Slash Command/);
  assert.match(full, /\/status/);
  const filtered = formatSlashCommandCandidates('up');
  assert.match(filtered, /\/update/);
  const empty = formatSlashCommandCandidates('zzzzz');
  assert.match(empty, /未対応のSlash Command/);
});
