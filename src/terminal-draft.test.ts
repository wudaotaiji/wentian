import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOpenTuiInputKey, formatSubmittedDraft, isNewlineKey, isNewlineSequence, isPasteImageSequence, openTuiInputKeyBindings, TerminalDraft } from './terminal-draft.js';
import { filterSlashCommands, formatSlashCommandCandidates } from './slash-command.js';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { readLegacyTerminalDraft } from './terminal-draft.js';
import type { TerminalInputPresentation } from './terminal-appearance.js';

/** 実際の入力ハンドラーへキーイベントを送り、送信・履歴との競合まで検証します。 */
function terminalHarness(presentation: TerminalInputPresentation = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
  const output = Object.assign(new PassThrough(), { isTTY: true, rows: 24, columns: 120 });
  let screen = '';
  let historyCalls = 0;
  output.on('data', chunk => { screen += chunk.toString(); });
  const result = readLegacyTerminalDraft(input as unknown as ReadStream, output as unknown as WriteStream,
    'wentian> ', undefined, '', undefined, () => { historyCalls++; return '以前の入力'; }, presentation);
  return {
    result,
    key: (sequence: string, name?: string) => input.emit('keypress', sequence, { name }),
    screen: () => screen,
    historyCalls: () => historyCalls,
  };
}

test('互換入力も選択背景を使い、色無効時は背景のANSIを出力しない', async t => {
  const previous=process.env.NO_COLOR,term=process.env.TERM;delete process.env.NO_COLOR;process.env.TERM='xterm-256color';
  t.after(()=>{if(previous===undefined)delete process.env.NO_COLOR;else process.env.NO_COLOR=previous;if(term===undefined)delete process.env.TERM;else process.env.TERM=term;});
  const green=terminalHarness({theme:'green',status:['Agent: codex','前回: 5.8s']});
  assert.match(green.screen(),/48;2;22;55;46m/);assert.match(green.screen(),/Agent: codex/);
  assert.ok(green.screen().indexOf('wentian> ') < green.screen().indexOf('Agent: codex'));
  assert.match(green.screen(),/48;2;11;33;27m/);
  green.key('\r','return');await green.result;
  process.env.NO_COLOR='1';const plain=terminalHarness({theme:'green'});
  assert.doesNotMatch(plain.screen(),/48;2;/);plain.key('\r','return');await plain.result;
});

test('実入力で/→↓→Tabが候補を挿入し、次のEnterで初めて送信する', async () => {
  const terminal = terminalHarness();
  terminal.key('/');
  assert.match(terminal.screen(), /> \/status/);
  assert.match(terminal.screen(), /\/language/);
  terminal.key('\x1b[B', 'down');
  terminal.key('\t', 'tab');
  assert.equal(terminal.historyCalls(), 0);
  assert.match(terminal.screen(), /wentian> \/update/);
  terminal.key('\r', 'return');
  assert.equal(await terminal.result, '/update');
});

test('実入力でEnter選択は送信せず、↑は最後の候補へ循環する', async () => {
  const terminal = terminalHarness();
  terminal.key('/');
  terminal.key('\x1b[A', 'up');
  terminal.key('\r', 'return');
  let submitted = false;
  void terminal.result.then(() => { submitted = true; });
  await Promise.resolve();
  assert.equal(submitted, false);
  terminal.key('\r', 'return');
  assert.equal(await terminal.result, '/quit');
});

test('実入力でEsc後は通常編集と履歴操作へ戻る', async () => {
  const terminal = terminalHarness();
  terminal.key('/');
  terminal.key('\x1b', 'escape');
  terminal.key('\x1b[A', 'up');
  assert.equal(terminal.historyCalls(), 1);
  terminal.key('\r', 'return');
  assert.equal(await terminal.result, '以前の入力');
});

test('実入力で絞り込み・削除・引数入力を反映する', async () => {
  const terminal = terminalHarness();
  terminal.key('/stx');
  terminal.key('\b', 'backspace');
  terminal.key('\r', 'return');
  terminal.key(' 引数');
  terminal.key('\r', 'return');
  assert.equal(await terminal.result, '/status 引数');
});

