import re

with open('src/terminal-draft.ts', 'r', encoding='utf-8') as f:
    content = f.read()

old_legacy = '''async function readLegacyTerminalDraft(input: ReadStream, output: WriteStream, prompt = 'wentian> ', onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null): Promise<string | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return null;
  emitKeypressEvents(input);
  const keySource = input;
  const draft = new TerminalDraft();
  const renderState: RenderState = { cursorRow: 0 };
  let actionBusy = false;
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise(resolve => {
    const finish = (value: string | null) => {
      keySource.off('keypress', onKeypress);
      input.setRawMode(false);
      // rawモードでresumeした標準入力を停止しないと、exit後もNode.jsプロセスが待機し続けます。
      input.pause();
      output.write('\\n');
      resolve(value);
    };
    const showSlashHint = () => {
      if (!onSlashHint) return;
      const text = draft.text;
      if (!text.startsWith('/')) return;
      const hint = onSlashHint(text);
      if (!hint) return;
      if (renderState.cursorRow > 0) output.write(`\\x1b[${renderState.cursorRow}A`);
      output.write(`\\r\\x1b[0J${hint}\\n`);
      renderState.cursorRow = 0;
      render(output, draft, prompt, renderState);
    };
    // 履歴呼び出し結果をドラフトへ反映し、再描画します。null の場合は変更しません。
    const applyHistory = (direction: -1 | 1) => {
      if (!onHistoryLookup) return;
      const next = onHistoryLookup(direction, draft.text);
      if (next === null || next === undefined) return;
      draft.clear(); draft.insert(next); render(output, draft, prompt, renderState);
    };
    const onKeypress = (sequence: string, key: TerminalKey) => {
      if (actionBusy) return;
      if (key.ctrl && key.name === 'c') {
        if (draft.empty) return finish(null);
        draft.clear(); render(output, draft, prompt, renderState); return;
      }
      if (isPasteImageSequence(sequence) && onPasteImage) {
        actionBusy = true;
        // ドラフト表示を一度消し、添付結果を表示してから同じ編集内容を再描画します。
        if (renderState.cursorRow > 0) output.write(`\\x1b[${renderState.cursorRow}A`);
        output.write('\\r\\x1b[0J'); renderState.cursorRow = 0;
        void onPasteImage().catch(error => `画像添付に失敗しました: ${error instanceof Error ? error.message : String(error)}`).then(message => {
          output.write(`${message}\\n`); render(output, draft, prompt, renderState); actionBusy = false;
        });
        return;
      }
      // シーケンスを先に判定し、Node.jsがCtrl+JのLFを修飾なしEnterとして解析した場合でも送信せず改行します。
      if (isNewlineSequence(sequence) || isNewlineKey(key)) draft.insert('\\n');
      else if ((key.name === 'return' || key.name === 'enter') && !key.shift && !key.ctrl) return finish(draft.text);
      else if (key.name === 'left') draft.left();
      else if (key.name === 'right') draft.right();
      else if (key.name === 'up') {
        // 単一行入力のときは入力履歴呼び出し、複数行のときは既存の行移動を維持します。
        if (!draft.text.includes('\\n')) applyHistory(-1); else draft.vertical(-1);
      }
      else if (key.name === 'down') {
        if (!draft.text.includes('\\n')) applyHistory(1); else draft.vertical(1);
      }
      else if (key.name === 'home') draft.home();
      else if (key.name === 'end') draft.end();
      else if (key.name === 'backspace') draft.backspace();
      else if (key.name === 'delete') draft.delete();
      else if (!key.ctrl && !key.meta && sequence && !sequence.startsWith('\\x1b')) {
        draft.insert(sequence);
        if (sequence === '/' || draft.text.startsWith('/')) showSlashHint();
      }
      render(output, draft, prompt, renderState);
    };
    keySource.on('keypress', onKeypress);
  });
}'''

