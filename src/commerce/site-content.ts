import {check,text,type SitePage,type SiteRevision,type Maker} from './model.js';

/** 必須ページ（Required Pages）は確認済みの事実を入力し、公開前に人が承認します。 */
export const requiredSitePages=['about','products','contact','shipping','seller','privacy','terms'] as const;
export function validateSitePages(input:unknown):Record<string,SitePage>{
  check(input&&typeof input==='object'&&!Array.isArray(input),'invalid_pages','ページ内容を指定してください。');
  const value=input as Record<string,any>,pages:Record<string,SitePage>={};
  for(const slug of requiredSitePages){
    const page=value[slug];check(page,'page_missing',`${slug}ページが必要です。`);
    pages[slug]={title:text(page.title,'ページ名',150),body:text(page.body,'ページ本文',12000),source:text(page.source,'内容の根拠',1000),confirmed:page.confirmed===true};
  }
  return pages;
}

/** 下書きへ契約条項を捏造せず、販売者が確定すべき事項を明示します。 */
export function draftSitePages(maker:Maker):Record<string,SitePage>{
  const entries=[
    ['about','メーカー紹介',maker.name+'\n販売主体：'+maker.legalName],
    ['products','製品一覧','製品の仕様、価格、在庫、出典、確認日を入力してください。未確認の性能は公開しないでください。'],
    ['contact','お問い合わせ','連絡先：'+maker.contact+'\n受付時間・回答目安を確認してください。'],
    ['shipping','配送・返品条件','配送対象地域、送料、発送時期、返品期限、返品費用、保証範囲を入力してください。'],
    ['seller','販売者表示','販売主体：'+maker.legalName+'\n連絡先：'+maker.contact+'\n所在地、責任者、支払方法、引渡時期など販売地域で必要な表示を確認してください。'],
    ['privacy','プライバシー','収集情報、利用目的、保存期間、委託先、第三者提供、削除・開示窓口を確認して入力してください。'],
    ['terms','利用規約','提供範囲、成立時点、利用許諾、禁止事項、解約、責任範囲、準拠法、紛争窓口を確認して入力してください。']
  ];
  return Object.fromEntries(entries.map(([slug,title,body])=>[slug,{title,body,confirmed:false,source:'販売者の入力・確認待ち'}]));
}

/** 差分（Diff）は本文をコードとして実行せず、版ごとのフィールド変更として返します。 */
export function diffSiteRevision(before:SiteRevision,after:SiteRevision){
  const changes:Array<{field:string;before:unknown;after:unknown}>=[];
  for(const key of ['title','headline','introduction'] as const)if(before[key]!==after[key])changes.push({field:key,before:before[key],after:after[key]});
  for(const slug of requiredSitePages){const a=before.pages?.[slug],b=after.pages?.[slug];if(JSON.stringify(a)!==JSON.stringify(b))changes.push({field:'pages.'+slug,before:a??null,after:b??null})}
  return {from:before.revision,to:after.revision,changes};
}

/** 公開ページ（Public Page）は保存済み本文を必ずエスケープします。 */
export function renderSitePage(siteTitle:string,page:SitePage,home:string,language='ja'){
  const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  return `<!doctype html><html lang="${esc(language)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(page.title)} · ${esc(siteTitle)}</title><style>body{margin:0;background:#141b17;color:#eeeade;font:16px/1.9 system-ui}main{max-width:880px;margin:auto;padding:60px 6%}a{color:#d2b989}h1{font:38px Georgia}article{white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid #ffffff30;padding-top:30px}</style><main><a href="${esc(home)}">${esc(siteTitle)}</a><h1>${esc(page.title)}</h1><article>${esc(page.body)}</article></main></html>`;
}