test('複数行ドラフト内を上下移動して前の行を修正できる', () => {
  const draft = new TerminalDraft();
  draft.insert('一行目\n二行目');
  draft.vertical(-1);
  draft.insert('修正');
  assert.equal(draft.text, '一行目修正\n二行目');
});

test('Ctrl+Shift+V専用コードを画像貼り付けとして判定する', () => {
  assert.equal(isPasteImageSequence('\x1d'), true);
  assert.equal(isPasteImageSequence('\x16'), false);
});

test('行頭・行末・削除操作を適用できる', () => {
  const draft = new TerminalDraft();
  draft.insert('abc\ndef');
  draft.home();
  draft.delete();
  draft.end();
  draft.backspace();
  assert.equal(draft.text, 'abc\ne');
});

test('Shift/Ctrl+EnterとCtrl+Jを改行として判定する', () => {
  assert.equal(isNewlineKey({ name: 'return', shift: true }), true);
  assert.equal(isNewlineKey({ name: 'enter', ctrl: true }), true);
  assert.equal(isNewlineKey({ name: 'j', ctrl: true }), true);
  assert.equal(isNewlineKey({ name: 'return' }), false);
  assert.equal(isNewlineSequence('\x1b[13;2u'), true);
  assert.equal(isNewlineSequence('\x1b[13;5u'), true);
  assert.equal(isNewlineSequence('\x1b[106;5u'), true);
  assert.equal(isNewlineSequence('\n'), true);
  assert.equal(isNewlineSequence('\r'), false);
  assert.equal(isNewlineSequence('\x1e'), true);
  assert.equal(isNewlineSequence('\x1b[13u'), false);
});

test('OpenTUI入力欄はEnter送信と3種類の改行キーを分離する', () => {
  assert.ok(openTuiInputKeyBindings.some(binding => binding.name === 'return' && !binding.shift && !binding.ctrl && binding.action === 'submit'));
  assert.ok(openTuiInputKeyBindings.some(binding => binding.name === 'return' && binding.shift && binding.action === 'newline'));
  assert.ok(openTuiInputKeyBindings.some(binding => binding.name === 'return' && binding.ctrl && binding.action === 'newline'));
  assert.ok(openTuiInputKeyBindings.some(binding => binding.name === 'j' && binding.ctrl && binding.action === 'newline'));
});

test('OpenTUIグローバル入力処理は送信・改行・終了を分類する', () => {
  assert.equal(classifyOpenTuiInputKey({ name: 'return' }), 'submit');
  assert.equal(classifyOpenTuiInputKey({ name: 'return', shift: true }), 'newline');
  assert.equal(classifyOpenTuiInputKey({ name: 'return', ctrl: true }), 'newline');
  assert.equal(classifyOpenTuiInputKey({ name: 'j', ctrl: true }), 'newline');
  assert.equal(classifyOpenTuiInputKey({ name: 'c', ctrl: true }), 'cancel');
});

test('送信済みの複数行ドラフトを端末履歴用に整形する', () => {
  assert.equal(formatSubmittedDraft('1行目\n2行目'), 'wentian> 1行目\n... 2行目\n');
  assert.equal(formatSubmittedDraft('first\r\nsecond', 'ask> '), 'ask> first\n... second\n');
  assert.equal(formatSubmittedDraft(''), '');
});

test('レガシー入力の`/`フックがプレフィックス絞り込み候補を返す', () => {
  // cli.ts から readTerminalDraft へ渡すコールバックと同じ契約を、純粋関数だけで検証します。
  const handler = (prefix: string | undefined) => {
    if (!prefix?.startsWith('/')) return null;
    return formatSlashCommandCandidates(prefix.slice(1), filterSlashCommands(prefix.slice(1)));
  };
  assert.ok(handler('/')?.includes('Slash Command'));
  assert.ok(handler('/st')?.includes('/status'));
  assert.equal(handler('hello'), null);
});
