import { createHash } from 'node:crypto';
import { FederationError, MAX_TEXT_BYTES, record, type ExecutionAdapter } from './contracts.js';

/** 初期アダプターは副作用のないダイジェスト計算です。シェルや任意ファイルを公開しません。 */
export function digestAdapter(): ExecutionAdapter {
  const validate = (value: unknown) => {
    const row = record(value);
    if (Object.keys(row).length !== 1 || typeof row.text !== 'string' || Buffer.byteLength(row.text, 'utf8') > MAX_TEXT_BYTES) throw new FederationError('textだけを含む64KiB以内の入力が必要です。');
  };
  return {
    id: 'text.sha256', description: '明示されたテキストのSHA-256を計算する副作用のないサービス。意味に応じた文章生成やファイル参照は行わない。', validate,
    async execute(input) { validate(input); const value = (input as { text: string }).text; return { sha256: createHash('sha256').update(value, 'utf8').digest('hex'), bytes: Buffer.byteLength(value, 'utf8') }; },
  };
}
