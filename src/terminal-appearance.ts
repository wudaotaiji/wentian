import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { machineConfigDirectory } from './agent-exclusion-policy.js';
import { renameWithRetry } from './atomic-file.js';
import type { TaskExecution } from './task-outcome.js';
import { cliText } from './cli-language.js';

/** 入力領域だけの配色です。プロトコル名を固定し、会話内容の意味判断には使いません。 */
export const terminalThemes = {
  blue: { label: 'ブルー', background: '#14283f', statusBackground: '#0b1626', foreground: '#edf5ff', muted: '#adbfda' },
  slate: { label: 'グレー', background: '#272d37', statusBackground: '#15191f', foreground: '#f1f3f7', muted: '#bbc3d0' },
  green: { label: 'グリーン', background: '#16372e', statusBackground: '#0b211b', foreground: '#effff7', muted: '#add7c5' },
  purple: { label: 'パープル', background: '#302341', statusBackground: '#1a1226', foreground: '#faf0ff', muted: '#d0b7df' },
  none: { label: '端末既定', background: undefined, statusBackground: undefined, foreground: undefined, muted: undefined },
} as const;
export type TerminalThemeName = keyof typeof terminalThemes;
export interface TerminalInputLifecycle {
  controller?: { read(presentation: TerminalInputPresentation): Promise<string | null>; activity(text: string): void; insertText(text: string): void; write(text: string): void; close(): void };
  voiceStop?: () => void;
  interrupt?: () => void;
  transcriptToggle?: () => void;
}
export interface TerminalInputPresentation { theme?: TerminalThemeName; status?: string[] | (() => string[]); lifecycle?: TerminalInputLifecycle; busy?: boolean; selection?:boolean }
/** 選択設定と前回の実行結果を区別し、次の応答Agentを事前に断定しません。 */
export function terminalInputStatus(input: { model: string; forcedAgent?: string; forcedModel?: string; sessionId: string; images: number; lastExecution?: TaskExecution; lastStatus?: string }): string[] {
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, ' ');
  const selection = input.forcedAgent ? `Agent: ${clean(input.forcedAgent)}（${cliText('強制優先')}） · ${cliText('設定モデル')}: ${clean(input.forcedModel || cliText('未確認'))}` : `Agent: ${cliText('自動選択')} · ${cliText('要求モデル')}: ${clean(input.model)}${input.model === 'wentian-auto/local' ? cliText('（全経路へ自動切替）') : ''}`;
  const last = input.lastExecution ? `${input.lastExecution.agent || 'Gateway'} / ${(input.lastExecution.elapsedMs / 1000).toFixed(1)}s` : input.lastStatus ? `${input.lastStatus}（${cliText('実行情報なし')}）` : cliText('未実行');
  return [`Wentian · ${selection}`, `Session: ${clean(input.sessionId).slice(-12)} · ${cliText('画像')}: ${input.images} · ${cliText('前回')}: ${clean(last)}`];
}
export const terminalAppearancePath = () => process.env.WENTIAN_TERMINAL_SETTINGS_FILE || path.join(machineConfigDirectory(), 'terminal-appearance.json');
export function isTerminalTheme(value: string): value is TerminalThemeName { return Object.hasOwn(terminalThemes, value); }
/** 不明・破損設定は安全な既定配色へ戻し、利用者のファイルは上書きしません。 */
export function readTerminalTheme(): TerminalThemeName {
  try { const value = JSON.parse(readFileSync(terminalAppearancePath(), 'utf8')).theme; return typeof value === 'string' && isTerminalTheme(value) ? value : 'blue'; } catch { return 'blue'; }
}
export async function saveTerminalTheme(theme: string): Promise<void> {
  if (!isTerminalTheme(theme)) throw new Error('配色は blue / slate / green / purple / none から選択してください。');
  const target = terminalAppearancePath(); await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, theme }) + '\n', { encoding: 'utf8', mode: 0o600 }); await renameWithRetry(temporary, target);
}
/** 操作可能なキーと確認済み状態だけを一つのヒント領域へ配置します。 */
export function terminalInputHint(presentation: TerminalInputPresentation = {}): string {
  const status = typeof presentation.status === 'function' ? presentation.status() : presentation.status;
  return [...(status || [cliText('Wentian · 次の依頼を入力できます'), cliText('/status 状態確認 · /theme 配色選択')]), cliText(presentation.busy ? '次の依頼を編集中 · Esc/Ctrl+C 処理中断 · Enterは完了後に送信' : 'Enter 送信 · Ctrl+J 改行 · ↑↓ 履歴 · / コマンド · Ctrl+C 取消/終了')].join('\n');
}
