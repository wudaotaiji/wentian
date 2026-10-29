import test from 'node:test';
import assert from 'node:assert/strict';
import { RGBA, TextAttributes } from '@opentui/core';
import { TerminalTextStyler, sanitizeStyledTerminalText } from './terminal-styled-text.js';
import { wrapTerminalLine } from './terminal-output.js';

test('会話枠の色と太字を変換し、リセット後に本文へ色を残さない', () => {
 const chunks=new TerminalTextStyler().parse('\x1b[1;36m╭─ 入力\x1b[0m通常\x1b[1;32m╭─ 回答\x1b[0m').chunks;
 assert.equal(chunks[0].text,'╭─ 入力');assert.ok(chunks[0].fg?.equals(RGBA.fromIndex(6)));assert.ok(chunks[0].attributes! & TextAttributes.BOLD);
 assert.equal(chunks[1].fg,undefined);assert.equal(chunks[1].attributes,0);assert.ok(chunks[2].fg?.equals(RGBA.fromIndex(2)));
});
test('256色・RGB・背景・装飾を保持し、折返しと書込み境界を越えて色を引き継ぐ', () => {
 const styler=new TerminalTextStyler();
 const lines=wrapTerminalLine('\x1b[38;5;39m日本語中文👩‍💻\x1b[0m',6);
 const chunks=lines.flatMap(line=>styler.parse(line).chunks);
 assert.equal(chunks.map(chunk=>chunk.text).join(''),'日本語中文👩‍💻');assert.ok(chunks.every(chunk=>chunk.fg?.equals(RGBA.fromIndex(39))));
 styler.parse('\x1b[38;2;1;2;3m');const chunk=styler.parse('\x1b[48;5;20;3;4m続き').chunks[0];
 assert.ok(chunk.fg?.equals(RGBA.fromInts(1,2,3)));assert.ok(chunk.bg?.equals(RGBA.fromIndex(20)));assert.ok(chunk.attributes! & TextAttributes.ITALIC);assert.ok(chunk.attributes! & TextAttributes.UNDERLINE);
});
test('色無効時は装飾を外し、カーソル移動・画面消去は常に除去する', () => {
 const safe=sanitizeStyledTerminalText('\x1b[2J\x1b[H\x1b[31m本文\x1b[0m\x1b]0;秘密のタイトル\x07');
 assert.equal(safe,'\x1b[31m本文\x1b[0m');
 const chunks=new TerminalTextStyler().parse(safe,false).chunks;assert.equal(chunks[0].text,'本文');assert.equal(chunks[0].fg,undefined);assert.equal(chunks[0].attributes,0);
});
