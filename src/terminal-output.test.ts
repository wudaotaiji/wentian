import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { formatConversationSeparator, formatMarkdownAnswer, formatOutputSection, formatWorkingActivity } from './terminal-output.js';

test('回答をインデント付きの独立ブロックへ整形する', () => {
  assert.equal(formatOutputSection('answer', '1行目\n2行目'), '  ╭─ 回答\n  │ 1行目\n  │ 2行目\n  ╰─');
});

test('Working状態を1行化し、5秒単位でグラデーション色を変更する', () => {
  const source = '• Working builder (5s • esc to interrupt)\n  └ agent=kilo, pid=123';
  assert.equal(formatWorkingActivity(source, 5, false), '    • Working builder (5s • esc to interrupt) · agent=kilo, pid=123');
  assert.notEqual(formatWorkingActivity(source, 5, true).match(/38;5;(\d+)/)?.[1], formatWorkingActivity(source, 10, true).match(/38;5;(\d+)/)?.[1]);
  assert.ok((formatWorkingActivity(source, 5, true).match(/38;5;/g) || []).length > 10);
});

test('色指定時だけANSIカラーを付与する', () => {
  const colored = formatOutputSection('process', '検索中', true);
  assert.match(colored, /^\x1b\[1;33m/);
  assert.match(colored, /\x1b\[0m$/);
});

test('内部処理は入力と回答よりさらに1段深くインデントする', () => {
  assert.match(formatOutputSection('input', '質問'), /^  ╭─ 入力/);
  assert.match(formatOutputSection('answer', '返'), /^  ╭─ 回答/);
  assert.match(formatOutputSection('process', '処理中'), /^    ╭─ 処理/);
  assert.match(formatOutputSection('todo', '計画'), /^    ╭─ 作業計画/);
});

test('会話ターンの間を端末幅に応じた横線で区切る', () => {
  assert.equal(formatConversationSeparator(24), '─'.repeat(24));
  assert.match(formatConversationSeparator(80, true), /^\x1b\[2;90m─+/);
  assert.match(formatConversationSeparator(80, true), /\x1b\[0m$/);
});

test('Markdown回答の見出し・リスト・コード・リンクを端末表示へ変換する', () => {
  const rendered = formatMarkdownAnswer('# 状況\n- **成功**\n1. `npm test`\n[資料](https://example.com)\n```ts\nconst ok = true;\n```');
  assert.match(rendered, /◆ 状況/);
  assert.match(rendered, /● 成功/);
  assert.match(rendered, /1\. npm test/);
  assert.match(rendered, /資料 \(https:\/\/example\.com\)/);
  assert.match(rendered, /code: ts/);
  assert.match(rendered, /const ok = true;/);
  assert.doesNotMatch(rendered, /```|\*\*|`npm test`/);
});

test('Markdown回答はANSI対応時に要素別の色と装飾を付ける', () => {
  const rendered = formatMarkdownAnswer('# 見出し\n- **項目**\n`code`', true);
  assert.match(rendered, /\x1b\[1;36m/);
  assert.match(rendered, /\x1b\[1m項目\x1b\[0m/);
  assert.match(rendered, /\x1b\[38;5;222mcode\x1b\[0m/);
});

test('中国語・結合文字・絵文字の長い回答も端末幅内へ収め、各折返し行に緑の枠線を付ける', () => {
  const text = '你好！我是 Wentian，可以帮你查询资料和处理项目任务。👩‍💻 e\u0301 **装飾された長い回答です**。';
  const rendered = formatMarkdownAnswer(text, true, 24);
  const body = rendered.split('\n').slice(1, -1);
  assert.ok(body.length > 3);
  for (const line of body) {
    assert.ok(stringWidth(line) < 24, '端末の自動折返しを発生させません');
    assert.match(line, /^\x1b\[1;32m  │\x1b\[0m /);
  }
  assert.equal(body.map(line => stripVTControlCharacters(line).slice(4)).join(''), '你好！我是 Wentian，可以帮你查询资料和处理项目任务。👩‍💻 e\u0301 装飾された長い回答です。');
  assert.ok(body.some(line => line.includes('👩‍💻')), '絵文字の結合列を分割しません');
});

test('入力枠も全角文字と明示的な空行を保ったまま折り返す', () => {
  const rendered = formatOutputSection('input', '長い入力を端末の幅で折り返します\n\n次の行', false, 20);
  const body = rendered.split('\n').slice(1, -1);
  assert.ok(body.length > 3);
  assert.ok(body.includes('  │ '));
  for (const line of body) { assert.ok(stringWidth(line) < 20); assert.match(line, /^  │ /); }
});
