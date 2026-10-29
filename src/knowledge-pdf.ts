import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeSourceError } from './knowledge-resource.js';

/** PDF.jsのブラウザー版だけを配信し、PDF内のURLから外部へ通信させません。 */
export function pdfAssetPath(url: string, origin: string, assets: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.origin !== origin || parsed.search || parsed.hash) return undefined;
  let relative: string;
  try { relative = decodeURIComponent(parsed.pathname.slice(1)); } catch { return undefined; }
  if (!/^(?:build\/pdf(?:\.worker)?\.mjs|(?:standard_fonts|cmaps|wasm)\/[a-zA-Z0-9_.-]+)$/.test(relative)) return undefined;
  const target = path.resolve(assets, relative);
  return target.startsWith(path.resolve(assets) + path.sep) ? target : undefined;
}

/**
 * ネイティブCanvasに依存せず、一時ブラウザー内のCanvasでPDFを読み取ります。
 * 本文・画像は1ページずつ受け渡し、OCR待機中の中断もブラウザーへ伝播します。
 * 利用者の通常ブラウザープロファイル・Cookie・本番サーバーは使用しません。
 */
export async function extractBrowserPdf(bytes: Buffer, signal: AbortSignal, image: (bytes: Buffer, mime: string, signal: AbortSignal) => Promise<string>, password?: string, options: { textOnly?: boolean; maxPages?: number; maxTextBytes?: number } = {}): Promise<{ content: string; warnings: string[] }> {
  signal.throwIfAborted();
  if (bytes.length > 25 * 1024 * 1024) throw new KnowledgeSourceError('PDFは25 MiB以内で分割してください。');
  const { chromium } = await import('playwright');
  const assets = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  // 実際のDNSやHTTPサーバーを使わず、許可した資産だけをRouteで応答します。
  const origin = 'https://wentian-pdf.invalid';
  const active = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.WENTIAN_KNOWLEDGE_BROWSER_EXECUTABLE || undefined, timeout: 30_000, proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' }, args: ['--disable-background-networking', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const stop = () => { void browser.close().catch(() => undefined); };
  active.addEventListener('abort', stop, { once: true });
  try {
    active.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      try {
        if (route.request().method() !== 'GET') { await route.abort(); return; }
        if (route.request().url() === origin + '/') {
          await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }); return;
        }
        const file = pdfAssetPath(route.request().url(), origin, assets);
        if (!file) { await route.abort(); return; }
        await route.fulfill({ contentType: file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream', body: await readFile(file) });
      } catch { await route.abort().catch(() => undefined); }
    });
    const page = await context.newPage();
    await page.goto(origin, { timeout: 30_000 });
    const count = await page.evaluate(async ({ data, password }) => {
      const moduleUrl = '/build/pdf.mjs';
      const pdfjs = await import(moduleUrl) as typeof import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = '/build/pdf.worker.mjs';
      const loading = pdfjs.getDocument({ data: Uint8Array.from(atob(data), c => c.charCodeAt(0)), password, standardFontDataUrl: '/standard_fonts/', cMapUrl: '/cmaps/', cMapPacked: true, wasmUrl: '/wasm/', useSystemFonts: false, disableFontFace: true, enableXfa: false });
      const pdf = await loading.promise;
      (window as unknown as { wentianPdf: import('pdfjs-dist').PDFDocumentProxy }).wentianPdf = pdf;
      return pdf.numPages;
    }, { data: bytes.toString('base64'), password });
    const maxPages = options.maxPages ?? 500;
    if (count > maxPages) throw new KnowledgeSourceError(`PDFは${maxPages}ページ以内で分割してください。`);
    const parts: string[] = [], warnings = new Set<string>();
    for (let number = 1; number <= count; number++) {
      active.throwIfAborted();
      const result = await page.evaluate(async ({ number, vision, textOnly }) => {
        const pdf = (window as unknown as { wentianPdf: import('pdfjs-dist').PDFDocumentProxy }).wentianPdf;
        const p = await pdf.getPage(number);
        try {
          const body = (await p.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
          if (textOnly || body.trim() && !vision) return { body, png: undefined };
          const viewport = p.getViewport({ scale: 1.5 });
          if (!Number.isFinite(viewport.width * viewport.height) || viewport.width <= 0 || viewport.height <= 0 || Math.ceil(viewport.width) * Math.ceil(viewport.height) > 16_000_000) throw new Error('PDFページ画像が大きすぎます。');
          const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          try {
            await p.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
            const png = canvas.toDataURL('image/png').split(',')[1];
            if (png.length > Math.ceil(10 * 1024 * 1024 * 4 / 3)) throw new Error('PDFページ画像が大きすぎます。');
            return { body, png };
          } finally { canvas.width = canvas.height = 0; }
        } finally { p.cleanup(); }
      }, { number, vision: Boolean(process.env.WENTIAN_KNOWLEDGE_VISION_MODEL), textOnly: Boolean(options.textOnly) });
      if (options.textOnly) {
        parts.push(result.body);
        if (options.maxTextBytes && Buffer.byteLength(parts.join('\n'), 'utf8') > options.maxTextBytes) throw new KnowledgeSourceError('抽出した本文が長すぎます。ファイルを分割してください。');
        continue;
      }
      parts.push(`ページ ${number}\n${result.body}`);
      if (result.png) {
        parts.push(await image(Buffer.from(result.png, 'base64'), 'image/png', active));
        active.throwIfAborted();
      } else warnings.add('PDFの画像・図表の解釈は未確認です。読取りモデルを設定してください。');
    }
    return { content: parts.join('\n\n'), warnings: [...warnings] };
  } finally {
    active.removeEventListener('abort', stop);
    await browser.close();
  }
}
