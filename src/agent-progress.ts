import type { WriteStream } from 'node:tty';
import { formatMarkdownAnswer, formatWorkingActivity, terminalColorEnabled } from './terminal-output.js';
import { cliText } from './cli-language.js';

/** Codex風の実行中ステータス行を組み立てます。 */
export function formatWorkingStatus(elapsedSeconds: number): string {
  return cliText('• Working ({0}s • esc to interrupt)', Math.max(0, Math.floor(elapsedSeconds)));
}

/** Todo項目の状態種別です。Codex CLI互換の4状態を採用します。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Todo項目の表示用モデルです。
 * `id` は発行順に固定して上書き換之を安全にし、`label` はユーザー向け文言を保持します。
 */
export interface TodoEntry { id: string; label: string; status: TodoStatus; detail: string; }

function todoPrefix(status: TodoStatus): string {
  switch (status) {
    case 'in_progress': return '[•]';
    case 'completed': return '[✓]';
    case 'failed': return '[!]';
    case 'pending':
    default: return '[ ]';
  }
}

/**
 * Todoリスト全体を見やすい文字列へ整形します。
 * 1行目にヘッダ、その下に各項目を状態シンボル付きで並べます。
 */
export function formatTodoPanel(modelTitle: string, entries: ReadonlyArray<TodoEntry>): string {
  const lines: string[] = [`# Todos · ${modelTitle}`];
  for (const entry of entries) lines.push(`${todoPrefix(entry.status)} ${entry.label}${entry.detail ? `  ${entry.detail}` : ''}`);
  return lines.join('\n');
}

