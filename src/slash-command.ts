import { cliText } from './cli-language.js';
export type SlashCommandName = 'agent' | 'voice' | 'language' | 'theme' | 'status' | 'goal' | 'update' | 'training' | 'copy' | 'help' | 'exit' | 'quit' | 'clear' | 'new' | 'model' | 'images' | 'image' | 'paste-image' | 'clear-images' | 'multi';

export interface SlashCommand { name: SlashCommandName; argument: string; }

const supported = new Set<SlashCommandName>(['agent', 'voice', 'language', 'theme', 'status', 'goal', 'update', 'training', 'copy', 'help', 'exit', 'quit', 'clear', 'new', 'model', 'images', 'image', 'paste-image', 'clear-images', 'multi']);

/**
 * 内部コマンド一覧の表示用データです。
 * 1行説明と、引数付きの使い方を分けて保持し、`/`入力時の即時表示とプレフィックス絞り込みで再利用します。
 */
export interface SlashCommandEntry {
  name: SlashCommandName;
  summary: string;
  usage: string;
}

export const slashCommandEntries: ReadonlyArray<SlashCommandEntry> = [
  { name: 'status', summary: '現在の接続・モデル・会話・画像・外部Agent待機状態', usage: '/status' },
  { name: 'update', summary: '最新版確認と60秒間有効な更新Token発行', usage: '/update' },
  { name: 'update', summary: '明示承認した更新を適用・検証・再起動', usage: '/update apply <TOKEN>' },
  { name: 'goal', summary: '長期Goalを作成・一覧・実行・確認・停止', usage: '/goal [ACTION] [ARG]' },
  { name: 'training', summary: '学習データ蓄積状態を表示', usage: '/training status' },
  { name: 'training', summary: '明示的に蓄積を有効化・無効化', usage: '/training on|off' },
  { name: 'model', summary: 'モデルを一覧から選択、ID指定で直接変更', usage: '/model [MODEL]' },
  { name: 'agent', summary: '外部Agentを一覧から選択、autoで優先指定を解除', usage: '/agent [ID|auto]' },
  { name: 'theme', summary: '入力背景を選択・保存（blue/slate/green/purple/none）', usage: '/theme [COLOR]' },
  { name: 'language', summary: '表示言語と既定の回答言語を選択・保存', usage: '/language [ja|en|zh]' },
  { name: 'voice', summary: '音声を録音して下書きへ追加', usage: '/voice start|stop|cancel|status' },
  { name: 'copy', summary: '直前または指定した過去の回答をクリップボードへコピー', usage: '/copy [N]' },
  { name: 'new', summary: '会話履歴を消去して新しい会話を開始', usage: '/new' },
  { name: 'clear', summary: '会話履歴を消去して新しい会話を開始', usage: '/clear' },
  { name: 'image', summary: '画像を添付', usage: '/image <FILE>' },
  { name: 'paste-image', summary: 'クリップボード画像を添付', usage: '/paste-image' },
  { name: 'images', summary: '添付画像を一覧表示', usage: '/images' },
  { name: 'clear-images', summary: '添付画像をすべて解除', usage: '/clear-images' },
  { name: 'multi', summary: '互換複数行入力を開始', usage: '/multi' },
  { name: 'help', summary: 'Slash Command一覧を表示', usage: '/help' },
  { name: 'exit', summary: 'Wentian Agentを終了', usage: '/exit' },
  { name: 'quit', summary: 'Wentian Agentを終了', usage: '/quit' },
];

/** 先頭のSlash Commandだけを解析し、通常文章中のスラッシュは変更しません。 */
export function parseSlashCommand(input: string): SlashCommand | undefined {
  const match = input.trim().match(/^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;
  const name = match[1].toLowerCase() as SlashCommandName;
  return supported.has(name) ? { name, argument: (match[2] || '').trim() } : undefined;
}

/**
 * 入力途中（`/`のみ、`/st`、`/image "C`など）でも先頭のSlash Command部分を抽出し、候補絞り込みに使える形へ正規化します。
 * スペースを含む引数や通常文章中のスラッシュはSlash Commandとみなさず `undefined` を返します。
 */
export interface SlashCommandPrefix { name: string; raw: string; hasSpace: boolean; }

export function parseSlashCommandPrefix(input: string): SlashCommandPrefix | undefined {
  // 入力先頭の`/`だけを特別扱い（空オブジェクト相当）し、コマンド名があれば `name` を抽出します。
  if (input === '/') return { name: '', raw: '', hasSpace: false };
  const match = input.match(/^\/([a-z][a-z-]*)([^\n]*)$/i);
  if (!match) return undefined;
  return { name: match[1].toLowerCase(), raw: match[1].toLowerCase(), hasSpace: match[2].trim().length > 0 };
}

/**
 * プレフィックスに一致する内部コマンド候補を返します。
 * 一致判定はコマンド名の前方一致で行い、`/`のみ・空入力は全件を返します。
 * `entries` を省略した場合は既定の `slashCommandEntries` を使用します。
 */
export function filterSlashCommands(prefix: string | undefined, entries: ReadonlyArray<SlashCommandEntry> = slashCommandEntries): SlashCommandEntry[] {
  if (!prefix) return [...entries];
  const normalized = prefix.toLowerCase();
  const matched = entries.filter(entry => entry.name.startsWith(normalized));
  // 重複（update / training など複数usage）は許容しつつ、表示順序を安定化するため name でソートします。
  return matched.sort((a, b) => a.name.localeCompare(b.name) || a.usage.localeCompare(b.usage));
}

export function slashCommandHelp(): string {
  const goals: SlashCommandEntry[] = [
    {name:'goal',usage:'/goal new TITLE',summary:'??Goal???'},
    {name:'goal',usage:'/goal list',summary:'Goal?????'},
    {name:'goal',usage:'/goal run ID',summary:'Goal?????????'},
    {name:'goal',usage:'/goal start ID',summary:'Goal????????????'},
    {name:'goal',usage:'/goal status ID',summary:'Goal?Daemon??????'},
    {name:'goal',usage:'/goal stop ID',summary:'Goal Daemon???'},
  ];
  return formatSlashCommandCandidates(undefined, [...slashCommandEntries,...goals]);
}

/**
 * 候補一覧を整形して返します。
 * `prefix` が指定された場合は絞り込み結果のみを返し、空一致のときはその旨を表示します。
 */
export function formatSlashCommandCandidates(prefix: string | undefined, entries: ReadonlyArray<SlashCommandEntry> = slashCommandEntries): string {
  const filtered = filterSlashCommands(prefix, entries);
  if (!filtered.length) return cliText('未対応のSlash Commandです: /{0}\nTabで一覧を再表示、EscまたはCtrl+Cで編集をやり直してください。', prefix);
  const header = prefix ? cliText('Slash Command 候補（/{0}）:', prefix) : cliText('Slash Command（スラッシュコマンド / Slash Command）:');
  const lines = filtered.map(entry => `  ${entry.usage.padEnd(28)}${cliText(entry.summary)}`);
  return [header, ...lines].join('\n');
}
