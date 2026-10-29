/**
 * Windowsクリップボードへテキストを書き戻すためのヘルパーです。
 * PowerShell の `Set-Clipboard` を経由してUnicode文字列をそのまま渡し、UTF-8バイト列を
 * `clip.exe` に渡すことで起きるCP932誤認による文字化けを避けます。
 * 秘密情報をログへ出力しません。
 */
import { execFile } from 'node:child_process';

export interface ClipboardWriteResult {
  bytes: number;
  truncated: boolean;
}

/**
 * テキストをWindowsクリップボードへ設定します。
 * 大きすぎる文字列は末尾を切り詰めてから書き込み、戻り値で切り詰めたかを報告します。
 */
export function writeClipboardText(text: string, maxChars = 200_000): Promise<ClipboardWriteResult> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('クリップボード書き込みは現在Windowsだけに対応しています。'));
  }
  if (typeof text !== 'string' || text.length === 0) {
    return Promise.reject(new Error('コピーする文字列が空です。'));
  }
  const truncated = text.length > maxChars;
  const payload = truncated ? text.slice(0, maxChars) : text;
  // PowerShellのSet-Clipboardは .NET のClipboardクラス経由でUnicodeを扱うため、
  // UTF-8をclip.exeへ直接流す場合に起きるCP932誤認を回避できます。
  // 引数は-HereString経由でPowerShellへ渡し、シングルクオート衝突は二重化してエスケープします。
  const escaped = payload.replace(/'/g, "''");
  const script = `$ErrorActionPreference = 'Stop'; Set-Clipboard -Value @'\n${escaped}\n'@`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Sta', '-Command', script], {
      windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    }, error => {
      if (!error) {
        resolve({ bytes: Buffer.byteLength(payload, 'utf8'), truncated });
        return;
      }
      const detail = error.message.replace(/[\r\n]+/g, ' ').trim();
      reject(new Error(`クリップボード書込に失敗しました: ${detail}`));
    });
  });
}

/**
 * 会話履歴からコピー対象（直前のassistant応答、またはN個前）の本文を抽出します。
 * tool_callsや配列contentは文字列化して返却します。
 */
export function extractCopyTarget(
  conversation: ReadonlyArray<{ role: string; content?: unknown }>,
  turnsBack = 0,
): string | undefined {
  if (!Array.isArray(conversation) || conversation.length === 0) return undefined;
  const assistants: string[] = [];
  for (let i = conversation.length - 1; i >= 0; i--) {
    const message = conversation[i];
    if (!message || message.role !== 'assistant') continue;
    const text = stringifyAssistantContent(message.content);
    if (text) assistants.push(text);
    if (assistants.length > turnsBack) break;
  }
  return assistants[turnsBack];
}

function stringifyAssistantContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map(part => {
        if (part && typeof part === 'object' && 'type' in part) {
          const type = (part as { type?: unknown }).type;
          if (type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
            return (part as { text: string }).text;
          }
          if (type === 'tool_call' || type === 'tool_calls') return undefined;
        }
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return undefined;
      })
      .filter((part): part is string => typeof part === 'string' && part.length > 0);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  return undefined;
}
