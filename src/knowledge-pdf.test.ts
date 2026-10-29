import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { extractBrowserPdf, pdfAssetPath } from './knowledge-pdf.js';

test('PDF描画の資産は専用接続元の許可ファイルだけに限定する', () => {
  const root = path.resolve('node_modules/pdfjs-dist'), origin = 'https://wentian-pdf.invalid';
  assert.equal(pdfAssetPath(origin + '/build/pdf.mjs', origin, root), path.join(root, 'build/pdf.mjs'));
  for (const url of ['https://other.invalid/build/pdf.mjs', origin + '/package.json', origin + '/build/../../.env', origin + '/cmaps/%2e%2e%2fpackage.json', origin + '/cmaps/a%5cb', origin + '/build/pdf.mjs?file=secret', origin + '/cmaps/%FF']) assert.equal(pdfAssetPath(url, origin, root), undefined);
});

test('中断済み・容量超過のPDFはブラウザー起動前に拒否する', async () => {
  const stop = new AbortController(); stop.abort();
  await assert.rejects(extractBrowserPdf(Buffer.from('%PDF-'), stop.signal, async () => ''), { name: 'AbortError' });
  await assert.rejects(extractBrowserPdf(Buffer.alloc(25 * 1024 * 1024 + 1), new AbortController().signal, async () => ''), /25 MiB/);
});

test('スキャンPDFは実画像でOCRへ渡し、OCR待機中の中断も伝播する', { timeout: 30000 }, async () => {
  const bytes = await readFile('examples/knowledge/demo/09-scan-checklist.pdf');
  const stop = new AbortController(); let calls = 0;
  await assert.rejects(extractBrowserPdf(bytes, stop.signal, async (image, mime, signal) => {
    calls++; assert.equal(mime, 'image/png'); assert.equal(image.subarray(1, 4).toString(), 'PNG');
    assert.ok(image.length > 1000, '実ページを描画した画像が必要です。');
    stop.abort(); signal.throwIfAborted(); return '';
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  const require = createRequire(import.meta.url);
  assert.equal(require.cache[require.resolve('@napi-rs/canvas')], undefined, 'NodeのネイティブCanvasをロードしません。');
});

test('壊れたPDFは空の成功結果にせず拒否する', { timeout: 30000 }, async () => {
  await assert.rejects(extractBrowserPdf(Buffer.from('%PDF-1.4\ninvalid'), AbortSignal.timeout(20000), async () => ''));
});
