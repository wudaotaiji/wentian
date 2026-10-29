import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashPicker } from './slash-picker.js';
import { slashCommandEntries } from './slash-command.js';

test('SlashPickerは非活性で空文字を返す', () => {
  const picker = new SlashPicker();
  assert.equal(picker.isActive(), false);
  assert.equal(picker.render(), '');
});

test('SlashPickerは/入力時に全候補を表示する', () => {
  const picker = new SlashPicker();
  picker.activate('', slashCommandEntries);
  assert.equal(picker.isActive(), true);
  const rendered = picker.render();
  assert.ok(rendered.includes('Slash Command'));
  assert.ok(rendered.includes('/status'));
  assert.ok(rendered.includes('/help'));
});

test('SlashPickerは↑↓で選択を移動できる', () => {
  const picker = new SlashPicker();
  picker.activate('', slashCommandEntries);
  picker.navigate(1);
  assert.match(picker.render(), /> \/update/);
  picker.navigate(-1);
  assert.match(picker.render(), /> \/status/);
});

test('取消後は同じ本文で再表示せず、編集すると候補を更新する', () => {
  const picker = new SlashPicker();
  picker.update('/');
  picker.handleKey({ name: 'escape' }, '/', () => assert.fail());
  picker.update('/');
  assert.equal(picker.isActive(), false);
  picker.update('/st');
  assert.match(picker.render(), /> \/status/);
  picker.update('/status ');
  assert.equal(picker.isActive(), false);
});

test('小さい表示領域でも選択中の最終候補を表示する', () => {
  const picker = new SlashPicker();
  picker.update('/');
  picker.navigate(-1);
  assert.match(picker.render(3), /> \/quit/);
  assert.equal(picker.render(3).split('\n').length, 5);
});

test('引数の説明記号を挿入せず、選択後に候補を再表示しない', () => {
  const picker = new SlashPicker();
  let inserted = '';
  assert.equal(picker.handleKey({ name: 'tab' }, '/model', value => { inserted = value; }), true);
  assert.equal(inserted, '/model ');
  picker.update(inserted);
  assert.equal(picker.isActive(), false);
});

test('修飾付きEnterと候補なしのEnterは通常入力処理へ渡す', () => {
  const picker = new SlashPicker();
  assert.equal(picker.handleKey({ name: 'return', shift: true }, '/', () => assert.fail()), false);
  assert.equal(picker.handleKey({ name: 'return' }, '/unknown', () => assert.fail()), false);
});

test('SlashPickerはselectで先頭のusageを返す', () => {
  const picker = new SlashPicker();
  picker.activate('', slashCommandEntries);
  const result = picker.select();
  assert.ok(result?.insertText.startsWith('/'));
  assert.equal(picker.isActive(), false);
});

test('SlashPickerはcancelで非活性になる', () => {
  const picker = new SlashPicker();
  picker.activate('', slashCommandEntries);
  picker.cancel();
  assert.equal(picker.isActive(), false);
});

test('SlashPickerはプレフィックス絞り込みに対応する', () => {
  const picker = new SlashPicker();
  picker.activate('st', slashCommandEntries.filter(e => e.name.startsWith('st')));
  const rendered = picker.render();
  assert.ok(rendered.includes('/status'));
  assert.ok(!rendered.includes('/help'));
});

test('SlashPickerはEnter選択時にテキストエリアへの挿入テキストを返す', () => {
  const picker = new SlashPicker();
  picker.activate('', slashCommandEntries);
  picker.navigate(1);
  const result = picker.select();
  assert.ok(result && result.insertText.length > 0);
});
