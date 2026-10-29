import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalCancellation } from './terminal-cancellation.js';

test('端末応答・矢印・分割されたESCシーケンスでは依頼を中断しない', async () => {
  let cancelled = 0;
  const input = new TerminalCancellation(() => cancelled++);
  for (const reply of ['\x1b[12;34R', '\x1b[?1;2c', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b[A']) input.feed(reply);
  input.feed('\x1b'); input.feed('[12;34R');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(cancelled, 0);
  input.dispose();
});

test('単独Escと拡張形式Escは中断し、Ctrl+Tは履歴を表示する', async () => {
  let cancelled = 0; let toggled = 0;
  const input = new TerminalCancellation(() => cancelled++, () => toggled++);
  input.feed('\x14'); input.feed('\x1b');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(cancelled, 1); assert.equal(toggled, 1);
  input.feed('\x1b[27u'); assert.equal(cancelled, 2);
  input.feed('\x1b'); input.dispose();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(cancelled, 2);
});
