import { cliText } from './cli-language.js';
import { emitKeypressEvents } from 'node:readline';
import { sanitizeStyledTerminalText, TerminalTextStyler } from './terminal-styled-text.js';
import { BoxRenderable, createCliRenderer, RGBA, StyledText, TextareaRenderable, TextRenderable, type KeyEvent } from '@opentui/core';
import type { ReadStream, WriteStream } from 'node:tty';
import { SlashPicker } from './slash-picker.js';
import { readTerminalTheme, terminalThemes, terminalInputHint, type TerminalInputPresentation } from './terminal-appearance.js';
import { terminalColorEnabled, wrapTerminalLine } from './terminal-output.js';

export type TerminalKey = { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean };

/** OpenCode/Kilo互換のTextarea改行・送信キーバインドです。 */
export const openTuiInputKeyBindings = [
  { name: 'return', action: 'submit' as const },
  { name: 'return', shift: true, action: 'newline' as const },
  { name: 'return', ctrl: true, action: 'newline' as const },
  { name: 'j', ctrl: true, action: 'newline' as const },
  { name: 'linefeed', action: 'newline' as const },
];

export type OpenTuiInputAction = 'submit' | 'newline' | 'cancel' | 'paste-image' | null;

/** OpenTUIが通知したキーを、Textareaの既定処理より先にWentianの操作へ分類します。 */
export function classifyOpenTuiInputKey(key: TerminalKey): OpenTuiInputAction {
  const isReturn = key.name === 'return' || key.name === 'enter' || key.name === 'kpenter';
  if (isReturn && !key.shift && !key.ctrl && !key.meta) return 'submit';
  if ((isReturn && Boolean(key.shift || key.ctrl)) || (key.name === 'j' && key.ctrl) || key.name === 'linefeed') return 'newline';
  if (key.name === 'c' && key.ctrl) return 'cancel';
  if (key.name === 'v' && key.ctrl && key.shift) return 'paste-image';
  return null;
}

/**
 * TUI（端末ユーザーインターフェース / Terminal User Interface）用の編集状態です。
 * 文字位置をUnicodeコードポイント単位で管理し、日本語・中国語を途中で壊さないようにします。
 */
export class TerminalDraft {
  private characters: string[] = [];
  private cursor = 0;

  get text(): string { return this.characters.join(''); }
  get cursorIndex(): number { return this.cursor; }
  get empty(): boolean { return this.characters.length === 0; }

  insert(value: string): void {
    const additions = Array.from(value.replace(/\r\n?/g, '\n'));
    this.characters.splice(this.cursor, 0, ...additions);
    this.cursor += additions.length;
  }

  clear(): void { this.characters = []; this.cursor = 0; }
  left(): void { if (this.cursor > 0) this.cursor--; }
  right(): void { if (this.cursor < this.characters.length) this.cursor++; }
  home(): void { while (this.cursor > 0 && this.characters[this.cursor - 1] !== '\n') this.cursor--; }
  end(): void { while (this.cursor < this.characters.length && this.characters[this.cursor] !== '\n') this.cursor++; }
  backspace(): void { if (this.cursor > 0) { this.characters.splice(this.cursor - 1, 1); this.cursor--; } }
  delete(): void { if (this.cursor < this.characters.length) this.characters.splice(this.cursor, 1); }

  vertical(direction: -1 | 1): void {
    const before = this.characters.slice(0, this.cursor).join('');
    const rowStart = before.lastIndexOf('\n') + 1;
    const column = Array.from(before.slice(rowStart)).length;
    if (direction < 0) {
      if (rowStart === 0) return;
      const previousEnd = rowStart - 1;
      const previousStart = this.characters.slice(0, previousEnd).lastIndexOf('\n') + 1;
      this.cursor = Math.min(previousStart + column, previousEnd);
      return;
    }
    const nextBreak = this.characters.indexOf('\n', this.cursor);
    if (nextBreak < 0) return;
    const nextEnd = this.characters.indexOf('\n', nextBreak + 1);
    this.cursor = Math.min(nextBreak + 1 + column, nextEnd < 0 ? this.characters.length : nextEnd);
  }
}

export function isNewlineKey(key: TerminalKey): boolean {
  return (key.name === 'return' || key.name === 'enter') && Boolean(key.shift || key.ctrl)
    || key.name === 'j' && Boolean(key.ctrl);
}

