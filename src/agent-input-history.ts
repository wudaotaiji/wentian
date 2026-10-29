/**
 * 入力履歴ナビゲーションの状態を保持します。
 * `↑` で履歴を遡り、`↓` で進めて最後には編集中だった内容へ戻ります。
 * Codex CLIと互換の挙動を、UI レイヤーに依存しない純粋関数のみで提供します。
 *
 * インデックス規約:
 *  - index = -1: 履歴外（新規入力中）。draft を表示対象とします。
 *  - index >= 0: entries[index] を対象とします。0 が最古、entries.length-1 が最新。
 */
export interface InputHistoryNavigator {
  readonly entries: ReadonlyArray<string>;
  /** 履歴を 1 件登録します。直前の内容と同一なら重複としてスキップします。 */
  push(value: string): void;
  /** ↑ で履歴を 1 件進めます（より新しい方向へ）。境界では null を返します。 */
  prev(currentDraft: string): string | null;
  /** ↓ で履歴を 1 件戻します（より古い方向へ）。履歴外まで戻ったら draft を返し、それ以上は null。 */
  next(): string | null;
  /** 履歴外（新規入力中）へ明示的に戻します。送信直後に呼ばれます。 */
  reset(): void;
}

export function createInputHistoryNavigator(limit = 100): InputHistoryNavigator {
  const entries: string[] = [];
  let draft = '';
  let index = -1;
  return {
    get entries() { return entries.slice(); },
    push(value: string) {
      if (entries[entries.length - 1] === value) return;
      entries.push(value);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    prev(currentDraft) {
      if (!entries.length) return null;
      if (index === -1) { draft = currentDraft; index = entries.length - 1; return entries[index]; }
      if (index <= 0) return null;
      index--;
      return entries[index];
    },
    next() {
      if (index === -1) return null;
      if (index >= entries.length - 1) { index = -1; return draft; }
      index++;
      return entries[index];
    },
    reset() { index = -1; draft = ''; },
  };
}