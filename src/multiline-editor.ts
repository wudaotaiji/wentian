import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

export interface DraftCommandResult { handled: boolean; lines: string[]; message?: string; }

/** 複数行ドラフトに対する端末内編集コマンドを安全に適用します。 */
export function applyDraftCommand(lines: string[], input: string): DraftCommandResult {
  const command = input.replace(/^：/, ':');
  if (command === ':show') return { handled: true, lines, message: lines.length ? lines.map((line, index) => `${index + 1}: ${line}`).join('\n') : 'ドラフトは空です。' };
  if (command === ':undo') return { handled: true, lines: lines.slice(0, -1), message: '最後の1行を取り消しました。' };
  const match = command.match(/^:(replace|insert|delete)\s+(\d+)(?:\s+(.*))?$/s);
  if (!match) return { handled: false, lines };
  const action = match[1]; const lineNumber = Number(match[2]); const index = lineNumber - 1; const text = match[3] || '';
  if (action === 'insert' && lineNumber >= 1 && lineNumber <= lines.length + 1) { const next = [...lines]; next.splice(index, 0, text); return { handled: true, lines: next, message: `${lineNumber}行目へ挿入しました。` }; }
  if (index < 0 || index >= lines.length) return { handled: true, lines, message: `行番号は1～${lines.length}で指定してください。` };
  const next = [...lines];
  if (action === 'replace') next[index] = text; else next.splice(index, 1);
  return { handled: true, lines: next, message: `${lineNumber}行目を${action === 'replace' ? '置換' : '削除'}しました。` };
}

/** ドラフトを外部エディターで開き、閉じた後の全行を読み戻します。 */
export async function editDraftExternally(lines: string[]): Promise<string[]> {
  const directory = path.resolve('.wentian', 'runtime'); await mkdir(directory, { recursive: true });
  const draftPath = path.join(directory, `draft-${process.pid}.txt`); await writeFile(draftPath, lines.join('\n'), 'utf8');
  const configured = (process.env.VISUAL || process.env.EDITOR || '').trim();
  const executable = configured || (process.platform === 'win32' ? 'notepad.exe' : 'vi');
  try {
    await new Promise<void>((resolve, reject) => { const child = spawn(executable, [draftPath], { stdio: 'inherit', windowsHide: false }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`エディターが終了コード${code}で終了しました。`))); });
    return (await readFile(draftPath, 'utf8')).replace(/\r\n/g, '\n').split('\n');
  } finally { await unlink(draftPath).catch(() => undefined); }
}
