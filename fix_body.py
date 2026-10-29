import re

with open('src/terminal-draft.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# Replace readOpenTuiDraft body
old_open = '''async function readOpenTuiDraft(input: ReadStream, output: WriteStream, prompt: string, onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null): Promise<string | null> {
  // footerHeight に「ヒント領域3行 + 入力欄5行」を確保し、合計8行をOpenTUIに予約します。
  const renderer = await createCliRenderer({
    stdin: input,
    stdout: output,
    screenMode: 'split-footer',
    footerHeight: 8,
    externalOutputMode: 'passthrough',
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    useKittyKeyboard: {},
    clearOnShutdown: true,
  });
  return new Promise(resolve => {
    let completed = false;
    let keyHandler: ((key: KeyEvent) => void) | undefined;
    const finish = (value: string | null) => {
      if (completed) return;
      completed = true;
      if (keyHandler) renderer.keyInput.off('keypress', keyHandler);
      renderer.destroy();
      // OpenTUIが一時画面を消去した後、確定済みの会話履歴だけを通常出力へ復元します。
      if (history) output.write(`${history.replace(/\\n?$/, '\\n')}`);
      resolve(value);
    };
    // ヒント専用 TextRenderable。`/` 入力時に renderer 内で直接書き換えるため、OpenTUI 画面上に必ず残ります。
    const hintText = new TextRenderable(renderer, {
      id: 'wentian-slash-hint',
      content: `${prompt}入力してください\\n（/を入力するとSlash Command候補を表示します）`,
      width: '100%',
      height: 3,
      wrapMode: 'word',
    });
    const textarea = new TextareaRenderable(renderer, {
      id: 'wentian-agent-input',
      width: '100%',
      height: 5,
      placeholder: `${prompt}入力してください`,
      wrapMode: 'word',
      keyBindings: openTuiInputKeyBindings,
      // OpenCodeと同様に、IME確定文字がplainTextへ反映されるまでイベントループを二回譲ります。
      onSubmit: () => setTimeout(() => setTimeout(() => finish(textarea.plainText), 0), 0),
    });
    // flex column で縦に並べ、上にヒント・下に入力欄を配置します。
    const inputBox = new BoxRenderable(renderer, {
      id: 'wentian-agent-input-box',
      flexDirection: 'column',
      width: '100%',
      height: 8,
    });
    inputBox.add(hintText);
    inputBox.add(textarea);
    /**
      // OpenTUIのキーイベントでは、`/`を単発入力した直後でもplainTextへ反映される前に
      // グローバルハンドラーへ届くため、2tick後に最新値を取り出して候補を絞り込みます。
      // ヒントは renderer 内の TextRenderable に直接書き戻し、OpenTUI 画面の下端に常時表示します。
      */
    const scheduleSlashHint = () => {
      if (!onSlashHint) return;
      setTimeout(() => setTimeout(() => {
        const current = textarea.plainText;
        if (current.startsWith('/')) {
          const hint = onSlashHint(current);
          hintText.content = hint ? `${hint}\\n` : `${prompt}入力してください`;
        } else {
          hintText.content = `${prompt}入力してください\\n（/を入力するとSlash Command候補を表示します）`;
        }
      }, 0), 0);
    };
    /**
      // OpenTUIのキーイベントは1tick遅れてplainTextへ反映されるため、
      // ↑/↓による履歴呼び出しは setTimeout で textarea.plainText を最新値にしてから実行します。
      // 単一行入力のときだけ適用し、複数行ドラフト内ではOpenTUI既定の行移動を優先します。
      */
    const applyHistory = (direction: -1 | 1) => {
      if (!onHistoryLookup) return;
      setTimeout(() => setTimeout(() => {
        const current = textarea.plainText;
        if (current.includes('\\n')) return;
        const next = onHistoryLookup(direction, current);
        if (next === null || next === undefined) return;
        textarea.setText(next);
      }, 0), 0);
    };
    // OpenTUIのグローバルハンドラーはTextareaの既定処理より先に実行されます。
    // 送信・改行・取消をここで確定し、既定の「Enterで改行」が後から動かないよう伝播を止めます。
    keyHandler = (key: KeyEvent) => {
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
      if (key.name === 'up' && !key.ctrl && !key.meta && !key.option) { key.preventDefault(); key.stopPropagation(); applyHistory(-1); return; }
      if (key.name === 'down' && !key.ctrl && !key.meta && !key.option) { key.preventDefault(); key.stopPropagation(); applyHistory(1); return; }
      if (action === 'paste-image' && onPasteImage) {
        key.preventDefault(); key.stopPropagation();
        void onPasteImage().then(message => console.log(message)).catch(error => console.error('画像添付に失敗しました:', error instanceof Error ? error.message : error));
      }
      if (key.name === 'backspace' || key.name === 'delete') scheduleSlashHint();
      else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        // 通常の印字可能キーはIME確定でplainTextへ反映される前にフックし、ヒントの再計算を予約します。
        scheduleSlashHint();
      }
    };
    renderer.keyInput.on('keypress', keyHandler);
    renderer.root.add(inputBox);
    textarea.focus();
    renderer.start();
  });
}'''

new_open = '''async function readOpenTuiDraft(input: ReadStream, output: WriteStream, prompt: string, onPasteImage?: () => Promise<string>, history = '', onSlashHint?: (prefix: string | undefined) => string | null, onHistoryLookup?: (direction: -1 | 1, currentText: string) => string | null, slashPicker?: SlashPickerController): Promise<string | null> {
  const renderer = await createCliRenderer({
    stdin: input,
    stdout: output,
    screenMode: 'split-footer',
    footerHeight: 25,
    externalOutputMode: 'passthrough',
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    useKittyKeyboard: {},
    clearOnShutdown: true,
  });
  return new Promise(resolve => {
    let completed = false;
    let keyHandler: ((key: KeyEvent) => void) | undefined;
    const finish = (value: string | null) => {
      if (completed) return;
      completed = true;
      if (keyHandler) renderer.keyInput.off('keypress', keyHandler);
      renderer.destroy();
      if (history) output.write(`${history.replace(/\\n?$/, '\\n')}`);
      resolve(value);
    };
    const hintText = new TextRenderable(renderer, {
      id: 'wentian-slash-hint',
      content: `${prompt}入力してください\\n（/を入力するとSlash Command候補を表示します）`,
      width: '100%',
      height: 20,
      wrapMode: 'word',
    });
    const textarea = new TextareaRenderable(renderer, {
      id: 'wentian-agent-input',
      width: '100%',
      height: 5,
      placeholder: `${prompt}入力してください`,
      wrapMode: 'word',
      keyBindings: openTuiInputKeyBindings,
      onSubmit: () => setTimeout(() => setTimeout(() => finish(textarea.plainText), 0), 0),
    });
    const inputBox = new BoxRenderable(renderer, {
      id: 'wentian-agent-input-box',
      flexDirection: 'column',
      width: '100%',
      height: 25,
    });
    inputBox.add(hintText);
    inputBox.add(textarea);
    const updateHint = () => {
      if (!slashPicker?.isActive()) {
        hintText.content = `${prompt}入力してください\\n（/を入力するとSlash Command候補を表示します）`;
        return;
      }
      hintText.content = `${slashPicker.render()}\\n`;
    };
    const scheduleSlashHint = () => {
      if (!onSlashHint && !slashPicker) return;
      setTimeout(() => setTimeout(() => {
        const current = textarea.plainText;
        if (!current.startsWith('/')) {
          if (slashPicker) slashPicker.cancel();
          updateHint();
          return;
        }
        const prefix = current.slice(1).split(/\\s/)[0];
        const candidates = filterSlashCommands(prefix, slashCommandEntries);
        if (slashPicker) {
          if (!slashPicker.isActive() || slashPicker.render().includes(`/${prefix}`) === false) {
            slashPicker.activate(prefix, candidates);
          }
          updateHint();
        } else if (onSlashHint) {
          const hint = onSlashHint(current);
          hintText.content = hint ? `${hint}\\n` : `${prompt}入力してください`;
        }
      }, 0), 0);
    };
    const applyHistory = (direction: -1 | 1) => {
      if (!onHistoryLookup) return;
      setTimeout(() => setTimeout(() => {
        const current = textarea.plainText;
        if (current.includes('\\n')) return;
        const next = onHistoryLookup(direction, current);
        if (next === null || next === undefined) return;
        textarea.setText(next);
      }, 0), 0);
    };
    keyHandler = (key: KeyEvent) => {
      const action = classifyOpenTuiInputKey(key);
      if (action === 'submit') {
        if (slashPicker?.isActive()) {
          const selected = slashPicker.select();
          if (selected) {
            key.preventDefault(); key.stopPropagation();
            const current = textarea.plainText;
            const slashIndex = current.indexOf('/');
            if (slashIndex >= 0) {
              textarea.setText(current.slice(0, slashIndex) + selected.insertText);
            } else {
              textarea.setText(selected.insertText);
            }
            setTimeout(() => setTimeout(() => finish(textarea.plainText), 0), 0);
            return;
          }
        }
        key.preventDefault(); key.stopPropagation();
        setTimeout(() => setTimeout(() => finish(textarea.plainText), 0), 0);
        return;
      }
      if (action === 'newline') {
        key.preventDefault(); key.stopPropagation(); textarea.newLine(); return;
      }
      if (action === 'cancel') {
        key.preventDefault(); key.stopPropagation();
        if (slashPicker?.isActive()) {
          slashPicker.cancel();
          updateHint();
          return;
        }
        if (textarea.plainText.length) textarea.clear();
        else finish(null);
        return;
      }
      if (slashPicker?.isActive()) {
        if (key.name === 'up' && !key.ctrl && !key.meta && !key.option) {
          key.preventDefault(); key.stopPropagation();
          slashPicker.navigate(-1);
          updateHint();
          return;
        }
        if (key.name === 'down' && !key.ctrl && !key.meta && !key.option) {
          key.preventDefault(); key.stopPropagation();
          slashPicker.navigate(1);
          updateHint();
          return;
        }
        if (key.name === 'tab') {
          key.preventDefault(); key.stopPropagation();
          const selected = slashPicker.select();
          if (selected) {
            const current = textarea.plainText;
            const slashIndex = current.indexOf('/');
            if (slashIndex >= 0) {
              textarea.setText(current.slice(0, slashIndex) + selected.insertText);
            } else {
              textarea.setText(selected.insertText);
            }
            updateHint();
          }
          return;
        }
        if (key.name === 'escape') {
          key.preventDefault(); key.stopPropagation();
          slashPicker.cancel();
          updateHint();
          return;
        }
      }
      if (key.name === 'up' && !key.ctrl && !key.meta && !key.option) { key.preventDefault(); key.stopPropagation(); applyHistory(-1); return; }
      if (key.name === 'down' && !key.ctrl && !key.meta && !key.option) { key.preventDefault(); key.stopPropagation(); applyHistory(1); return; }
      if (action === 'paste-image' && onPasteImage) {
        key.preventDefault(); key.stopPropagation();
        void onPasteImage().then(message => console.log(message)).catch(error => console.error('画像添付に失敗しました:', error instanceof Error ? error.message : error));
      }
      if (key.name === 'backspace' || key.name === 'delete') scheduleSlashHint();
      else if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        scheduleSlashHint();
      }
    };
    renderer.keyInput.on('keypress', keyHandler);
    renderer.root.add(inputBox);
    textarea.focus();
    renderer.start();
  });
}'''

if old_open not in content:
    print('ERROR: old_open not found')
else:
    content = content.replace(old_open, new_open)
    with open('src/terminal-draft.ts', 'w', encoding='utf-8') as f:
        f.write(content)
    print('readOpenTuiDraft body replaced')
