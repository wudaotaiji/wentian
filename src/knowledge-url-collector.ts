import sanitizeHtml from 'sanitize-html';
import { extractKnowledgeFile, renderKnowledgePage, readAuthenticatedKnowledge, type ExtractedKnowledge } from './knowledge-extraction.js';
import { knowledgeProfiles, KnowledgeSourceError } from './knowledge-resource.js';
import { KnowledgeError, ProjectKnowledgeStore, validateSourceUrl } from './project-knowledge.js';

export type KnowledgePageReader = (url: string, signal: AbortSignal) => Promise<{ url: string; body?: string; contentType?: string; extracted?: ExtractedKnowledge }>;

/** サニタイザーがエスケープした文字だけを本文へ戻します。HTMLやスクリプトは実行しません。 */
const plain = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]!);

/** HTMLを資料本文と同一サイトの候補URLへ変換します。資料の意味・分類はここで判断しません。 */
export function extractKnowledgePage(page: { url: string; body: string; contentType?: string }) {
  const mediaType = page.contentType?.split(';')[0].trim().toLowerCase();
  if (mediaType && !['text/html', 'application/xhtml+xml', 'text/plain'].includes(mediaType)) throw new KnowledgeError('URL収集はHTMLまたはプレーンテキストに対応しています。', 'unsupported_source');
  if (Buffer.byteLength(page.body) > 25 * 1024 * 1024) throw new KnowledgeError('取得したページが上限を超えています。', 'content_too_large');
  if (mediaType === 'text/plain') return { title: (new URL(page.url).pathname || page.url).slice(0, 200), content: page.body.trim(), links: [] as string[] };
  const parts: string[] = [], links: string[] = []; let title = '';
  sanitizeHtml(page.body, {
    allowedTags: ['title', 'a', 'p', 'div', 'h1', 'h2', 'h3', 'li', 'br', 'article', 'section', 'main', 'span', 'strong', 'em'],
    allowedAttributes: { a: ['href'] }, nonTextTags: ['script', 'style', 'textarea', 'noscript', 'template'],
    textFilter: text => { parts.push(plain(text)); return text; },
    exclusiveFilter: frame => { if (frame.tag === 'title') title = plain(frame.text).trim(); return false; },
    transformTags: { a: (tagName, attributes) => {
      if (attributes.href) try {
        const link = new URL(attributes.href, page.url); link.hash = '';
        if (link.origin === new URL(page.url).origin && ['http:', 'https:'].includes(link.protocol) && !link.username && !link.password) links.push(link.href);
      } catch { /* 不正なリンクは収集候補に追加しません。 */ }
      return { tagName, attribs: attributes };
    } },
  });
  return { title: (title || new URL(page.url).pathname || page.url).slice(0, 200), content: parts.join('\n').trim(), links: [...new Set(links)] };
}

