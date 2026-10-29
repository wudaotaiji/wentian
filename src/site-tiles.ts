import sanitizeHtml from 'sanitize-html';
import type { PublicSite } from './public-site.js';

export interface SiteTile { x: number; y: number; width: number; height: number; html: string; css: string }
export function tileIds(site: PublicSite): string[] { return ['header', 'hero', ...(site.showRooms === false ? [] : ['rooms']), ...site.sections.map((_, i) => 'section-' + i), 'custom', 'footer']; }
/** タイルのコードと座標を検証します。CSSは選択したルート要素の宣言だけに限定します。 */
export function validateTile(value: unknown): SiteTile {
  const tile = value as SiteTile;
  if (!tile || ![tile.x, tile.y, tile.width, tile.height].every(Number.isFinite) || tile.x < 0 || tile.y < 0 || tile.x > 1200 || tile.y > 12000 || tile.width < 120 || tile.width > 1200 || tile.height < 60 || tile.height > 5000 || tile.x + tile.width > 1200) throw new Error('タイルの位置・大きさが不正です。幅120〜1200、高さ60〜5000で指定してください。');
  if (typeof tile.html !== 'string' || tile.html.length > 20000 || typeof tile.css !== 'string' || tile.css.length > 4000 || /[{}<>@]|expression\s*\(|url\s*\(/i.test(tile.css)) throw new Error('タイルのHTMLとCSSを確認してください。CSSは波括弧を含まないプロパティ宣言を指定してください。');
  const html = sanitizeHtml(tile.html, { allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'], allowedAttributes: { '*': ['class', 'style'], a: ['href', 'title', 'target', 'rel', 'style'], img: ['src', 'alt', 'width', 'height', 'style'] }, allowedSchemes: ['http', 'https', 'mailto'], allowProtocolRelative: false, allowedStyles: { '*': { color: [/^[\w#(),.%\s-]+$/], 'background-color': [/^[\w#(),.%\s-]+$/], 'font-size': [/^[\d.]+(?:px|rem|em|%)$/], 'font-weight': [/^[\w\d]+$/], 'text-align': [/^(left|right|center)$/], padding: [/^[\d.\s]+(?:px|rem|em|%)$/], margin: [/^[\d.\s]+(?:px|rem|em|%)$/], 'border-radius': [/^[\d.]+(?:px|rem|em|%)$/] } } });
  return { x: tile.x, y: tile.y, width: tile.width, height: tile.height, html, css: tile.css };
}
/** 既存のページ設定にも既定座標を補い、各部分を選択可能なタイルとして表示します。 */
export function effectiveTiles(site: PublicSite): Record<string, SiteTile> {
  const make = (x: number, y: number, width: number, height: number): SiteTile => ({ x, y, width, height, html: '', css: '' });
  // 会話の吹き出しを読める高さを確保し、後続タイルとの重なりを防ぎます。
  const roomHeight = 850;
  const contentY = site.groupsPosition === 'before' ? 400 + roomHeight + 20 : 400;
  const rows = Math.ceil(site.sections.length / 3);
  const result: Record<string, SiteTile> = { header: make(0, 0, 1200, 90), hero: make(0, 108, 1200, 270), rooms: make(0, site.groupsPosition === 'before' ? 400 : contentY + rows * 240, 1200, roomHeight) };
  site.sections.forEach((_, i) => { result['section-' + i] = make(i % 3 * 406, contentY + Math.floor(i / 3) * 240, 388, 220); });
  const end = Math.max(720, contentY + rows * 240 + (site.groupsPosition === 'after' ? roomHeight + 20 : 0));
  result.custom = make(0, end, 1200, site.customHtml ? 200 : 60);
  result.footer = make(0, end + result.custom.height + 20, 1200, 80);
  for (const id of tileIds(site)) if (site.tiles?.[id]) result[id] = site.tiles[id];
  return result;
}

export function layoutTileHome(legacy: string, site: PublicSite, rooms: string, edit = false): string {
  const geometry = effectiveTiles(site);
  const fragments: Record<string, string> = {
    header: legacy.match(/<header class="public-header">([\s\S]*?)<\/header>/)![1],
    hero: legacy.match(/<section class="public-hero">([\s\S]*?)<\/section>/)![1],
    rooms,
    custom: site.customHtml || '<p class="muted">Human × AI · 一緒に創る</p>',
    footer: legacy.match(/<footer class="public-footer">([\s\S]*?)<\/footer>/)![1],
  };
  site.sections.forEach((section, i) => {
    const esc = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    fragments['section-' + i] = `<h3>${esc(section.title)}</h3><p>${esc(section.text)}</p>${section.href ? `<a href="${esc(section.href)}">${esc(section.linkLabel || '詳しく見る')} ↗</a>` : ''}`;
  });
  const tiles = tileIds(site).map(id => {
    const tile = geometry[id];
    const content = tile.html ? tile.html + (id === 'rooms' ? rooms : '') : fragments[id];
    return `<section id="tile-${id}" data-site-tile="${id}" data-x="${tile.x}" data-y="${tile.y}" data-width="${tile.width}" data-height="${tile.height}" class="site-tile tile-${id} ${id === 'hero' ? 'public-hero' : ''}" style="left:${tile.x / 12}%;top:${tile.y}px;width:${tile.width / 12}%;height:${tile.height}px;${tile.css.replace(/"/g, '&quot;')}">${content}</section>`;
  }).join('');
  const height = Math.max(...tileIds(site).map(id => geometry[id].y + geometry[id].height)) + 24;
  const css = `<style>.tile-board{position:relative;width:min(1200px,calc(100% - 40px));height:${height}px;margin:24px auto}.site-tile{position:absolute;padding:24px;overflow:auto;border:1px solid var(--line);border-radius:20px;background:var(--panel);box-shadow:0 8px 28px #00000008;min-width:0;max-width:none;margin:0}.tile-header{display:flex;align-items:center;justify-content:space-between;gap:16px}.tile-header nav{display:flex;gap:18px}.tile-header nav a{text-decoration:none}.site-tile.public-hero{padding:30px}.site-tile.public-hero h1{font-size:clamp(24px,4vw,46px);margin:8px 0}.site-tile.public-hero p{font-size:16px;margin:10px 0}.site-tile .hero-actions{margin-top:14px}.site-tile .room-section{padding:0;border:0}.site-tile .room-card{padding:16px}.site-tile .section-heading{margin-bottom:12px}.site-tile h3{margin:0 0 12px}.site-tile p{white-space:pre-wrap}.tile-footer{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--muted)}body:not(.tile-editor-preview) .site-tile a:focus-visible{outline:2px solid var(--accent)}@media(max-width:650px){body:not(.tile-editor-preview) .tile-board{height:auto}body:not(.tile-editor-preview) .site-tile{position:relative!important;left:auto!important;top:auto!important;width:100%!important;height:auto!important;min-height:80px;margin-bottom:16px}body:not(.tile-editor-preview) .tile-header{flex-wrap:wrap}}</style>`;
  return legacy.replace('</head>', () => css + '</head>').replace(/<body class="([^"]*)">[\s\S]*?<script>/, (_match, classes: string) => `<body class="${classes}${edit ? ' tile-editor-preview' : ''}"><main class="tile-board">${tiles}</main><script>`);
}