/** 1工程の担当・状態を、Compact表示でも判別できる色付きTodoとして整形します。 */
export function formatAgentTodoUpdate(agent: string, entry: Omit<TodoEntry, 'id'>, color = false): string {
  const label = agent.trim() ? agent.trim().charAt(0).toUpperCase() + agent.trim().slice(1) : 'Wentian';
  const prefix = todoPrefix(entry.status);
  if (!color) return `# Todos · ${label}\n${prefix} ${entry.label}${entry.detail ? `  ${entry.detail}` : ''}`;
  const statusColor = entry.status === 'completed' ? 32 : entry.status === 'in_progress' ? 33 : entry.status === 'failed' ? 31 : 90;
  return `\x1b[1;36m# Todos · ${label}\x1b[0m\n\x1b[1;${statusColor}m${prefix}\x1b[0m ${entry.label}${entry.detail ? `  \x1b[90m${entry.detail}\x1b[0m` : ''}`;
}

/**
 * Agent実行中の経過秒数、TODOパネル、各操作イベントを端末へ表示します。
 * ステータスは同じ行を書き換え、TODOパネルは新しい行として積みます。
 * 確定イベントや回答を出す直前にステータスを消去することで、
 * ANSI（アンシ / ANSI）制御文字が会話履歴へ混ざらないようにします。
 */
export class AgentProgress {
  private readonly startedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private active = false;
  private cursorBelowProgress = false;
  private readonly todos: TodoEntry[] = [];
  private nextId = 1;
  private modelTitle: string;
  private readonly compact: boolean;
  private transcript: string[] = [];
  private expanded = false;

  constructor(private readonly output: WriteStream, modelTitle = process.env.WENTIAN_AGENT_TODO_TITLE ?? 'Wentian Agent', private readonly onLog?: (text: string) => void, mode: 'compact' | 'verbose' = process.env.WENTIAN_PROGRESS_MODE === 'verbose' ? 'verbose' : 'compact', private readonly onActivity?: (text: string) => void) {
    this.modelTitle = modelTitle;
    this.compact = mode === 'compact';
  }

  /** 実際に処理を担当し始めたAgentとモデルへ見出しを更新します。推測値は表示しません。 */
  setExecutionIdentity(agent: string, model?: string): void {
    const normalizedAgent = agent.trim();
    if (!normalizedAgent) return;
    const label = normalizedAgent.charAt(0).toUpperCase() + normalizedAgent.slice(1);
    this.modelTitle = `${label}${model?.trim() ? ` · ${model.trim()}` : ''}`;
    this.refreshTodos();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.render();
    this.timer = setInterval(() => this.render(), 250);
    this.timer.unref();
  }

  /** 動的ステータスを一旦消し、確定した操作または回答を通常行として出力します。 */
  log(text: string): void {
    this.transcript.push(text);
    if (this.compact && !this.expanded) { if (this.onLog) this.onLog(text); return; }
    this.clearLine();
    this.output.write(`${text.replace(/\n?$/, '\n')}`);
    if (this.onLog) this.onLog(text);
    if (this.active) this.render();
  }

  /** TODOパネルを再描画します。状態が変化した直後に呼ぶとパネルが上書き更新されます。 */
  refreshTodos(): void {
    if (this.compact && !this.expanded) return;
    this.clearLine();
    this.output.write(`${formatTodoPanel(this.modelTitle, this.todos)}\n`);
    if (this.active) this.render();
  }

  /** 新しいTODO項目を追加し、追加直後のパネルを再描画します。 */
  addTodo(label: string, status: TodoStatus = 'pending', detail = ''): TodoEntry {
    const entry: TodoEntry = { id: `step-${this.nextId++}`, label, status, detail };
    this.todos.push(entry);
    this.refreshTodos();
    return entry;
  }

  /** 既存TODO項目の状態と詳細を更新します。id が見つからない場合は無視します。 */
  updateTodo(id: string, patch: Partial<Pick<TodoEntry, 'status' | 'detail' | 'label'>>): void {
    const target = this.todos.find(entry => entry.id === id);
    if (!target) return;
    if (patch.status) target.status = patch.status;
    if (patch.detail !== undefined) target.detail = patch.detail;
    if (patch.label) target.label = patch.label;
    this.refreshTodos();
  }

  /** TODO項目を `completed` 状態へ移します。 */
  completeTodo(id: string, detail = ''): void {
    const patch: Partial<Pick<TodoEntry, 'status' | 'detail'>> = { status: 'completed' };
    if (detail) patch.detail = detail;
    this.updateTodo(id, patch);
  }

  /** 最終Todoを完了させてから回答を出力し、回答後に進捗表示が残らない順序を保証します。 */
  completeTodoThenLog(id: string, detail: string, answer: string): void {
    this.completeTodo(id, detail);
    this.clearLine();
    if (this.compact && !this.expanded && this.transcript.length) this.output.write(`${this.summary()}\n`);
    const plain = formatMarkdownAnswer(answer);
    this.output.write(`${formatMarkdownAnswer(answer, terminalColorEnabled(this.output), this.output.isTTY ? this.output.columns || 80 : Infinity)}\n`);
    // 再描画用の履歴にはANSI制御文字を含めず、OpenTUIとの表示競合を防ぎます。
    if (this.onLog) this.onLog(plain);
    if (this.active) this.render();
  }

  /** TODO項目を `failed` 状態へ移します。 */
  failTodo(id: string, detail = ''): void {
    const patch: Partial<Pick<TodoEntry, 'status' | 'detail'>> = { status: 'failed' };
    if (detail) patch.detail = detail;
    this.updateTodo(id, patch);
  }

  /** TODO項目を `in_progress` 状態へ移します。 */
  startTodo(id: string, detail = ''): void {
    const patch: Partial<Pick<TodoEntry, 'status' | 'detail'>> = { status: 'in_progress' };
    if (detail) patch.detail = detail;
    this.updateTodo(id, patch);
  }

  /** 現在のTODOリストをスナップショットとして返します。テスト・参照用。 */
  snapshot(): ReadonlyArray<TodoEntry> { return [...this.todos]; }

  title(): string { return this.modelTitle; }

  /** Compact表示で隠している中間イベントをCtrl+T操作に応じて展開・折りたたみします。 */
  toggleTranscript(): void {
    if (!this.compact) return;
    this.clearLine();
    this.expanded = !this.expanded;
    this.output.write(this.expanded ? `${this.transcriptText()}\n${formatTodoPanel(this.modelTitle, this.todos)}\n` : `${this.summary()}\n`);
    if (this.active) this.render();
  }

  /** Task分解など開始時に必ず見せる情報を、Compact Modeでも色付きMarkdownとして表示します。 */
  announce(text: string): void {
    this.transcript.push(text);
    this.clearLine();
    this.output.write(`${formatMarkdownAnswer(text, terminalColorEnabled(this.output), this.output.isTTY ? this.output.columns || 80 : Infinity)}\n`);
    if (this.onLog) this.onLog(formatMarkdownAnswer(text));
    if (this.active) this.render();
  }

  /** Orchestration工程の担当確定・状態遷移を、折り畳まず即時表示します。 */
  announceAgentTodo(agent: string, label: string, status: TodoStatus, detail = ''): void {
    const plain = formatAgentTodoUpdate(agent, { label, status, detail }, false);
    this.transcript.push(plain);
    this.clearLine();
    this.output.write(`${formatAgentTodoUpdate(agent, { label, status, detail }, terminalColorEnabled(this.output))}\n`);
    if (this.onLog) this.onLog(plain);
    if (this.active) this.render();
  }

  transcriptText(): string { return this.transcript.join('\n'); }
  summary(): string { return `… +${this.transcript.reduce((count, text) => count + text.split('\n').length, 0)} lines (ctrl + t to view transcript)`; }

  stop(): number {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.active = false;
    this.clearLine();
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  private render(): void {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    if (this.onActivity) { this.onActivity(formatWorkingActivity(formatWorkingStatus(elapsed), elapsed, terminalColorEnabled(this.output))); return; }
    this.clearLine();
    this.output.write(formatWorkingActivity(formatWorkingStatus(elapsed), elapsed, terminalColorEnabled(this.output)));
    // 待機中のカーソルは進捗文字列の末尾ではなく、次行の先頭へ置きます。
    if (this.output.isTTY) {
      this.output.write('\r\n');
      this.cursorBelowProgress = true;
    }
  }

  private clearLine(): void {
    if (this.onActivity) { this.onActivity(''); return; }
    // 再描画・確定出力の前に進捗行へ戻し、更新ごとの空行の増加を防ぎます。
    if (this.cursorBelowProgress) this.output.write('\x1b[1A');
    this.cursorBelowProgress = false;
    this.output.write('\r\x1b[2K');
  }
}
