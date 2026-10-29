import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputHistoryNavigator } from './agent-input-history.js';

test('空の履歴でprev/nextを呼ぶとnullを返す', () => {
  const nav = createInputHistoryNavigator();
  assert.equal(nav.prev('draft'), null);
  assert.equal(nav.next(), null);
  assert.deepEqual(nav.entries, []);
});

test('同一値を連続pushすると重複を1件に押し上げる', () => {
  const nav = createInputHistoryNavigator();
  nav.push('hello'); nav.push('hello'); nav.push('world');
  assert.deepEqual(nav.entries, ['hello', 'world']);
});

test('上限件数を超えると古い履歴を捨てる', () => {
  const nav = createInputHistoryNavigator(2);
  nav.push('a'); nav.push('b'); nav.push('c');
  assert.deepEqual(nav.entries, ['b', 'c']);
});

test('prevで履歴を呼び出してからnextでドラフトへ戻れる', () => {
  const nav = createInputHistoryNavigator();
  nav.push('one'); nav.push('two'); nav.push('three');
  assert.equal(nav.prev('current'), 'three');
  assert.equal(nav.prev('current'), 'two');
  assert.equal(nav.prev('current'), 'one');
  assert.equal(nav.prev('current'), null);
  assert.equal(nav.next(), 'two');
  assert.equal(nav.next(), 'three');
  assert.equal(nav.next(), 'current');
  assert.equal(nav.next(), null);
});

test('resetで履歴外（新規入力）へ戻り、その後はdraftを保存しない', () => {
  const nav = createInputHistoryNavigator();
  nav.push('x');
  nav.prev('保存しないドラフト');
  nav.reset();
  assert.equal(nav.prev('次回ドラフト'), 'x');
  assert.equal(nav.next(), '次回ドラフト');
});