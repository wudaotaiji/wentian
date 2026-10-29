import {readFileSync} from 'node:fs';
import {check,integer,text,type Actor} from './model.js';
import {CommerceRepository} from './repository.js';

export interface ContractPriceSource {id:string;endpoint:string;purchaseHosts:string[];contractConfirmed:boolean;attribution:string}
export interface ExternalOffer {id:string;sourceId:string;attribution:string;productId:string;model:string;variant:string;specVersion:string;condition:'new'|'used';currency:string;price:number;shipping:number|null;tax:number|null;stock:number|null;observedAt:string;purchaseUrl:string;sponsored:boolean;referral:boolean}
declare module './model.js' {interface CommerceState {externalOffers?:ExternalOffer[]}}
/** 契約済みの価格配信だけを読み込み、外部在庫を内部注文の在庫として扱いません。 */
export class ContractPrices {
  constructor(private repo:CommerceRepository,private sources:ContractPriceSource[],private request:typeof fetch=fetch){
    check(new Set(sources.map(s=>s.id)).size===sources.length,'price_source_invalid','価格配信元IDが重複しています。');
    for(const source of sources){const url=new URL(source.endpoint);check(source.contractConfirmed===true&&url.protocol==='https:'&&!url.username&&!url.password&&source.purchaseHosts.length>0,'price_source_invalid','契約確認済みのHTTPS配信元を設定してください。');text(source.attribution,'価格の出典',300)}
  }
  static configured(repo:CommerceRepository){const file=process.env.WENTIAN_COMMERCE_PRICE_SOURCES_FILE;const sources=file?JSON.parse(readFileSync(file,'utf8')):[];check(Array.isArray(sources),'price_source_invalid','価格配信元の設定は配列にしてください。');return new ContractPrices(repo,sources)}
  async refresh(actor:Actor,sourceId:string){
    check(actor.admin,'admin_required','価格更新には運営者権限が必要です。',403);const source=this.sources.find(s=>s.id===sourceId);check(source,'price_source_unconfigured','契約済みの価格配信元が未設定です。',503);
    const response=await this.request(source.endpoint,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{accept:'application/json'}});check(response.ok&&response.body,'price_source_failed','価格配信元から取得できませんでした。',502);
    // 大きな応答を最後まで保持せず、2MBを超えた時点で接続を打ち切ります。
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
    try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.length;check(length<=2_000_000,'price_source_too_large','価格応答の容量上限を超えました。',502);chunks.push(item.value)}}finally{await reader.cancel()}
    const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));check(Array.isArray(input.offers)&&input.offers.length<=5000,'price_source_invalid','価格応答の形式が不正です。',502);
    const offers:ExternalOffer[]=input.offers.map((item:any)=>{const url=new URL(item.purchaseUrl);check(url.protocol==='https:'&&!url.username&&!url.password&&source.purchaseHosts.includes(url.hostname),'purchase_host_invalid','契約対象外の購入先です。');check(['new','used'].includes(item.condition)&&/^[A-Z]{3}$/.test(item.currency),'price_source_invalid','商品状態または通貨が不正です。');const observed=Date.parse(item.observedAt);check(Number.isFinite(observed)&&observed<=Date.now()+60000,'price_source_invalid','価格確認日時が不正です。');return {id:text(item.id,'価格ID',150),sourceId:source.id,attribution:source.attribution,productId:text(item.productId,'商品ID',150),model:text(item.model,'型番',150),variant:text(item.variant,'バリエーション',150),specVersion:text(item.specVersion,'仕様版',100),condition:item.condition,currency:item.currency,price:integer(item.price,'価格'),shipping:item.shipping===null?null:integer(item.shipping,'送料'),tax:item.tax===null?null:integer(item.tax,'税'),stock:item.stock===null?null:integer(item.stock,'在庫'),observedAt:new Date(observed).toISOString(),purchaseUrl:url.href,sponsored:item.sponsored===true,referral:item.referral===true}});
    check(new Set(offers.map(o=>o.id)).size===offers.length,'price_source_invalid','外部価格IDが重複しています。');
    this.repo.transaction(state=>{state.externalOffers=[...(state.externalOffers||[]).filter(o=>o.sourceId!==source.id),...offers]});return {sourceId,count:offers.length};
  }
  offers(productId:string){const groups=new Map<string,Array<ExternalOffer&{total:number|null;stale:boolean}>>();for(const offer of this.repo.read().externalOffers||[]){if(offer.productId!==productId)continue;const key=[offer.model,offer.variant,offer.specVersion,offer.condition,offer.currency].join('/');const total=offer.shipping===null||offer.tax===null?null:offer.price+offer.shipping+offer.tax;groups.set(key,[...(groups.get(key)||[]),{...offer,total,stale:Date.now()-Date.parse(offer.observedAt)>86400000}])}return [...groups].map(([key,offers])=>({key,offers:offers.sort((a,b)=>(a.total??Infinity)-(b.total??Infinity))}))}
}