new_legacy = '''async function readLegacyTerminalDraft(input: ReadStream, output: WriteStream, prompt = 'wentian> ', onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null, slashPicker?: SlashPickerController): Promise<string | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') return null;
  emitKeypressEvents(input);
  const keySource = input;
  const draft = new TerminalDraft();
  const renderState: RenderState = { cursorRow: 0 };
  let actionBusy = false;
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise(resolve => {
    const finish = (value: string | null) => {
      keySource.off('keypress', onKeypress);
      input.setRawMode(false);
      input.pause();
      output.write('\\n');
      resolve(value);
    };
    const showSlashHint = () => {
      if (!onSlashHint && !slashPicker) return;
      const text = draft.text;
      if (!text.startsWith('/')) {
        if (slashPicker) slashPicker.cancel();
        return;
      }
      const prefix = text.slice(1).split(/\\s/)[0];
      const candidates = filterSlashCommands(prefix, slashCommandEntries);
      if (slashPicker) {
        if (!slashPicker.isActive()) {
          slashPicker.activate(prefix, candidates);
        }
        const rendered = slashPicker.render();
        if (renderState.cursorRow > 0) output.write(`\\x1b[${renderState.cursorRow}A`);
        output.write(`\\r\\x1b[0J${rendered}\\n`);
        renderState.cursorRow = 0;
        render(output, draft, prompt, renderState);
      } else if (onSlashHint) {
        const hint = onSlashHint(text);
        if (!hint) return;
        if (renderState.cursorRow > 0) output.write(`\\x1b[${renderState.cursorRow}A`);
        output.write(`\\r\\x1b[0J${hint}\\n`);
        renderState.cursorRow = 0;
        render(output, draft, prompt, renderState);
      }
    };
    const applyHistory = (direction: -1 | 1) => {
      if (!onHistoryLookup) return;
      const next = onHistoryLookup(direction, draft.text);
      if (next === null || next === undefined) return;
      draft.clear(); draft.insert(next); render(output, draft, prompt, renderState);
    };
    const onKeypress = (sequence: string, key: TerminalKey) => {
      if (actionBusy) return;
      if (key.ctrl && key.name === 'c') {
        if (slashPicker?.isActive()) {
          slashPicker.cancel();
          render(output, draft, prompt, renderState);
          return;
        }
        if (draft.empty) return finish(null);
        draft.clear(); render(output, draft, prompt, renderState); return;
      }
      if (isPasteImageSequence(sequence) && onPasteImage) {
        actionBusy = true;
        if (renderState.cursorRow > 0) output.write(`\\x1b[${renderState.cursorRow}A`);
        output.write('\\r\\x1b[0J'); renderState.cursorRow = 0;
        void onPasteImage().catch(error => `画像添付に失敗しました: ${error instanceof Error ? error.message : String(error)}`).then(message => {
          output.write(`${message}\\n`); render(output, draft, prompt, renderState); actionBusy = false;
        });
        return;
      }
      if (isNewlineSequence(sequence) || isNewlineKey(key)) {
        if (slashPicker?.isActive()) {
          const selected = slashPicker.select();
          if (selected) {
            const text = draft.text;
            const slashIndex = text.indexOf('/');
            draft.clear();
            if (slashIndex >= 0) draft.insert(text.slice(0, slashIndex) + selected.insertText);
            else draft.insert(selected.insertText);
            render(output, draft, prompt, renderState);
            return;
          }
        }
        draft.insert('\\n');
      }
      else if ((key.name === 'return' || key.name === 'enter') && !key.shift && !key.ctrl) {
        if (slashPicker?.isActive()) {
          const selected = slashPicker.select();
          if (selected) {
            const text = draft.text;
            const slashIndex = text.indexOf('/');
            draft.clear();
            if (slashIndex >= 0) draft.insert(text.slice(0, slashIndex) + selected.insertText);
            else draft.insert(selected.insertText);
            render(output, draft, prompt, renderState);
            return;
          }
        }
        return finish(draft.text);
      }
      else if (key.name === 'left') draft.left();
      else if (key.name === 'right') draft.right();
      else if (key.name === 'up') {
        if (slashPicker?.isActive()) {
          slashPicker.navigate(-1);
          const rendered = slashPicker.render();
          if (renderState.cursorRow > 0) output.write(`\\x1b[${renderState.cursorRow}A`);
          output.write(`\\r\\x1b[0J${rendered}\\n`);
          renderState.cursorRow = 0;
          render(output, draft, prompt, renderState);
          return;
        }
        if (!draft.text.includes('\\n')) applyHistory(-1); else draft.vertical(-1);
      }
      else if (key.name === 'down') {
        if (slashPicker?.isActive()) {
          slashPicker.navigate(1);
          const rendered = slashPicker.render();
          if (renderState.cursorRow > 0) output.write(`\\x1b[${renderState.cursorRow}A`);
          output.write(`\\r\\x1b[0J${rendered}\\n`);
          renderState.cursorRow = 0;
          render(output, draft, prompt, renderState);
          return;
        }
        if (!draft.text.includes('\\n')) applyHistory(1); else draft.vertical(1);
      }
      else if (key.name === 'tab') {
        if (slashPicker?.isActive()) {
          const selected = slashPicker.select();
          if (selected) {
            const text = draft.text;
            const slashIndex = text.indexOf('/');
            draft.clear();
            if (slashIndex >= 0) draft.insert(text.slice(0, slashIndex) + selected.insertText);
            else draft.insert(selected.insertText);
            render(output, draft, prompt, renderState);
            return;
          }
        }
      }
      else if (key.name === 'escape') {
        if (slashPicker?.isActive()) {
          slashPicker.cancel();
          render(output, draft, prompt, renderState);
          return;
        }
      }
      else if (key.name === 'home') draft.home();
      else if (key.name === 'end') draft.end();
      else if (key.name === 'backspace') {
        draft.backspace();
        if (draft.text.startsWith('/')) showSlashHint();
        else if (slashPicker?.isActive()) {
          slashPicker.cancel();
          render(output, draft, prompt, renderState);
        }
      }
      else if (key.name === 'delete') {
        draft.delete();
        if (draft.text.startsWith('/')) showSlashHint();
        else if (slashPicker?.isActive()) {
          slashPicker.cancel();
          render(output, draft, prompt, renderState);
        }
      }
      else if (!key.ctrl && !key.meta && sequence && !sequence.startsWith('\\x1b')) {
        draft.insert(sequence);
        if (sequence === '/' || draft.text.startsWith('/')) showSlashHint();
      }
      render(output, draft, prompt, renderState);
    };
    keySource.on('keypress', onKeypress);
  });
}'''

if old_legacy not in content:
    print('ERROR: old_legacy not found')
else:
    content = content.replace(old_legacy, new_legacy)
    with open('src/terminal-draft.ts', 'w', encoding='utf-8') as f:
        f.write(content)
    print('readLegacyTerminalDraft body replaced')
