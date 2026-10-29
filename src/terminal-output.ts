import { cliText } from './cli-language.js';
import type { WriteStream } from 'node:tty';
import stringWidth from 'string-width';

/** 全角文字・絵文字とANSI装飾を分割せず、端末の自動折返しより前に改行します。 */
export function wrapTerminalLine(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '', columns = 0, style = '';
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const part of text.replace(/\t/g, '    ').split(/(\x1b\[[0-9;:]*m)/)) {
    if (/^\x1b\[/.test(part)) {
      line += part;
      style = part === '\x1b[0m' || part === '\x1b[m' ? '' : style + part;
      continue;
    }
    for (const { segment } of segmenter.segment(part)) {
      const size = stringWidth(segment);
      if (columns > 0 && columns + size > width) {
        lines.push(line + (style ? '\x1b[0m' : ''));
        line = style; columns = 0;
      }
      line += segment; columns += size;
    }
  }
  lines.push(line + (style ? '\x1b[0m' : ''));
  return lines;
}

/** CLI出力を用途別に分類し、色と見出しを一貫させます。 */
export type OutputSection = 'input' | 'process' | 'todo' | 'answer';

const sectionPresentation: Record<OutputSection, { title: string; color: number }> = {
  input: { title: '入力', color: 36 },
  process: { title: '処理', color: 33 },
  todo: { title: '作業計画', color: 35 },
  answer: { title: '回答', color: 32 },
};

/** 端末がANSI（アンシ / ANSI）色に対応し、利用者が無効化していない場合だけ着色します。 */
export function terminalColorEnabled(output: Pick<WriteStream, 'isTTY'> = process.stdout): boolean {
  return Boolean(output.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
}

/** 複数行を同じインデントへ揃え、入力・途中経過・回答を視覚的に分離します。 */
export function formatOutputSection(section: OutputSection, text: string, color = false, columns = process.stdout.isTTY ? process.stdout.columns || 80 : Infinity): string {
  const presentation = sectionPresentation[section];
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  // 入力・回答を会話の主軸に置き、内部処理・作業計画はさらに1段下げて階層を明確にします。
  const indent = section === 'process' || section === 'todo' ? '    ' : '  ';
  const body = normalized.split('\n').flatMap(line => wrapTerminalLine(line, Math.max(2, columns - indent.length - 3)))
    .map(line => `${color ? `\x1b[1;${presentation.color}m` : ''}${indent}│ ${line}`).join('\n');
  // 各行の装飾リセットから独立して、下端にも枠線の色を明示します。
  const frameColor = color ? `\x1b[1;${presentation.color}m` : '';
  const reset = color ? '\x1b[0m' : '';
  return `${frameColor}${indent}╭─ ${cliText(presentation.title)}${reset}\n${body}\n${frameColor}${indent}╰─${reset}`;
}

/** Markdown回答を端末用の装飾へ変換します。原文は変更せず、表示時だけ記号を解釈します。 */
export function formatMarkdownAnswer(text: string, color = false, columns = process.stdout.isTTY ? process.stdout.columns || 80 : Infinity): string {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  let inCodeBlock = false;
  const lines = normalized.split('\n').flatMap(line => {
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      inCodeBlock = !inCodeBlock;
      const language = fence[1].trim();
      return language && inCodeBlock ? [`  │   ┌─ code: ${language}`] : [];
    }
    if (inCodeBlock) return [`  │   ${color ? `\x1b[38;5;222m${line}\x1b[0m` : line}`];
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const marker = heading[1].length === 1 ? '◆' : '◇';
      const content = renderInlineMarkdown(heading[2], color);
      return [`  │ ${color ? `\x1b[1;36m${marker} ${content}\x1b[0m` : `${marker} ${content}`}`];
    }
    const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bullet) return [`  │ ${bullet[1]}${color ? '\x1b[36m●\x1b[0m' : '●'} ${renderInlineMarkdown(bullet[2], color)}`];
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (numbered) return [`  │ ${numbered[1]}${color ? `\x1b[36m${numbered[2]}.\x1b[0m` : `${numbered[2]}.`} ${renderInlineMarkdown(numbered[3], color)}`];
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) return [`  │ ${color ? `\x1b[90m▌ ${renderInlineMarkdown(quote[1], color)}\x1b[0m` : `▌ ${renderInlineMarkdown(quote[1], color)}`}`];
    const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
    if (rule) return [`  │ ${color ? '\x1b[90m────────────────────────\x1b[0m' : '────────────────────────'}`];
    return [`  │ ${renderInlineMarkdown(line, color)}`];
  });
  const top = color ? `\x1b[1;32m  ╭─ ${cliText('回答')}\x1b[0m` : `  ╭─ ${cliText('回答')}`;
  const bottom = color ? '\x1b[1;32m  ╰─\x1b[0m' : '  ╰─';
  // 本文の装飾リセットと独立して、すべての物理行へ緑色の枠線を付けます。
  const framed = lines.flatMap(line => wrapTerminalLine(line.slice(4), Math.max(2, columns - 5)))
    .map(line => `${color ? '\x1b[1;32m  │\x1b[0m ' : '  │ '}${line}`);
  return [top, ...framed, bottom].join('\n');
}

/** 1行内の代表的なMarkdown記法を、ANSI対応時だけ文字装飾へ置き換えます。 */
function renderInlineMarkdown(text: string, color: boolean): string {
  const links = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, color ? '\x1b[4;36m$1\x1b[0m \x1b[90m($2)\x1b[0m' : '$1 ($2)');
  const code = links.replace(/`([^`]+)`/g, color ? '\x1b[38;5;222m$1\x1b[0m' : '$1');
  const bold = code.replace(/\*\*([^*]+)\*\*/g, color ? '\x1b[1m$1\x1b[0m' : '$1');
  return bold.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, color ? '\x1b[3m$1\x1b[0m' : '$1');
}

/** 質問と回答から成る会話ターン（Turn）の境界を、端末幅に収まる横線で示します。 */
export function formatConversationSeparator(columns = 80, color = false): string {
  const width = Math.max(1, Math.floor(columns));
  const plain = '─'.repeat(width);
  return color ? `\x1b[2;90m${plain}\x1b[0m` : plain;
}

/** Heartbeatの経過時間に応じて256色パレットを循環し、活動中であることを視覚化します。 */
export function formatWorkingActivity(text: string, elapsedSeconds: number, color = false): string {
  const palette = [39, 45, 51, 50, 49, 48, 47, 46, 82, 118, 154, 190, 226, 220, 214, 208];
  const plain = `    ${text.replace(/\r?\n\s*└\s*/g, ' · ').replace(/^•\s*/, '• ')}`;
  if (!color) return plain;
  const phase = Math.floor(Math.max(0, elapsedSeconds) / 5) % palette.length;
  const visibleLength = Math.max(1, [...plain].length - 1);
  return [...plain].map((character, index) => {
    const offset = Math.floor(index * (palette.length - 1) / visibleLength);
    return `\x1b[1;38;5;${palette[(phase + offset) % palette.length]}m${character}`;
  }).join('') + '\x1b[0m';
}
