import { filterSlashCommands, type SlashCommandEntry } from './slash-command.js';
import { cliText } from './cli-language.js';

export interface SlashPickerController {
  activate(prefix: string, candidates: readonly SlashCommandEntry[]): void;
  navigate(direction: -1 | 1): void;
  select(): { insertText: string } | null;
  cancel(): void;
  isActive(): boolean;
  render(): string;
}

export class SlashPicker implements SlashPickerController {
  active = false;
  private prefix = '';
  private candidates: SlashCommandEntry[] = [];
  private selectedIndex = 0;
  private lastText = '';

  /** 入力が変わったときだけ候補を更新し、取消し・選択直後の再表示を防ぎます。 */
  update(text: string): void {
    if (text === this.lastText) return;
    this.lastText = text;
    if (!/^\/[a-z-]*$/i.test(text)) { this.cancel(); return; }
    const prefix = text.slice(1);
    this.activate(prefix, filterSlashCommands(prefix));
  }

  /** 両方の端末入力方式で共用するキー処理です。trueなら通常編集へ伝播しません。 */
  handleKey(key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; option?: boolean }, text: string, insert: (value: string) => void): boolean {
    this.update(text);
    if (!this.active || key.ctrl || key.shift || key.meta || key.option) return false;
    if (key.name === 'escape') { this.cancel(); return true; }
    if (key.name === 'up' || key.name === 'down') { this.navigate(key.name === 'up' ? -1 : 1); return true; }
    if (['return', 'enter', 'kpenter', 'tab'].includes(key.name || '')) {
      const selected = this.select();
      if (!selected) return false;
      this.lastText = selected.insertText;
      insert(selected.insertText);
      return true;
    }
    return false;
  }

  activate(prefix: string, candidates: readonly SlashCommandEntry[]): void {
    this.active = true;
    this.prefix = prefix;
    this.candidates = [...candidates];
    this.selectedIndex = 0;
  }

  navigate(direction: -1 | 1): void {
    if (!this.active || !this.candidates.length) return;
    this.selectedIndex = (this.selectedIndex + direction + this.candidates.length) % this.candidates.length;
  }

  select(): { insertText: string } | null {
    if (!this.active || !this.candidates.length) return null;
    const selected = this.candidates[this.selectedIndex];
    this.active = false;
    // 説明用の引数プレースホルダーを送信しないよう、固定部分だけ挿入します。
    return { insertText: selected.usage.replace(/(?:<[^>]+>|\[[^\]]+\]|\S+\|\S+).*$/, '') };
  }

  cancel(): void {
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  render(maxCandidates = this.candidates.length): string {
    if (!this.active) return '';
    const candidates = this.candidates;
    if (!candidates.length) {
      return cliText('未対応のスラッシュコマンド（Slash Command）です: /{0}\nEscで候補を閉じて編集できます。',this.prefix);
    }
    const header = this.prefix ? cliText('Slash Command 候補（/{0}）:',this.prefix) : cliText('Slash Command（スラッシュコマンド / Slash Command）:');
    const count = Math.max(1, maxCandidates);
    const start = Math.max(0, Math.min(this.selectedIndex - count + 1, candidates.length - count));
    const lines = candidates.slice(start, start + count).map((entry, offset) => {
      const i = start + offset;
      const marker = i === this.selectedIndex ? '> ' : '  ';
      return `${marker}${entry.usage.padEnd(28)}${cliText(entry.summary)}`;
    });
    return [header, ...lines, cliText('↑/↓ 選択 · Enter/Tab 挿入 · Esc 取消 ({0}/{1})',this.selectedIndex + 1,candidates.length)].join('\n');
  }
}
