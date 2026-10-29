import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDraftCommand } from './multiline-editor.js';

test('複数行ドラフトの置換・挿入・削除・取消を処理する', () => {
  assert.deepEqual(applyDraftCommand(['a', 'b'], ':replace 1 A').lines, ['A', 'b']);
  assert.deepEqual(applyDraftCommand(['a', 'b'], ':insert 2 x').lines, ['a', 'x', 'b']);
  assert.deepEqual(applyDraftCommand(['a', 'b'], ':delete 1').lines, ['b']);
  assert.deepEqual(applyDraftCommand(['a', 'b'], ':undo').lines, ['a']);
});

test('全角コロンと行番号範囲外を安全に処理する', () => {
  assert.equal(applyDraftCommand(['a'], '：show').handled, true);
  assert.match(applyDraftCommand(['a'], ':delete 9').message || '', /1～1/);
});
