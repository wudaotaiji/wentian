import { stripVTControlCharacters } from 'node:util';
import { RGBA, StyledText, TextAttributes, type TextChunk } from '@opentui/core';

const sgr = /\x1b\[[0-9;:]*m/g;
function indexedColor(index: number): RGBA | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return;
  return RGBA.fromIndex(index);
}

/** 色・文字装飾のSGRだけを残し、端末のカーソル移動や画面消去を本文から除去します。 */
export function sanitizeStyledTerminalText(text: string): string {
  const withoutOsc = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '');
  return withoutOsc.split(/(\x1b\[[0-9;:]*m)/g).map(part => /^\x1b\[[0-9;:]*m$/.test(part) ? part : stripVTControlCharacters(part).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')).join('');
}

/** ANSIを直接端末へ流さず、描画器の色・装飾へ変換します。折返しと書込み間で状態を維持します。 */
export class TerminalTextStyler {
  private fg?: RGBA;
  private bg?: RGBA;
  private attributes = 0;
  parse(text: string, enabled = true): StyledText {
    const chunks: TextChunk[] = [];
    let offset = 0;
    const append = (value: string) => { if (value) chunks.push({ __isChunk: true, text: value, ...(enabled ? { fg: this.fg, bg: this.bg, attributes: this.attributes } : { attributes: 0 }) }); };
    for (const match of text.matchAll(sgr)) {
      append(text.slice(offset, match.index)); offset = match.index! + match[0].length;
      const values = match[0].slice(2, -1).split(/[;:]/).map(value => Number(value || 0));
      for (let i = 0; i < values.length; i++) {
        const code = values[i];
        if (code === 0) { this.fg = undefined; this.bg = undefined; this.attributes = 0; }
        else if (code === 1) this.attributes |= TextAttributes.BOLD;
        else if (code === 2) this.attributes |= TextAttributes.DIM;
        else if (code === 3) this.attributes |= TextAttributes.ITALIC;
        else if (code === 4) this.attributes |= TextAttributes.UNDERLINE;
        else if (code === 7) this.attributes |= TextAttributes.INVERSE;
        else if (code === 9) this.attributes |= TextAttributes.STRIKETHROUGH;
        else if (code === 22) this.attributes &= ~(TextAttributes.BOLD | TextAttributes.DIM);
        else if (code === 23) this.attributes &= ~TextAttributes.ITALIC;
        else if (code === 24) this.attributes &= ~TextAttributes.UNDERLINE;
        else if (code === 27) this.attributes &= ~TextAttributes.INVERSE;
        else if (code === 29) this.attributes &= ~TextAttributes.STRIKETHROUGH;
        else if (code === 39) this.fg = undefined;
        else if (code === 49) this.bg = undefined;
        else if (code >= 30 && code <= 37) this.fg = indexedColor(code - 30);
        else if (code >= 90 && code <= 97) this.fg = indexedColor(code - 90 + 8);
        else if (code >= 40 && code <= 47) this.bg = indexedColor(code - 40);
        else if (code >= 100 && code <= 107) this.bg = indexedColor(code - 100 + 8);
        else if (code === 38 || code === 48) {
          let color: RGBA | undefined;
          if (values[i + 1] === 5) { color = indexedColor(values[i + 2]); i += 2; }
          else if (values[i + 1] === 2) {
            const rgb = values.slice(i + 2, i + 5);
            if (rgb.length === 3 && rgb.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) color = RGBA.fromInts(rgb[0], rgb[1], rgb[2]);
            i += 4;
          }
          if (color) { if (code === 38) this.fg = color; else this.bg = color; }
        }
      }
    }
    append(text.slice(offset));
    return new StyledText(chunks);
  }
}
