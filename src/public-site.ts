import { loadForgeScene, type ForgeScene } from './forge-scene.js';
import { publicForgeStyle, publicForgeScript } from './forge-scene-ui.js';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { mkdir, open, readFile, readdir, unlink, writeFile, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';
import { renameWithRetry } from './atomic-file.js';
import { AgentGroupStore } from './agent-group.js';
import { PublicGuestSessions, publicGuestProfile, type PublicGuestPost } from './public-guest.js';
import { themeCss } from './appearance-ui.js';
import { withMailAppearance } from './mail-appearance-ui.js';
import { SiteFiles, trashSite, listTrashedSites, purgeTrashedSite } from './site-files.js';
import { siteTemplates, templateSite } from './site-templates.js';
import { layoutTileHome, effectiveTiles, tileIds, validateTile, type SiteTile } from './site-tiles.js';
import { withMailTraining } from './mail-training-ui.js';
import { withMailOperations } from './mail-operations-ui.js';

export interface SiteSection { title: string; text: string; linkLabel: string; href: string }
export interface PublicSite {
  /** 管理者限定のメール画面の原本です。通常の公開ページでは配信しません。 */
  mailDocument?: string;
  commerceSiteId?: string;
  language?: string;
  revision: number; title: string; eyebrow: string; headline: string; introduction: string;
  theme: 'dark' | 'light' | 'glass' | 'bento' | 'soft' | 'brutalist' | 'minimal';
  accent: string; layout: 'wide' | 'compact' | 'centered'; groupsPosition: 'before' | 'after';
  sections: SiteSection[]; customHtml: string; customCss: string;
  tiles?: Record<string, SiteTile>;
  showRooms?: boolean;
}
export interface PublicRoom { scene?: ForgeScene; id: string; title: string; summary: string; showComposer?: boolean; participationAuth?: 'guest' | 'login'; messages?: Array<{ speaker: string; content: string; at: string }> }
function publicScene(scene: ForgeScene, id: string, page: string): ForgeScene {
  const url = (source: string) => source.startsWith('data:') ? source : '/api/site/rooms/' + encodeURIComponent(id) + '/forge-assets/' + (source.startsWith('/assets/') ? source.split('/').at(-1) : source.split('/')[3] + '.png') + '?page=' + encodeURIComponent(page);
  return { ...scene, background: url(scene.background), actors: scene.actors.map(a => ({ ...a, image: url(a.image) })) };
}
export const defaultPublicSite: PublicSite = {
  revision: 0, title: 'Wentian', eyebrow: 'HUMAN × AI WORKSPACE', headline: 'アイデアを、確かな成果へ。',
  introduction: '人間とAIが協力して、相談から実行まで。公開中の相談室を見つけて、次の一歩を始めましょう。',
  theme: 'light', accent: '#2359bb', layout: 'wide', groupsPosition: 'before',
  sections: [
    { title: '一緒に考える', text: 'さまざまな視点を集めて、アイデアを具体的な計画へ。', linkLabel: '', href: '' },
    { title: '形にする', text: '相談で決めた方針をタスクにして、検証できる成果をつくります。', linkLabel: '', href: '' },
    { title: '確かめる', text: '成果と根拠を確認して、次の改善につなげます。', linkLabel: '', href: '' },
  ], customHtml: '', customCss: '',
};
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** ワークベンチ（Workbench）と同じ配色とアバターで、公開会話の吹き出しを描画します。 */
function publicMessageHtml(message: { speaker: string; content: string; at: string }): string {
  const colors = ['#5f8cff','#ca75dc','#de9854','#4db598','#df7791','#7b93d9','#a3a251','#45a7bd'];
  const hash = Array.from(message.speaker).reduce((h, ch) => (Math.imul(h,31)+ch.codePointAt(0)!)>>>0,7);
  const tint = colors[hash % colors.length], eye = 18 + hash % 6;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${tint}"/><path d="M10 96Q15 63 48 63Q81 63 86 96" fill="#ffffff" opacity=".28"/><rect x="23" y="19" width="50" height="45" rx="${eye}" fill="#fff" opacity=".92"/><circle cx="37" cy="39" r="4" fill="#283548"/><circle cx="59" cy="39" r="4" fill="#283548"/><path d="M39 51Q48 58 57 51" fill="none" stroke="#283548" stroke-width="3" stroke-linecap="round"/><text x="48" y="84" text-anchor="middle" font-family="sans-serif" font-size="16" font-weight="bold" fill="#fff">${esc(Array.from(message.speaker).slice(0,2).join(''))}</text></svg>`;
  return `<div class="group-message" style="--speaker-color:${tint}"><img class="member-avatar" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" alt="${esc(message.speaker)}の画像" loading="lazy"><div class="bubble-wrap"><div class="bubble-meta"><strong>${esc(message.speaker)}</strong><time datetime="${esc(message.at)}">${esc(new Date(message.at).toLocaleString('ja', { month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit' }))}</time></div><div class="group-bubble">${esc(message.content)}</div></div></div>`;
}
function bounded(value: unknown, limit: number, name: string): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error(`${name}は${limit}文字以内で指定してください。`);
  return value;
}
/** 手動編集とAI案へ同じ検証を適用し、スクリプト（Script）を公開HTMLへ埋め込みません。 */
export function validatePublicSite(input: unknown): PublicSite {
  if (!input || typeof input !== 'object') throw new Error('ページ設定を指定してください。');
  const site = input as PublicSite;
  if(site.commerceSiteId!==undefined&&!/^[a-f0-9-]{36}$/.test(site.commerceSiteId))throw new Error('商取引サイトIDが不正です。');
  if (site.language !== undefined && !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(site.language)) throw new Error('言語タグ（Language Tag）が不正です。');
  if (!['dark', 'light', 'glass', 'bento', 'soft', 'brutalist', 'minimal'].includes(site.theme) || !['wide', 'compact', 'centered'].includes(site.layout) || !['before', 'after'].includes(site.groupsPosition)) throw new Error('スタイルとレイアウトを選んでください。');
  if (!/^#[0-9a-f]{6}$/i.test(site.accent)) throw new Error('アクセント色は6桁のカラーコードで指定してください。');
  if (!Array.isArray(site.sections) || site.sections.length > 20) throw new Error('コンテンツは20件以内で指定してください。');
  const sections = site.sections.map(section => {
    const href = bounded(section.href, 1000, 'リンク先').trim();
    if (href && !/^https?:\/\//i.test(href) && !/^\/(?!\/)/.test(href) && !/^#[\w-]+$/.test(href)) throw new Error('リンクはhttp(s)、同じサイトのパス、またはページ内リンクを使ってください。');
    return { title: bounded(section.title, 150, '見出し'), text: bounded(section.text, 3000, '本文'), linkLabel: bounded(section.linkLabel, 100, 'リンク名'), href };
  });
  const customHtml = sanitizeHtml(bounded(site.customHtml, 40000, '追加HTML'), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
    allowedAttributes: { '*': ['class', 'id', 'lang'], a: ['href', 'title', 'target', 'rel', 'hreflang'], img: ['src', 'alt', 'width', 'height', 'loading'] },
    allowedSchemes: ['http', 'https', 'mailto'], allowProtocolRelative: false,
  });
  const tiles: Record<string, SiteTile> = {};
  if (site.tiles !== undefined) {
    if (!site.tiles || typeof site.tiles !== 'object' || Array.isArray(site.tiles) || Object.keys(site.tiles).length > 25) throw new Error('タイル設定が不正です。');
    for (const [id, value] of Object.entries(site.tiles)) if (tileIds(site).includes(id)) tiles[id] = validateTile(value);
  }
  return {
    ...(site.mailDocument !== undefined ? {mailDocument: bounded(site.mailDocument, 500000, 'メール画面のHTML全文')} : {}),
    ...(site.commerceSiteId?{commerceSiteId:site.commerceSiteId}:{}),
    language: site.language || 'ja',
    revision: Number.isInteger(site.revision) && site.revision >= 0 ? site.revision : 0,
    title: bounded(site.title, 100, 'サイト名'), eyebrow: bounded(site.eyebrow, 150, '紹介ラベル'), headline: bounded(site.headline, 300, 'キャッチコピー'), introduction: bounded(site.introduction, 3000, '紹介文'),
    theme: site.theme, accent: site.accent, layout: site.layout, groupsPosition: site.groupsPosition, sections, customHtml, customCss: bounded(site.customCss, 20000, '追加CSS'),
    tiles,
    showRooms: site.showRooms !== false,
  };
}

export class PublicSiteStore {
  constructor(readonly workspace: string, readonly page = '') {
    if (page && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(page)) throw new Error('ページURLは英小文字・数字・ハイフンで指定してください。');
  }
  private file() { return path.join(path.resolve(this.workspace), '.wentian', this.page ? `site-pages/${this.page}.json` : 'public-site.json'); }
  /** ページ一覧（Page List）は実際の保存ファイルから取得します。 */
  async pages(): Promise<Array<{ slug: string; title: string; href: string }>> {
    const home = await new PublicSiteStore(this.workspace).load();
    let closed=false;try{await lstat(path.join(path.resolve(this.workspace),'.wentian','home-closed.json'));closed=true}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
    const result = closed ? [] : [{ slug: '', title: home.title, href: '/' }];
    let files: string[];
    try { files = await readdir(path.join(path.resolve(this.workspace), '.wentian', 'site-pages')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
    for (const file of files.sort()) {
      if (!/^[a-z0-9][a-z0-9-]{0,59}\.json$/.test(file)) continue;
      const slug = file.slice(0, -5), site = await new PublicSiteStore(this.workspace, slug).load();
      result.push({ slug, title: site.title, href: '/pages/' + slug });
    }
    return result;
  }
  async load(): Promise<PublicSite> {
    try { return validatePublicSite(JSON.parse(await readFile(this.file(), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaultPublicSite); throw error; }
  }
  async save(input: unknown): Promise<PublicSite> {
    const site = validatePublicSite(input);
    if (site.mailDocument !== undefined && this.page !== 'mail-solutions') throw new Error('メール画面の原本は専用サイトにだけ保存できます。');
    await mkdir(path.dirname(this.file()), { recursive: true });
    // 世代番号とファイルロック（File Lock）で、別タブの変更や遅いAI案の上書きを防ぎます。
    let lock;
    for (let attempt = 0; ; attempt++) {
      try { lock = await open(this.file() + '.lock', 'wx'); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    try {
      const current = await this.load();
      if (site.revision !== current.revision) throw Object.assign(new Error('別の操作でページが更新されました。再読込してから保存してください。'), { statusCode: 409 });
      site.revision++; const temp = this.file() + '.' + randomUUID() + '.tmp';
      try { await writeFile(temp, JSON.stringify(site, null, 2), { mode: 0o600 }); await renameWithRetry(temp, this.file()); }
      finally { await unlink(temp).catch(() => undefined); }
      return site;
    } finally { await lock.close(); await unlink(this.file() + '.lock'); }
  }
  async rooms(): Promise<PublicRoom[]> {
    // 公開された相談室の本文だけを表示用に抽出し、ユーザーID・メール・IP・モデル設定を含めません。
    const groups = await new AgentGroupStore(this.workspace).list();
    return (await Promise.all(groups.map(async group => {
      const publication = group.publication?.pages?.[this.page || '/'] ?? group.publication;
      if (!publication?.published) return [];
      const scene = await loadForgeScene(this.workspace, group.id);
      return [{ id: group.id, title: group.title, summary: publication.summary, ...(publication.showComposer && publication.participationAuth === 'login' ? { participationAuth: 'login' as const } : {}), ...(scene ? { scene: publicScene(scene, group.id, this.page) } : {}), messages: group.messages.map(message => ({ speaker: message.speaker, content: message.content, at: message.at })), ...(publication.showComposer ? { showComposer: true } : {}) }];
    }))).flat();
  }
}

/** 会話と発言フォーム（Form）を一組として上下配置します。 */
function publicRoomHtml(room: PublicRoom): string {
  return `<article class="room-card panel public-room-set" data-room="${esc(room.id)}"><h3>${esc(room.title)}</h3><p>${esc(room.summary)}</p><div class="public-thread" role="log">${(room.messages || []).map(publicMessageHtml).join('') || '<p>まだ発言はありません。</p>'}</div>${room.showComposer ? `<form class="group-composer" data-room="${esc(room.id)}"><h3>あなたの発言</h3>${room.participationAuth === 'login' ? '<label>ユーザー名<input name="username" autocomplete="username" required></label><label>パスワード<input name="password" type="password" autocomplete="current-password" required></label>' : ''}<label>名前とメールアドレス<input name="nickname" required maxlength="300" placeholder="吉田&lt;member@example.com&gt;"></label><label>メッセージ<textarea name="content" required maxlength="10000" placeholder="メッセージを入力…"></textarea></label><p>名前は公開されます。メールアドレスは公開しません。${room.participationAuth === 'login' ? '参加には登録済みアカウントでのログインが必要です。' : '登録・ログイン不要で参加できます。'}</p><button type="submit">送信</button><p class="composer-status" role="status"></p></form>` : ''}</article>`;
}
// 公開参加が許可された群へ、訪問者情報とゲストセッションで投稿します。
const publicComposerScript = `
async function publicRequest(url,body){url+='?page='+encodeURIComponent(location.pathname.startsWith('/sites/')?location.pathname.split('/')[2].toLowerCase():location.pathname.startsWith('/pages/')?location.pathname.slice(7):'');const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const data=await response.json();if(!response.ok){const error=new Error(data.error?.message||'操作に失敗しました。');error.status=response.status;throw error}return data}
document.addEventListener('submit',async event=>{const form=event.target;if(!form.matches('.group-composer'))return;event.preventDefault();const button=form.querySelector('button[type=submit]'),status=form.querySelector('.composer-status');button.disabled=true;try{if(form.elements.username){await publicRequest('/api/site/login',{username:form.elements.username.value,password:form.elements.password.value});}await publicRequest('/api/site/rooms/'+encodeURIComponent(form.dataset.room)+'/join',{presence:'online',nickname:form.elements.nickname.value});await publicRequest('/api/site/rooms/'+encodeURIComponent(form.dataset.room)+'/messages',{nickname:form.elements.nickname.value,content:form.elements.content.value});form.elements.content.value='';status.textContent='発言を保存しました。'}catch(error){status.textContent=error.message;}finally{button.disabled=false}});
`;
export function renderPublicHome(site: PublicSite, rooms: PublicRoom[], gatewayOrigin: string, edit = false): string {
  const roomCards = rooms.map(publicRoomHtml).join('');
  const groupSection = `<section id="rooms" class="room-section"><div class="section-heading"><div><span class="eyebrow">MEET & CREATE</span><h2>公開中の相談室</h2></div><p id="roomCount">${rooms.length} rooms</p></div><div id="publicRooms" class="room-grid">${roomCards || '<div class="empty-room">相談室の公開を準備しています。</div>'}</div></section>`;
  const content = `<section class="content-section"><div class="content-grid">${site.sections.map(section => `<article class="content-card panel"><h3>${esc(section.title)}</h3><p>${esc(section.text)}</p>${section.href ? `<a href="${esc(section.href)}">${esc(section.linkLabel || '詳しく見る')} ↗</a>` : ''}</article>`).join('')}</div></section><section class="custom-section">${site.customHtml}</section>`;
  // CSS（スタイルシート / Cascading Style Sheets）内の閉じタグをエスケープしてHTML境界を維持します。
  const css = site.customCss.replace(/</g, '\\3c ');
  const legacy = `<!doctype html><html lang="ja" data-theme="${site.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(site.title)}</title>
${themeCss}${publicForgeStyle}<style>
.room-grid{display:flex!important;flex-direction:column}.public-room-set{width:100%}.group-composer{margin-top:16px;padding:20px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.group-composer label{display:block}.group-composer input,.group-composer textarea{display:block;width:100%;font:inherit;margin:5px 0 12px;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}.group-composer textarea{min-height:90px}.group-composer button{cursor:pointer;padding:9px 16px;border-radius:8px;border:0;background:var(--accent);color:var(--panel)}.group-composer button:disabled{cursor:wait}[hidden]{display:none!important}.public-thread{height:clamp(300px,50vh,650px);overflow:auto;padding:20px;background:var(--bg);border-radius:12px}.public-thread .group-message{display:flex;align-items:flex-start;gap:10px;margin-bottom:18px}.public-thread .member-avatar{width:40px;height:40px;object-fit:cover;border-radius:50%;flex-shrink:0}.public-thread .bubble-wrap{max-width:85%;min-width:0}.public-thread .bubble-meta{font-size:11px;color:var(--muted);margin-bottom:5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}.public-thread .group-bubble{border-radius:4px 16px 16px 16px;padding:12px 15px;background:color-mix(in srgb,var(--speaker-color) 12%,var(--panel));border:1px solid color-mix(in srgb,var(--speaker-color) 40%,var(--line));border-left:3px solid var(--speaker-color);color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75}.public-message{padding:12px;border-bottom:1px solid var(--line)}.public-message p{white-space:pre-wrap;overflow-wrap:anywhere}.public-message time{display:block;font-size:11px;color:var(--muted)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.8 system-ui,sans-serif}a{color:var(--accent)}.public-header,.public-main,.public-footer{width:min(1180px,calc(100% - 64px));margin:auto}.public-header{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:26px 0;border-bottom:1px solid var(--line)}.public-brand{text-decoration:none;color:var(--text);font-size:25px;font-weight:760;letter-spacing:-1px}.public-header nav{display:flex;gap:24px;align-items:center}.public-header nav a{text-decoration:none;font-size:13px}.public-hero{padding:92px 0 72px;max-width:870px}.eyebrow,.room-label{font-size:11px;font-weight:700;letter-spacing:2px;color:var(--accent)}.public-hero h1{font-size:clamp(36px,5.5vw,68px);line-height:1.22;letter-spacing:-2px;white-space:pre-wrap;margin:20px 0 26px}.public-hero p{font-size:18px;color:var(--muted);max-width:720px;white-space:pre-wrap}.hero-actions{margin-top:32px;display:flex;gap:12px;flex-wrap:wrap}.hero-primary{background:var(--accent);color:var(--bg);padding:12px 22px;border-radius:9px;text-decoration:none;font-weight:650}.hero-secondary{padding:12px 20px;border:1px solid var(--line);border-radius:9px;text-decoration:none;color:var(--text)}.room-section{padding:36px 0 52px;border-top:1px solid var(--line)}.section-heading{display:flex;align-items:end;justify-content:space-between;margin-bottom:25px;gap:20px}.section-heading h2{font-size:27px;letter-spacing:-.7px;margin:7px 0 0}.section-heading p{font-size:12px;color:var(--muted)}.room-grid,.content-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}.room-card,.content-card{border:1px solid var(--line);padding:28px;min-width:0}.room-card h3,.content-card h3{font-size:21px;margin:14px 0 12px;overflow-wrap:anywhere}.room-card p,.content-card p{color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere}.room-action{display:flex;justify-content:space-between;text-decoration:none;font-size:14px;border-top:1px solid var(--line);padding-top:18px;margin-top:26px}.empty-room{padding:32px;border:1px dashed var(--line);border-radius:14px;color:var(--muted);grid-column:1/-1}.content-section{padding:28px 0 46px}.content-card{padding:24px}.content-card h3{font-size:18px}.custom-section{overflow-wrap:anywhere}.custom-section img{max-width:100%;height:auto}.public-footer{border-top:1px solid var(--line);padding:25px 0;margin-top:34px;font-size:12px;color:var(--muted);display:flex;justify-content:space-between}.layout-compact .public-main,.layout-compact .public-header,.layout-compact .public-footer{max-width:880px}.layout-centered .public-hero{text-align:center;margin:auto}.layout-centered .public-hero p{margin:0 auto}.layout-centered .hero-actions{justify-content:center}a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}@media(max-width:650px){.public-header,.public-main,.public-footer{width:calc(100% - 32px)}.public-header{flex-wrap:wrap;padding:18px 0}.public-header nav{gap:15px}.public-hero{padding:55px 0 40px}.public-hero p{font-size:16px}.room-grid,.content-grid{grid-template-columns:1fr}.public-footer{gap:12px;flex-wrap:wrap}}
html[data-theme]{--accent:${site.accent}}
</style><style>${css}</style></head><body class="layout-${site.layout}"><header class="public-header"><a class="public-brand" href="/">${esc(site.title)}</a><nav><a href="#rooms">相談室</a><a href="${esc(gatewayOrigin)}/#site">管理画面 ↗</a></nav></header><main class="public-main"><section class="public-hero"><span class="eyebrow">${esc(site.eyebrow)}</span><h1>${esc(site.headline)}</h1><p>${esc(site.introduction)}</p><div class="hero-actions"><a class="hero-primary" href="#rooms">相談室を見つける ↘</a><a class="hero-secondary" href="${esc(gatewayOrigin)}/workbench#groups">会話を始める ↗</a></div></section>${site.groupsPosition === 'before' ? groupSection + content : content + groupSection}</main><footer class="public-footer"><span>${esc(site.title)} · Human × AI</span><span>相談から、次の一歩へ。</span></footer>
<script>
${publicComposerScript}
${publicForgeScript}
const initialForgeRooms=${JSON.stringify(rooms.filter(r=>r.scene).map(r=>({id:r.id,scene:r.scene,messages:r.messages?.slice(-1)}))).replace(/</g, String.fromCharCode(92)+'u003c')};for(const room of initialForgeRooms){const card=Array.from(document.querySelectorAll('[data-room]')).find(el=>el.dataset.room===room.id);if(card)mountPublicForge(card,room.scene,room.messages)}
(()=>{'use strict';let revision=${site.revision};const origin=${JSON.stringify(gatewayOrigin).replace(/</g, '\\u003c')};const esc=${esc.toString()};const publicMessageHtml=${publicMessageHtml.toString()};let roomIds=${JSON.stringify(rooms.map(room => room.id+':'+!!room.showComposer+':'+room.participationAuth).join('|'))};let busy=false;setInterval(async()=>{if(busy||document.hidden)return;busy=true;try{const response=await fetch('/api/site?page='+encodeURIComponent(location.pathname.startsWith('/sites/')?location.pathname.split('/')[2].toLowerCase():location.pathname.startsWith('/pages/')?location.pathname.slice(7):''),{cache:'no-store'});if(!response.ok)return;const data=await response.json();if(data.site.revision!==revision){location.reload();return}const root=document.getElementById('publicRooms');const ids=data.rooms.map(room=>room.id+':'+!!room.showComposer+':'+room.participationAuth).join('|');if(ids!==roomIds){location.reload();return}for(const room of data.rooms){const card=Array.from(root.querySelectorAll('[data-room]')).find(el=>el.dataset.room===room.id);if(card){mountPublicForge(card,room.scene,room.messages);const thread=card.querySelector('.public-thread');const old=thread.scrollTop;thread.innerHTML=(room.messages||[]).map(publicMessageHtml).join('');thread.scrollTop=old}}}catch{}finally{busy=false}},5000)})();
</script></body></html>`;
  return layoutTileHome(legacy.replace('<html lang="ja"', `<html lang="${esc(site.language || 'ja')}"`), site, groupSection, edit);
}

export function buildPublicWebsite(workspace: string, gatewayOrigin: string, proxy?: (req: FastifyRequest, reply: FastifyReply, url: string) => Promise<unknown>, guestPost?: PublicGuestPost): FastifyInstance {
  const app = Fastify(), store = new PublicSiteStore(workspace);
  const guests = new PublicGuestSessions(workspace);
  app.get('/api/site/rooms/:id/forge-assets/:asset', async (req, reply) => {
    const { id, asset } = req.params as { id: string; asset: string }, page = (req.query as { page?: string }).page || '';
    // 舞台素材もページ別の公開状態を毎回確認し、閉鎖後は新規取得できなくします。
    const selected = new PublicSiteStore(workspace, page);
    if (!(await store.pages()).some(p => p.slug === page) || (await selected.load()).mailDocument !== undefined || !(await selected.rooms()).some(r => r.id === id)) return reply.code(404).send({ error: { message: '公開されていません。' } });
    const scene = await loadForgeScene(workspace, id);
    const sources = scene ? [scene.background, ...scene.actors.map(a => a.image)] : [];
    const source = sources.find(s => !s.startsWith('data:') && (s.startsWith('/assets/') ? s.split('/').at(-1) : s.split('/')[3] + '.png') === asset);
    if (!source) return reply.code(404).send({ error: { message: '素材は公開されていません。' } });
    const target = source.startsWith('/assets/') ? path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), 'assets', 'startup-forge', asset) : path.join(workspace, '.wentian', 'visual-assets', asset);
    try { return reply.type('image/png').send(await readFile(target)); }
    catch { return reply.code(404).send({ error: { message: '素材がありません。' } }); }
  });
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  });
  // 全ページにページ一覧（Navigation）を付け、公開URLから編集内容を表示します。
  const renderPage = async (slug: string) => {
    const pages = await store.pages();
    if (!pages.some(page => page.slug === slug)) return undefined;
    const pageStore = new PublicSiteStore(workspace, slug);
    const site = await pageStore.load();
    if (site.mailDocument !== undefined) return undefined;
    const html = renderPublicHome(site, await pageStore.rooms(), gatewayOrigin);
    const links = pages.map(page => `<a href="${page.href}" style="margin-right:20px">${sanitizeHtml(page.title, { allowedTags: [], allowedAttributes: {} })}</a>`).join('');
    return html.replace(/(<section\b[^>]*id="tile-header"[^>]*>)([\s\S]*?)(<\/section>)/, (_match, opening: string, content: string, closing: string) => opening + `<nav aria-label="サイトのページ">${links}</nav>` + content.replace(/<a\b[^>]*class="public-brand"[^>]*>[\s\S]*?<\/a>/, '') + closing);
  };
  app.get('/', async (_req, reply) => {const html=await renderPage('');return html===undefined?reply.code(404).send({error:{message:'サイトは閉鎖されています。'}}):reply.type('text/html; charset=utf-8').send(html)});
  app.get('/pages/:slug', async (req, reply) => {
    const html = await renderPage((req.params as { slug: string }).slug);
    return html === undefined ? reply.code(404).send({ error: { message: 'ページが存在しません。' } }) : reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/api/site', async (req, reply) => {
    const pageStore = new PublicSiteStore(workspace, (req.query as { page?: string }).page || '');
    const site = await pageStore.load();
    if (site.mailDocument !== undefined) return reply.code(404).send({error:{message:'管理者用サイトです。'}});
    return { site, rooms: await pageStore.rooms(), pages: await store.pages() };
  });
  // 公開入力は既存の認証・参加・投稿処理へ限定し、管理操作を転送しません。
  app.post('/api/site/login', async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
    if (!proxy) return reply.code(503).send({ error: { message: 'ログイン接続が未設定です。' } });
    return proxy(req, reply, '/api/control-center/login');
  });
  app.post('/api/site/rooms/:id/:action', async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
    const { id, action } = req.params as { id: string; action: string };
    if (!['join', 'messages'].includes(action)) return reply.code(404).send({ error: { message: '操作が存在しません。' } });
    const room = (await new PublicSiteStore(workspace, (req.query as { page?: string }).page || '').rooms()).find(room => room.id === id);
    if (!room?.showComposer) return reply.code(403).send({ error: { message: 'この相談室は発言欄を公開していません。' } });
    if (req.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
    if (guestPost && room.participationAuth !== 'login') {
      try {
        const body = req.body as { nickname?: string; content?: string };
        const profile = publicGuestProfile(body?.nickname), page = (req.query as { page?: string }).page || '';
        if (action === 'messages' && (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 10000)) return reply.code(400).send({ error: { message: '1〜10000文字の発言を入力してください。' } });
        const actor = await guests.actor(req, reply, id, page, profile.name, action === 'join');
        if (!actor) return reply.code(401).send({ error: { message: '名前とメールアドレスを入力して、もう一度送信してください。' } });
        if (action === 'messages') {
          if (!guests.accept(req.ip, id)) return reply.code(429).send({ error: { message: '投稿が続いています。少し待ってから送信してください。' } });
          await guestPost(id, actor, body.content!, { nickname: profile.nickname, ipAddress: req.ip });
        }
        return { ok: true, guest: true };
      } catch (error) { return reply.code((error as { statusCode?: number }).statusCode === 403 ? 403 : 400).send({ error: { message: error instanceof Error ? error.message : '投稿を保存できませんでした。' } }); }
    }
    if (!proxy) return reply.code(503).send({ error: { message: '投稿接続が未設定です。' } });
    await proxy(req, reply, `/api/workbench/groups/${encodeURIComponent(id)}/${action}`);
  });
  app.get('/health', async () => ({ ok: true, service: 'wentian-public-site' }));
  return app;
}

export function registerSiteAdmin(app: FastifyInstance, options: {
  workspace: string; authorize: (req: FastifyRequest, reply: FastifyReply) => boolean; gatewayOrigin: () => string;
  guestPost?: PublicGuestPost;
  design: (model: string, messages: Array<{ role: string; content: string }>) => Promise<string>;
}): void {
  const store = new PublicSiteStore(options.workspace);
  // 公開用API（Application Programming Interface）も同じオリジンで提供します。
  const website = buildPublicWebsite(options.workspace, options.gatewayOrigin(), async (req, reply, url) => {
    const response = await app.inject({method:'POST',url,headers:{...(req.headers.cookie?{cookie:req.headers.cookie}:{}),'content-type':'application/json'},payload:JSON.stringify(req.body)});
    if(response.headers['set-cookie']) reply.header('set-cookie',response.headers['set-cookie']);
    return reply.code(response.statusCode).type('application/json').send(response.rawPayload);
  }, options.guestPost);
  app.addHook('onClose',async()=>{await website.close();});
  const forward = async (req: FastifyRequest, reply: FastifyReply) => {
    const response = await website.inject({method:req.method as 'GET'|'POST',url:req.url,headers:req.headers,remoteAddress:req.ip,payload:req.method==='POST'?JSON.stringify(req.body):undefined});
    if(response.headers['set-cookie'])reply.header('set-cookie',response.headers['set-cookie']);
    // PNGなどの公開素材も通るため、文字列へ復号せず元のバイト列を返します。
    return reply.code(response.statusCode).header('cache-control','no-store').type(String(response.headers['content-type']||'application/json')).send(response.rawPayload);
  };
  app.get('/api/site',forward);
  app.route({method:['GET','POST'],url:'/api/site/*',handler:forward});
  // 管理画面と同じオリジン（Origin）で公開ページを提供し、別ポートへの依存を避けます。
  app.get('/sites/:slug/', async (req, reply) => {
    const slug = (req.params as {slug:string}).slug.toLowerCase();
    if (!(await store.pages()).some(item => item.slug === slug)) return reply.code(404).send({error:{message:'サイトが存在しません。'}});
    const selected = new PublicSiteStore(options.workspace, slug);
    const site = await selected.load();
    // 実行可能な原本は従来と同じ管理者認証を通してから配信します。
    if (site.mailDocument !== undefined && !options.authorize(req, reply)) return reply;
    return reply.header('cache-control','no-store').type('text/html; charset=utf-8').send(site.mailDocument !== undefined ? withMailAppearance(withMailTraining(withMailOperations(site.mailDocument)), site.theme) : renderPublicHome(site, await selected.rooms(), options.gatewayOrigin()));
  });
  app.get('/sites/:slug', async (req, reply) => reply.redirect('/sites/' + encodeURIComponent((req.params as {slug:string}).slug) + '/'));
  const externalFiles = new SiteFiles(options.workspace);
  // サイト別のソース（Source）を世代別フォルダーへ保存し、過去の成果物を上書きしません。
  const sourceRoot = (page: string) => path.join(path.resolve(options.workspace), '.wentian', 'sites', ...(page ? ['pages', page] : ['home']));
  async function exportSource(page: string, site: PublicSite) {
    // 固定保存先の途中にシンボリックリンク（Symbolic Link）がある場合は書き込みを拒否します。
    new PublicSiteStore(options.workspace, page);
    let parent = path.resolve(options.workspace);
    for (const segment of ['.wentian','sites',...(page ? ['pages',page] : ['home'])]) {
      parent = path.join(parent, segment);
      await mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('ソース保存先には通常のフォルダーを指定してください。');
    }
    const directory = path.join(parent, `revision-${site.revision}-${randomUUID()}`);
    await mkdir(directory);
    // 公開相談室の履歴と管理機能を含めず、サーバー不要の静的サイトとして生成します。
    const rendered = site.mailDocument ?? renderPublicHome(site, [], options.gatewayOrigin(), false).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const css = [...rendered.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
    const html = rendered.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace('</head>', '<link rel="stylesheet" href="styles.css"></head>');
    const files = ['index.html','styles.css','site.json','README.md'];
    await writeFile(path.join(directory, 'index.html'), html, 'utf8');
    await writeFile(path.join(directory, 'styles.css'), css, 'utf8');
    await writeFile(path.join(directory, 'site.json'), JSON.stringify(site, null, 2), 'utf8');
    await writeFile(path.join(directory, 'README.md'), '# Wentian サイトソース\n\nindex.html と styles.css を同じフォルダーに配置して開くか、静的ホスティングへ配置してください。site.json は編集元の設定です。\n\n公開相談室の履歴、ログイン、投稿、自動更新は含みません。バックエンドを必要とするアプリのコードは生成していません。\n', 'utf8');
    if (site.mailDocument !== undefined) await writeFile(path.join(directory,'README.md'),'# Wentian Mail Solutions ソース\n\nindex.html と styles.css は管理者が保存した画面原本です。JavaScriptと多言語表示を保持しています。実データの学習機能はWentian内で表示するときに追加され、認証済みのバックエンド（Backend）接続を必要とします。site.json は編集元の設定です。\n','utf8');
    return { directory, files, revision: site.revision };
  }
  app.register(async routes => {
    routes.addHook('preHandler', async (req, reply) => {
      if (!options.authorize(req, reply)) return reply;
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
    });
    routes.setErrorHandler((error, _req, reply) => reply.code((error as { statusCode?: number }).statusCode === 409 ? 409 : 400).send({ error: { message: error instanceof Error ? error.message : '操作に失敗しました。' } }));
    const selectedStore = (req: FastifyRequest) => new PublicSiteStore(options.workspace, (req.query as { page?: string }).page || '');
    async function saveWithSource(req: FastifyRequest, input: unknown) {
      const site = await selectedStore(req).save(input);
      if(!(req.query as {page?:string}).page)await unlink(path.join(path.resolve(options.workspace),'.wentian','home-closed.json')).catch(error=>{if(error.code!=='ENOENT')throw error});
      try { return {site, source: await exportSource((req.query as {page?:string}).page || '', site)}; }
      catch (error) { return {site, sourceError: 'ページは保存しましたが、ソース生成に失敗しました: ' + (error instanceof Error ? error.message : String(error))}; }
    }
    routes.get('/api/site-admin', async req => ({ site: await selectedStore(req).load(), rooms: await selectedStore(req).rooms(), pages: await store.pages(), sourceRoot: sourceRoot((req.query as {page?:string}).page || '') }));
    routes.post('/api/site-admin', async req => saveWithSource(req, req.body));
    routes.get('/api/site-admin/templates',async()=>({templates:siteTemplates}));
    routes.post('/api/site-admin/templates',async req=>{
      const body=req.body as {template?:string;slug?:string;title?:string};
      if(!body || !body.slug || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(body.slug) || typeof body.title!=='string' || !body.title.trim() || body.title.length>100)throw new Error('新しいサイトのURLと名前を入力してください。');
      if((await store.pages()).some(page=>page.slug===body.slug))throw new Error('このサイトURLは使用済みです。');
      const selected=new PublicSiteStore(options.workspace,body.slug);
      const site=await selected.save(templateSite(body.template,defaultPublicSite,body.title));
      return {site,slug:body.slug,source:await exportSource(body.slug,site)};
    });
    routes.get('/api/site-admin/trash',async()=>({items:await listTrashedSites(options.workspace)}));
    routes.post('/api/site-admin/trash/purge',async req=>{const body=req.body as {id?:unknown;confirmation?:unknown};return purgeTrashedSite(options.workspace,body?.id,body?.confirmation)});
    routes.post('/api/site-admin/delete',async req=>trashSite(options.workspace,(req.query as {page?:string}).page || ''));
    routes.post('/api/site-admin/files/connect',async req=>externalFiles.connect((req.body as {directory?:string})?.directory));
    routes.post('/api/site-admin/files/read',async req=>{const body=req.body as {id:string;name:string};return externalFiles.read(body.id,body.name)});
    routes.post('/api/site-admin/files/save',async req=>{const body=req.body as {id:string;name:string;content:string;version:string};return externalFiles.save(body.id,body.name,body.content,body.version)});
    // 書き出し（Export）は保存済みの版だけを対象にし、編集中の設定は変更しません。
    routes.post('/api/site-admin/export', async req => ({source: await exportSource((req.query as {page?:string}).page || '', await selectedStore(req).load())}));
    routes.post('/api/site-admin/preview', async (req, reply) => {
      const site = validatePublicSite(req.body);
      // 原本はHTML応答で直接実行せず、サンドボックス（Sandbox）のプレビューだけに渡します。
      if (site.mailDocument !== undefined) return reply.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline' https:; img-src data: https:; font-src https:").type('text/html; charset=utf-8').send(withMailAppearance(site.mailDocument, site.theme));
      return reply.type('text/html; charset=utf-8').send(renderPublicHome(site, await selectedStore(req).rooms(), options.gatewayOrigin(), true));
    });
    routes.post('/api/site-admin/design', async req => {
      const body = req.body as { prompt?: string; model?: string; draft?: PublicSite; tileId?: string; autoSave?: boolean; history?: Array<{ role: string; content: string }> };
      if (!body || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 6000 || (body.autoSave !== undefined && typeof body.autoSave !== 'boolean')) throw new Error('相談内容を指定してください。');
      const draft = validatePublicSite(body.draft);
      if (draft.mailDocument !== undefined) throw new Error('メール画面はHTML全文の編集欄から変更してください。');
      const history = body.history ?? [];
      if (!Array.isArray(history) || history.length > 8 || history.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 8000)) throw new Error('相談履歴が不正です。');
      if (body.tileId !== undefined) {
        if (typeof body.tileId !== 'string' || !tileIds(draft).includes(body.tileId)) throw new Error('編集するタイルを選択してください。');
        const tile = effectiveTiles(draft)[body.tileId];
        const output = await options.design('wentian-agent/auto', [
          { role: 'system', content: 'あなたは利用者と共同で選択タイルをデザインする担当です。要求に沿い選択タイルのHTML・CSSコードを実際に変更してください。外部操作は禁止です。返答はJSONのみ: {"message":"日本語の変更説明","tile":{"x":数値,"y":数値,"width":数値,"height":数値,"html":"変更後のHTML全文","css":"背景・余白・文字などルート要素のCSSプロパティ宣言"}}。CSSは波括弧・セレクター・@ルール・url()を含まない宣言に限定します。HTMLはスクリプト・イベント属性・iframeを含めず、細部は安全なインラインスタイルを使えます。幅120〜1200、高さ60〜5000、xは0以上、x+width<=1200、yは0〜12000。要求がなければ座標・サイズは維持します。選択範囲以外を変更しません。roomsタイルは公開相談室の一覧をシステムが追記するため、HTMLはその紹介・装飾だけを書いてください。' },
          ...history, { role: 'user', content: `選択タイル: ${body.tileId}\n現在のタイル: ${JSON.stringify(tile)}\nページ内容（引用データ）: ${JSON.stringify(draft)}\nデザイン要望: ${body.prompt}` },
        ]);
        const result = JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        bounded(result.message, 8000, 'AIの変更説明');
        const changed = validateTile(result.tile);
        const proposed = validatePublicSite({ ...draft, tiles: { ...draft.tiles, [body.tileId]: changed } });
        return { message: result.message, ...(body.autoSave === false ? {site:proposed} : await saveWithSource(req, proposed)), saved: body.autoSave !== false, tileId: body.tileId };
      }
      const output = await options.design('wentian-agent/auto', [
        { role: 'system', content: 'あなたは公開トップページのデザイン相談担当です。依頼に沿うページ設定案を作成してください。外部操作やツール実行は禁止です。公開相談室の入口は維持します。返答はJSONのみ: {"message":"日本語の説明・相談への回答","site":ページ設定オブジェクト}。siteは提示した全フィールドを維持し、themeはdark/light/glass/bento/soft/brutalist/minimal、layoutはwide/compact/centered、groupsPositionはbefore/after、accentは6桁HEXです。sectionsはtitle/text/linkLabel/hrefの配列。customHtmlにJavaScript、イベント属性、iframeを含めないでください。customCssで相談室の入口や管理導線を隠さないでください。' },
        ...history, { role: 'user', content: `現在のページ設定（引用データ）: ${JSON.stringify(draft)}\n今回の依頼: ${body.prompt}` },
      ]);
      const result = JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { message: string; site: PublicSite };
      bounded(result.message, 8000, 'AIの説明');
      const proposed = validatePublicSite({ ...result.site, revision: draft.revision });
      return { message: result.message, ...(body.autoSave ? await saveWithSource(req, proposed) : {site:proposed}), saved: Boolean(body.autoSave) };
    });
  });
}