/**
 * 端末から届く改行用シーケンスを判定します。
 * Ctrl+Jは一般にLF（Line Feed / 改行、0x0A）として届くため、通常のEnterが送るCR（Carriage Return / 復帰、0x0D）と区別します。
 * Shift/Ctrl+EnterはKKP対応端末からCSI-u（Control Sequence Introducer Unicode / 拡張キーシーケンス）として届きます。
 */
export function isNewlineSequence(sequence: string): boolean {
  return sequence === '\n'
    || sequence === '\x1e'
    || /^\x1b\[13;[25](?::\d+)?u$/.test(sequence)
    || /^\x1b\[106;5(?::\d+)?u$/.test(sequence)
    || /^\x1b\[27;[25];13~$/.test(sequence);
}

/** Windows TerminalのCtrl+Shift+V割り当てから届く画像貼り付けコードを判定します。 */
export function isPasteImageSequence(sequence: string): boolean { return sequence === '\x1d'; }

/** 端末幅を考慮した表示位置を概算します。全角文字は多くの端末で2桁を使います。 */
function displayWidth(value: string): number {
  return Array.from(value).reduce((width, character) => width + (/^[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7a3\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]$/u.test(character) ? 2 : 1), 0);
}

/** 候補行を端末幅へ収め、選択行は末尾まで背景色を付けられるよう空白で埋めます。 */
function fitPickerLine(line: string, width: number): string {
  let clipped = '';
  for (const character of line) {
    if (displayWidth(clipped + character) > width) break;
    clipped += character;
  }
  return line.startsWith('> ') ? clipped + ' '.repeat(Math.max(0, width - displayWidth(clipped))) : clipped;
}

type RenderState = { cursorRow: number; rowsBelow?: number };

/**
 * 送信済みドラフトを通常の端末履歴へ残す表示文字列を組み立てます。
 * OpenTUIの一時的なTextarea（テキストエリア）は終了時に消去するため、
 * 複数行の2行目以降には継続プロンプトを付けて、利用者が質問内容を後から確認できるようにします。
 */
export function formatSubmittedDraft(value: string, prompt = 'wentian> '): string {
  if (!value) return '';
  return `${prompt}${value.replace(/\r\n?/g, '\n').replace(/\n/g, '\n... ')}\n`;
}

function render(output: WriteStream, draft: TerminalDraft, prompt: string, state: RenderState, hint = '', presentation: TerminalInputPresentation = {}): void {
  const prefix = Array.from(draft.text).slice(0, draft.cursorIndex).join('');
  const rendered = `${prompt}${draft.text.replace(/\n/g, '\n... ')}`;
  const cursorRendered = `${prompt}${prefix.replace(/\n/g, '\n... ')}`;
  const allLines = rendered.split('\n');
  const cursorLines = cursorRendered.split('\n');
  const statusLines = terminalInputHint(presentation).split('\n').map(line => fitPickerLine(line, Math.max(1, (output.columns || 80) - 1)));
  const rowsBelow = allLines.length - cursorLines.length + statusLines.length;
  // 前回カーソルが複数行目にあってもドラフト先頭まで戻り、古い表示を一括消去します。
  if (state.cursorRow > 0) output.write(`\x1b[${state.cursorRow}A`);
  const theme = terminalThemes[presentation.theme || readTerminalTheme()];
  const paint = (line: string, background: string | undefined = theme.background, foreground: string | undefined = theme.foreground) => {
    if (!background || !foreground || !terminalColorEnabled(output)) return line;
    const rgb = (hex: string) => hex.slice(1).match(/../g)!.map(value => parseInt(value, 16)).join(';');
    return `\x1b[48;2;${rgb(background)}m\x1b[38;2;${rgb(foreground)}m${line}\x1b[K\x1b[0m`;
  };
  output.write(`\r\x1b[0J${hint ? `${hint}\n` : ''}${allLines.map(line => paint(line)).join('\n')}\n${statusLines.map(line => paint(line, theme.statusBackground, theme.muted)).join('\n')}`);
  if (rowsBelow > 0) output.write(`\x1b[${rowsBelow}A`);
  output.write('\r');
  const column = displayWidth(cursorLines.at(-1) || '');
  if (column > 0) output.write(`\x1b[${column}C`);
  state.cursorRow = cursorLines.length - 1 + (hint ? hint.split('\n').length : 0);
  state.rowsBelow = rowsBelow;
}

/**
 * 1件のプロンプトを自由編集して読み取ります。
 * Enterは送信、Shift/Ctrl+EnterとCtrl+Jは改行、Ctrl+Cは入力取消し（空なら終了）です。
 */
export async function readOpenTuiDraft(input: ReadStream, output: WriteStream, prompt: string, onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null, createRenderer: typeof createCliRenderer = createCliRenderer, presentation: TerminalInputPresentation = {}): Promise<string | null> {
  if (presentation.lifecycle?.controller) return presentation.lifecycle.controller.read(presentation);
  const lifecycle = presentation.lifecycle;
  const initialTheme = presentation.theme;
  let awaitingInput = true;
  const theme = terminalThemes[terminalColorEnabled(output) ? presentation.theme || readTerminalTheme() : 'none'];
  const idleHint = () => terminalInputHint({ ...presentation, busy: !awaitingInput });
  // 入力欄5行・下端の区切り線1行・状態3行を置き、候補一覧は必要時だけ上へ追加します。
  const renderer = await createRenderer({
    stdin: input,
    stdout: output,
    screenMode: 'split-footer',
    footerHeight: 9,
    // 起動時の更新通知を含む通常出力と、分割領域のカーソル位置を同期します。
    externalOutputMode: 'capture-stdout',
    // console.logを非表示のデバッグ領域へ吸収せず、通常出力としてフッター上へ流します。
    consoleMode: 'disabled',
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    useKittyKeyboard: {},
    // 分割フッター（Split Footer）の終了時に通常出力の回答・エラーまで消去しないよう保持します。
    clearOnShutdown: false,
  });
  return new Promise(resolve => {
    let resolveInput = resolve;
    const picker = new SlashPicker();
    let completed = false;
    let keyHandler: ((key: KeyEvent) => void) | undefined;
    const finish = (value: string | null) => {
      if (completed) return;
      // 対話セッションでは送信後も描画器を保持し、処理中の次の下書きを編集できます。
      if (lifecycle && value !== null) {
        if (!awaitingInput) return;
        awaitingInput = false;
        textarea.clear(); picker.cancel(); refreshPicker();
        resolveInput(value);
        return;
      }
      completed = true;
      if (lifecycle) lifecycle.controller = undefined;
      if (keyHandler) renderer.keyInput.off('keypress', keyHandler);
      output.off('resize', refreshPicker);
      // 履歴全体を消さず、今回の入力欄だけを空のフレームで消去します。
      // 残したまま破棄すると、次の入力欄との間に古いプレースホルダーが残ります。
      inputBox.visible = false;
      textarea.blur();
      renderer.setCursorPosition(0, 0, true);
      renderer.intermediateRender();
      // 破棄時にはカーソルがフッター末尾へ移動するため、消去した領域の先頭へ戻します。
      // 描画オフセットはOpenTUIに任せ、端末の保存・復元で画面スクロールにも追従します。
      renderer.externalOutputMode = 'passthrough';
      output.write('\x1b7');
      renderer.destroy();
      output.write('\x1b8\r');
      // 通常出力は端末に保持されるため、履歴全体を再出力して二重表示する必要はありません。
      resolveInput(value);
    };
    // ヒント専用 TextRenderable。`/` 入力時に renderer 内で直接書き換えるため、OpenTUI 画面上に必ず残ります。
    const hintText = new TextRenderable(renderer, {
      id: 'wentian-slash-hint',
      content: '',
      bg: theme.statusBackground,
      fg: theme.muted,
      width: '100%',
      height: 0,
      wrapMode: 'none',
    });
    const statusText = new TextRenderable(renderer, {
      id: 'wentian-input-status', content: idleHint(), width: '100%', height: 3,
      bg: theme.statusBackground, fg: theme.muted, wrapMode: 'none',
    });
    // 入力欄と状態情報の境界を、端末幅に合わせた横線で表示します。
    const inputDivider = new TextRenderable(renderer, {
      id: 'wentian-input-divider', content: '─'.repeat(Math.max(1, output.columns || 80)),
      width: '100%', height: 1, bg: theme.statusBackground, fg: theme.muted, wrapMode: 'none',
    });
    // 進捗は通常出力のカーソル移動ではなく、入力欄と同じ描画器の専用行で更新します。
    let activityRows = 0;
    const activityText = new TextRenderable(renderer, {
      id: 'wentian-input-activity', content: '', width: '100%', height: 0,
      bg: theme.statusBackground, fg: theme.muted, wrapMode: 'none',
    });
    const textarea = new TextareaRenderable(renderer, {
      id: 'wentian-agent-input',
      width: '100%',
      height: 5,
      placeholder: cliText('メッセージを入力…'),
      backgroundColor: theme.background || 'transparent',
      focusedBackgroundColor: theme.background || 'transparent',
      textColor: theme.foreground,
      focusedTextColor: theme.foreground,
      placeholderColor: theme.muted,
      wrapMode: 'word',
      keyBindings: openTuiInputKeyBindings,
      // OpenCodeと同様に、IME確定文字がplainTextへ反映されるまでイベントループを二回譲ります。
      onSubmit: () => setTimeout(() => setTimeout(() => finish(textarea.plainText), 0), 0),
    });
    // 上から候補一覧・入力欄・異なる背景の状態情報を配置します。
    const inputBox = new BoxRenderable(renderer, {
      id: 'wentian-agent-input-box',
      flexDirection: 'column',
      width: '100%',
      height: 9,
      backgroundColor: theme.background,
    });
    inputBox.add(hintText);
    inputBox.add(activityText);
    inputBox.add(textarea);
    inputBox.add(inputDivider);
    inputBox.add(statusText);
    /** 本文変更後の候補を表示し、候補数に合わせて表示領域を確保します。 */
    const refreshPicker = () => {
      if (completed) return;
      picker.update(textarea.plainText);
      // 小さい端末では選択位置を含む範囲を表示し、↑/↓で全候補へ到達できます。
      const content = picker.render(Math.max(1, (output.rows || 24) - 9 - activityRows));
      const hintHeight = content ? content.split('\n').length : 0;
      // OpenTUIにはANSI文字列ではなく、背景・文字色を指定した装飾テキストを渡します。
      hintText.content = content ? new StyledText(content.split('\n').flatMap((line, index) => [
        ...(index ? [{ __isChunk: true as const, text: '\n' }] : []),
        { __isChunk: true as const, text: fitPickerLine(line, output.columns || 80), ...(line.startsWith('> ') && terminalColorEnabled(output) ? { bg: RGBA.fromHex('#264f78'), fg: RGBA.fromHex('#ffffff') } : {}) },
      ])) : '';
      statusText.content = idleHint();
      inputDivider.content = '─'.repeat(Math.max(1, output.columns || 80));
      hintText.height = hintHeight;
      inputBox.height = hintHeight + activityRows + 9;
      renderer.footerHeight = hintHeight + activityRows + 9;
    };
    // 貼り付けや履歴呼出しも含め、実際に本文が変わった時点で更新します。
    textarea.onContentChange = refreshPicker;
    output.on('resize', refreshPicker);
    const scheduleSlashHint = () => setTimeout(refreshPicker, 0);
    /**
      // OpenTUIのキーイベントは1tick遅れてplainTextへ反映されるため、
      // ↑/↓による履歴呼び出しは setTimeout で textarea.plainText を最新値にしてから実行します。
      // 単一行入力のときだけ適用し、複数行ドラフト内ではOpenTUI既定の行移動を優先します。
      */
    const applyHistory = (direction: -1 | 1) => {
      if (!onHistoryLookup) return;
      setTimeout(() => setTimeout(() => {
        if (completed) return;
        const current = textarea.plainText;
        if (current.includes('\n')) return;
        const next = onHistoryLookup(direction, current);
        if (next === null || next === undefined) return;
        textarea.setText(next);
      }, 0), 0);
    };
    // OpenTUIのグローバルハンドラーはTextareaの既定処理より先に実行されます。
    // 送信・改行・取消をここで確定し、既定の「Enterで改行」が後から動かないよう伝播を止めます。
    keyHandler = (key: KeyEvent) => {
      if (lifecycle?.voiceStop && key.ctrl && key.name === 'r') {
        key.preventDefault(); key.stopPropagation(); lifecycle.voiceStop(); return;
      }
      if (lifecycle && !awaitingInput && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
        key.preventDefault(); key.stopPropagation(); lifecycle.interrupt?.(); return;
      }
      if (lifecycle && !awaitingInput && key.ctrl && key.name === 't') {
        key.preventDefault(); key.stopPropagation(); lifecycle.transcriptToggle?.(); return;
      }
      if(awaitingInput&&presentation.selection&&(key.name==='escape'||key.ctrl&&key.name==='c')){
        key.preventDefault();key.stopPropagation();finish(null);return;
      }
      if (picker.handleKey(key, textarea.plainText, value => textarea.setText(value))) {
        key.preventDefault(); key.stopPropagation(); refreshPicker(); return;
      }
      const action = classifyOpenTuiInputKey(key);
      if (action === 'submit') {
        key.preventDefault(); key.stopPropagation();
        setTimeout(() => setTimeout(() => finish(textarea.plainText), 0), 0);
        return;
      }
      if (action === 'newline') {
        key.preventDefault(); key.stopPropagation(); textarea.newLine(); return;
      }
      if (action === 'cancel') {
        key.preventDefault(); key.stopPropagation();
        if (textarea.plainText.length) textarea.clear();
        else finish(null);
        return;
      }
      if (key.name === 'up' && !key.ctrl && !key.meta && !key.option && !textarea.plainText.includes('\n')) { key.preventDefault(); key.stopPropagation(); applyHistory(-1); return; }
      if (key.name === 'down' && !key.ctrl && !key.meta && !key.option && !textarea.plainText.includes('\n')) { key.preventDefault(); key.stopPropagation(); applyHistory(1); return; }
      if (action === 'paste-image' && onPasteImage) {
        key.preventDefault(); key.stopPropagation();
        void onPasteImage().then(message => { console.log(message); refreshPicker(); }).catch(error => console.error('画像添付に失敗しました:', error instanceof Error ? error.message : error));
      }
      if (key.name === 'backspace' || key.name === 'delete') scheduleSlashHint();
      else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        // 通常の印字可能キーはIME確定でplainTextへ反映される前にフックし、ヒントの再計算を予約します。
        scheduleSlashHint();
      }
    };
    renderer.keyInput.on('keypress', keyHandler);
    renderer.root.add(inputBox);
    const transcriptStyler = new TerminalTextStyler();
    if (lifecycle) lifecycle.controller = {
      read(next) {
        if (completed) return Promise.resolve(null);
        // 配色変更時だけ描画器を作り直し、通常の処理・次の入力では同じ欄を使います。
        if (next.theme !== initialTheme) { finish(null); return readOpenTuiDraft(input, output, prompt, onPasteImage, history, onSlashHint, onHistoryLookup, createRenderer, next); }
        if (awaitingInput) return Promise.reject(new Error('入力の読取りが重複しています。'));
        presentation = next; awaitingInput = true;
        activityText.content = ''; activityRows = 0; activityText.height = 0;
        textarea.placeholder = cliText('メッセージを入力…');
        refreshPicker(); textarea.focus();
        return new Promise(nextResolve => { resolveInput = nextResolve; });
      },
      activity(text) { if (completed) return; activityText.content = new TerminalTextStyler().parse(sanitizeStyledTerminalText(text), terminalColorEnabled(output)); activityRows = text ? 1 : 0; activityText.height = activityRows; refreshPicker(); },
      insertText(text) { if (completed) return; textarea.insertText(text); refreshPicker(); textarea.focus(); },
      write(text) {
        if (completed) return;
        // 外部stdoutの文字数ベースの変換を避け、全角文字を含む行を表示幅で確保します。
        // 端末カーソルのANSI命令もスナップショットへ持ち込まず、描画器だけが位置を管理します。
        const normalized = sanitizeStyledTerminalText(text.replace(/\r\n?/g, '\n'));
        const lines = normalized.split('\n');
        if (normalized.endsWith('\n')) lines.pop();
        for (const line of lines) for (const wrapped of wrapTerminalLine(line, Math.max(2, renderer.width))) {
          renderer.writeToScrollback(({ width, renderContext }) => ({
            root: new TextRenderable(renderContext, { content: transcriptStyler.parse(wrapped, terminalColorEnabled(output)), width, height: 1, wrapMode: 'none' }),
            width, height: 1, rowColumns: width, startOnNewLine: true, trailingNewline: true,
          }));
        }
      },
      close() { finish(null); },
    };
    textarea.focus();
    renderer.start();
  });
}

export async function readLegacyTerminalDraft(input: ReadStream, output: WriteStream, prompt = 'wentian> ', onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null, presentation: TerminalInputPresentation = {}): Promise<string | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return null;
  emitKeypressEvents(input);
  const keySource = input;
  const draft = new TerminalDraft();
  const picker = new SlashPicker();
  const renderState: RenderState = { cursorRow: 0 };
  let actionBusy = false;
  render(output, draft, prompt, renderState, '', presentation);
  input.setRawMode(true);
  input.resume();
  return new Promise(resolve => {
    const finish = (value: string | null) => {
      keySource.off('keypress', onKeypress);
      input.setRawMode(false);
      // rawモードでresumeした標準入力を停止しないと、exit後もNode.jsプロセスが待機し続けます。
      input.pause();
      // カーソルは入力行にあるため、状態欄の下へ移動してから通常出力へ戻します。
      if (renderState.rowsBelow) output.write(`\x1b[${renderState.rowsBelow}B`);
      output.write('\r\n');
      resolve(value);
    };
    const redraw = () => {
      picker.update(draft.text);
      // 折返しでカーソル計算がずれないよう、候補行を端末幅へ収めます。
      const hint = picker.render(Math.max(1, (output.rows || 24) - 5)).split('\n').map(line => {
        const fitted = fitPickerLine(line, Math.max(1, (output.columns || 80) - 1));
        // 通常端末では同じ配色をANSIで指定し、行末で解除して入力欄への色漏れを防ぎます。
        return line.startsWith('> ') && terminalColorEnabled(output) ? `\x1b[48;2;38;79;120m\x1b[38;2;255;255;255m${fitted}\x1b[0m` : fitted;
      }).join('\n');
      render(output, draft, prompt, renderState, hint, presentation);
    };
    // 履歴呼び出し結果をドラフトへ反映し、再描画します。null の場合は変更しません。
    const applyHistory = (direction: -1 | 1) => {
      if (!onHistoryLookup) return;
      const next = onHistoryLookup(direction, draft.text);
      if (next === null || next === undefined) return;
      draft.clear(); draft.insert(next);
    };
    const onKeypress = (sequence: string, key: TerminalKey) => {
      if (actionBusy) return;
      if(presentation.selection&&(key.name==='escape'||key.ctrl&&key.name==='c'))return finish(null);
      if (!isNewlineSequence(sequence) && picker.handleKey(key, draft.text, value => { draft.clear(); draft.insert(value); })) {
        redraw(); return;
      }
      if (key.ctrl && key.name === 'c') {
        if (draft.empty) return finish(null);
        draft.clear(); redraw(); return;
      }
      if (isPasteImageSequence(sequence) && onPasteImage) {
        actionBusy = true;
        // ドラフト表示を一度消し、添付結果を表示してから同じ編集内容を再描画します。
        if (renderState.cursorRow > 0) output.write(`\x1b[${renderState.cursorRow}A`);
        output.write('\r\x1b[0J'); renderState.cursorRow = 0;
        void onPasteImage().catch(error => `画像添付に失敗しました: ${error instanceof Error ? error.message : String(error)}`).then(message => {
          output.write(`${message}\n`); redraw(); actionBusy = false;
        });
        return;
      }
      // シーケンスを先に判定し、Node.jsがCtrl+JのLFを修飾なしEnterとして解析した場合でも送信せず改行します。
      if (isNewlineSequence(sequence) || isNewlineKey(key)) draft.insert('\n');
      else if ((key.name === 'return' || key.name === 'enter') && !key.shift && !key.ctrl) return finish(draft.text);
      else if (key.name === 'left') draft.left();
      else if (key.name === 'right') draft.right();
      else if (key.name === 'up') {
        // 単一行入力のときは入力履歴呼び出し、複数行のときは既存の行移動を維持します。
        if (!draft.text.includes('\n')) applyHistory(-1); else draft.vertical(-1);
      }
      else if (key.name === 'down') {
        if (!draft.text.includes('\n')) applyHistory(1); else draft.vertical(1);
      }
      else if (key.name === 'home') draft.home();
      else if (key.name === 'end') draft.end();
      else if (key.name === 'backspace') draft.backspace();
      else if (key.name === 'delete') draft.delete();
      else if (!key.ctrl && !key.meta && sequence && !sequence.startsWith('\x1b')) {
        draft.insert(sequence);
      }
      redraw();
    };
    keySource.on('keypress', onKeypress);
  });
}

/** Windows TerminalではOpenCode/Kiloと同じOpenTUI入力基盤を使い、それ以外では従来実装へ縮退します。 */
export async function readTerminalDraft(input: ReadStream, output: WriteStream, prompt = 'wentian> ', onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null, presentation: TerminalInputPresentation = {}): Promise<string | null> {
  // Windows/Bunの対話では同じ描画器を処理中も保持し、raw入力の別監視へ切り替えません。
  if (process.platform === 'win32' && (process.env.WT_SESSION || (presentation.lifecycle && process.versions.bun))) return readOpenTuiDraft(input, output, prompt, onPasteImage, history, onSlashHint, onHistoryLookup, createCliRenderer, presentation);
  return readLegacyTerminalDraft(input, output, prompt, onPasteImage, history, onSlashHint, onHistoryLookup, presentation);
}