/** URL登録時に本文を取得し、任意指定の同一サイト巡回も有限件数で実行します。 */
export async function collectProjectUrls(store: ProjectKnowledgeStore, projectId: string, input: unknown, authorize: () => Promise<boolean>, read?: KnowledgePageReader, state?: {pending:string[];seen:string[];origin?:string;signal?:AbortSignal}) {
  const body = input as { url?: unknown; followLinks?: unknown; maxPages?: unknown; profileId?: unknown; render?: unknown };
  if (!body || Object.keys(body).some(k => !['url', 'followLinks', 'maxPages', 'profileId', 'render'].includes(k)) || (body.followLinks !== undefined && typeof body.followLinks !== 'boolean') || (body.render !== undefined && typeof body.render !== 'boolean') || (body.profileId !== undefined && typeof body.profileId !== 'string')) throw new KnowledgeError('URL収集の入力が不正です。', 'invalid_collection');
  const profile=body.profileId?(await knowledgeProfiles()).find(p=>p.id===body.profileId&&p.projects.includes(projectId)):undefined;
  if(body.profileId&&!profile)throw new KnowledgeError('このプロジェクトで利用できる接続設定を選択してください。','collection_forbidden');
  const reader:KnowledgePageReader=read||(async(url,signal)=>{
    const resource=await readAuthenticatedKnowledge(url,signal,profile);
    const mediaType=resource.contentType.split(';')[0].trim().toLowerCase();
    if(mediaType.startsWith('text/')||['application/xhtml+xml','application/json','application/xml','application/rss+xml','application/atom+xml'].includes(mediaType)){
      if(body.render&&['text/html','application/xhtml+xml'].includes(mediaType)){const extracted=await renderKnowledgePage(resource.url,{profile,signal,render:true},undefined,resource);return{url:extracted.url,extracted}}
      const charset=/charset=["']?([^;"' ]+)/i.exec(resource.contentType)?.[1]||'utf-8';
      return{url:resource.url,body:new TextDecoder(charset,{fatal:true}).decode(resource.bytes),contentType:['text/html','application/xhtml+xml'].includes(mediaType)?resource.contentType:'text/plain'};
    }
    return{url:resource.url,extracted:await extractKnowledgeFile(resource,signal,undefined,profile?.documentPassword)};
  });
  const initialUrl = new URL(validateSourceUrl(body.url)); initialUrl.hash = '';
  const initial = initialUrl.href, maxPages = body.maxPages === undefined ? (body.followLinks ? 5 : 1) : body.maxPages;
  if (!Number.isInteger(maxPages) || Number(maxPages) < 1 || Number(maxPages) > 10) throw new KnowledgeError('URL収集は1〜10ページで指定してください。', 'invalid_collection');
  const queue = state?.pending.slice()||[initial], visited = new Set<string>(state?.seen||[]); let origin = state?.origin||new URL(initial).origin, attempts=0;
  const documents: Array<{ documentId: string; title: string; url: string; revision: number }> = [];
  const errors: Array<{ url: string; message: string; code?:string }> = [];
  const signal = state?.signal?AbortSignal.any([state.signal,AbortSignal.timeout(15*60000)]):AbortSignal.timeout(15*60000);
  const warnings:Array<{url:string;message:string}>=[];
  while (queue.length && attempts < Number(maxPages)) {
    if(signal.aborted){errors.push({url:queue[0],message:'URL収集が時間上限に達しました。'});break}
    if (!await authorize()) throw new KnowledgeError('資料を収集する権限がありません。', 'collection_forbidden');
    const url = queue.shift()!; if (visited.has(url)) continue; visited.add(url);attempts++;
    // 取得前の版を記録し、通信中の手動編集を上書きしません。
    const before = await store.list(projectId);
    try {
      const page = await reader(url, signal); signal.throwIfAborted(); validateSourceUrl(page.url);
      if (visited.size === 1) origin = new URL(page.url).origin;
      else if (new URL(page.url).origin !== origin) throw new KnowledgeError('巡回先が別サイトへ転送されました。', 'unsupported_source');
      const parsed = page.extracted||extractKnowledgePage({...page,body:page.body||''});
      for(const message of page.extracted?.warnings||[])warnings.push({url:page.url,message});
      if (!parsed.content) throw new KnowledgeError('本文を抽出できませんでした。','unsupported_source');
      if (!await authorize()) throw new KnowledgeError('資料を収集する権限がありません。', 'collection_forbidden');
      const saved=await store.saveCollectedBundle(projectId,{title:parsed.title,url:page.url,content:parsed.content},before);
      for(const document of saved)documents.push({documentId:document.documentId,title:document.title,url:document.url,revision:document.revision});
      if (body.followLinks) for (const rawLink of parsed.links) {let link:string;try{const candidate=new URL(rawLink,page.url);candidate.hash='';if(!['http:','https:'].includes(candidate.protocol))continue;link=candidate.href}catch{continue}if(link!==page.url&&new URL(link).origin===origin&&!visited.has(link)&&!queue.includes(link)){if(queue.length>=100000){if(!warnings.some(w=>w.message==='未処理URLが安全上限に達しました。収集範囲を分けてください。'))warnings.push({url:page.url,message:'未処理URLが安全上限に達しました。収集範囲を分けてください。'})}else queue.push(link);}}
    } catch (error) {
      if (error instanceof KnowledgeError && error.code === 'collection_forbidden') throw error;
      if(error instanceof KnowledgeSourceError&&error.code==='auth_required'){visited.delete(url);queue.unshift(url);errors.push({url,message:error.message,code:error.code});break}
      if(signal.aborted){visited.delete(url);queue.unshift(url);errors.push({url,message:'URL収集を中断しました。続きから再開できます。'});break}
      errors.push({ url, message: error instanceof KnowledgeError || error instanceof KnowledgeSourceError ? error.message : '資料を取得・抽出できませんでした。接続設定、ログイン状態、抽出モデルを確認してください。' });
    }
  }
  return { documents, errors, complete: errors.length === 0 && warnings.length === 0 && queue.length === 0, visited: attempts, warnings, pending:queue, seen:[...visited], origin };
}
