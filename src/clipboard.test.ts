import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { extractCopyTarget, writeClipboardText } from './clipboard.js';

test('extractCopyTarget returns last assistant string by default', () => {
  const conversation = [
    { role: 'user', content: '質問1' },
    { role: 'assistant', content: '回答1' },
    { role: 'user', content: '質問2' },
    { role: 'assistant', content: '回答2' },
    { role: 'assistant', content: '回答3(tools含む)' },
  ];
  assert.equal(extractCopyTarget(conversation), '回答3(tools含む)');
  assert.equal(extractCopyTarget(conversation, 0), '回答3(tools含む)');
  assert.equal(extractCopyTarget(conversation, 1), '回答2');
  assert.equal(extractCopyTarget(conversation, 2), '回答1');
});

test('extractCopyTarget flattens array content and skips tool parts', () => {
  const conversation = [
    { role: 'user', content: '配列を渡して' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '考察' },
        { type: 'tool_call' },
        { type: 'text', text: '結論' },
      ],
    },
  ];
  assert.equal(extractCopyTarget(conversation), '考察\n結論');
});

test('extractCopyTarget returns undefined when no assistant message exists', () => {
  assert.equal(extractCopyTarget([]), undefined);
  assert.equal(extractCopyTarget([{ role: 'user', content: 'q' }]), undefined);
});

test('writeClipboardText rejects empty input', async () => {
  await assert.rejects(writeClipboardText(''), /空/);
});

test('writeClipboardText rejects non-windows platform', async function(t) {
  if (process.platform === 'win32') { t.skip(); return; }
  await assert.rejects(writeClipboardText('hello'), /Windows/);
});

test('writeClipboardText does not mangle multi-byte Japanese characters on win32', async function(t) {
  if (process.platform !== 'win32') { t.skip(); return; }
  const sample = '日本語テスト\nファイル一覧\n**重要**\n絵文字: ✔️';
  try {
    const result = await writeClipboardText(sample);
    assert.equal(result.truncated, false);
    assert.ok(result.bytes > 0, 'bytes should be reported');
    // PowerShell Set-Clipboard はUnicodeを扱うため、CP932にない文字（絵文字やJIS X 0208外の文字）も保持できる
    assert.ok(result.bytes >= Buffer.byteLength(sample, 'utf8') * 0.9, 'UTF-8バイト数が想定範囲内');
  } catch (error) {
    if (/ExternalException|クリップボード/i.test((error as Error).message)) { t.skip(); return; }
    throw error;
  }
});

test('writeClipboardText truncates when over maxChars', async function(t) {
  if (process.platform !== 'win32') { t.skip(); return; }
  const huge = 'あ'.repeat(500);
  try {
    const result = await writeClipboardText(huge, 100);
    assert.equal(result.truncated, true);
  } catch (error) {
    if (/ExternalException|クリップボード/i.test((error as Error).message)) { t.skip(); return; }
    throw error;
  }
});
