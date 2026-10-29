/** 商取引（Commerce）の保存契約。金額は通貨の最小単位の整数で保持します。 */
export interface Actor { id:string; admin?:boolean }
export interface ReconciliationRun {id:string;startedAt:string;completedAt?:string;state:'running'|'completed';checked:number;differences:Array<{orderId:string;before:{payment:string;refunded:number;disputed:boolean};after:{payment:string;refunded:number;disputed:boolean}}>;failures:Array<{orderId:string;code:string}>}
export interface BenchmarkObservation {id:string;buildSignature:string;metric:'fps'|'ai_tokens_per_second'|'memory_mb_per_second'|'storage_mb_per_second'|'score';low:number;high:number;conditions:Record<string,string>;source:string;measuredAt:string;environment:string;methodVersion:string}
export interface CommerceState {reconciliationRuns?:ReconciliationRun[];benchmarks?:BenchmarkObservation[]}
export interface ConnectionPort {id:string;protocol:string;direction:'input'|'output'|'bidirectional';capacity:number;required:boolean}
export interface BuildConnection {id:string;from:{partId:string;portId:string};to:{partId:string;portId:string};quantity:number}
export interface Part {ports?:ConnectionPort[]}
export interface Build {connections?:BuildConnection[]}
export interface Order {buildReference?:{id:string;revision:number;ruleVersion:string;dataVersion:string}}
export interface BuildPurchase {id:string;owner:string;key:string;fingerprint:string;buildId:string;revision:number;orderIds:string[]}
export interface CommerceState {buildPurchases?:BuildPurchase[]}
export interface BillingPlan {id:string;name:string;priceId:string;amount:number;currency:string;interval:'once'|'month'|'year';credits:number;active:boolean;revision:number}
export interface BillingPurchase {id:string;owner:string;makerId:string;plan:BillingPlan;key:string;fingerprint:string;state:'pending'|'active'|'past_due'|'cancelled';sessionId?:string;url?:string;subscriptionId?:string;cancelAtPeriodEnd:boolean;periodEnd?:number;observedAt?:string}
export interface GenerationCredit {id:string;makerId:string;purchaseId?:string;jobId?:string;invoiceId?:string;units:number;at:string}
export interface CommerceState {billingPlans?:BillingPlan[];billingPurchases?:BillingPurchase[];generationCredits?:GenerationCredit[]}
export interface GenerationJob {creditUnits?:number}
export interface Maker {policyRevision?:number;feePayer?:'platform'|'seller'}
export interface Order {feePolicy?:{revision:number;basis:'order_total';bps:number;rounding:'floor';providerFeePayer:'platform'|'seller'}}
export interface CostBreakdown {parts:number;processing:number;assembly:number;inspection:number;packaging:number;shipping:number;tax:number;fees:number}
export interface SupplierQuote {id:string;supplier:string;amount:number;currency:string;moq:number;leadDays:number;expiresAt:string;status:'candidate'|'approved';costs?:CostBreakdown;regions?:string[];receivedAt?:string}
export interface AssemblyAnswer {id:string;makerId:string;amount:number;currency:string;costs:CostBreakdown;leadDays:number;expiresAt:string;warranty:string;inspection?:{at:string;report:string;confirmed:boolean}}
export interface AssemblyQuote {id:string;owner:string;buildId:string;revision:number;bom:unknown[];status:string;buildSnapshot?:Build;dataVersion?:string;supplierMakerIds?:string[];answers?:AssemblyAnswer[];acceptedAnswerId?:string}
export interface Listing {assemblyReference?:{quoteId:string;answerId:string;build:Build;bom:unknown[];inspection:string}}
export interface Project {alternatives?:Array<{id:string;original:string;candidate:string;unitCost:number;source:string;state:'candidate'|'confirmed';note:string}>}
export interface Product {id:string;name:string;model:string;manufacturer:string;variants:Array<{name:string;specVersion:string}>;source:string;createdAt:string}
export interface Maker { id:string; owner:string; members:Record<string,'manager'|'viewer'>; kind:'individual'|'company'; name:string; legalName:string; contact:string; country:string; stripeAccount?:string; chargesEnabled:boolean; feeBps:number; suspended:boolean }
export interface Project { id:string; makerId:string; revision:number; title:string; purpose:string; budget:number; quantity:number; deadline:string; bom:Array<{name:string;quantity:number;unitCost:number;source:string}>; quotes:SupplierQuote[]; stage:'planning'|'prototype'|'inspection'|'manufacturing'|'completed'; inspection:string; history:Array<{at:string;stage:string;note:string}>; plans?:Array<{revision:number;at:string;model:string;summary:string;requirements:string[];unknowns:string[];sources:string[]}> }
export interface Listing {id:string;makerId:string;productId:string;model:string;variant:string;specVersion:string;title:string;kind:'product'|'template'|'site';condition:'new'|'used'|'refurbished';currency:string;price:number;shipping:number|null;tax:number|null;stock:number;status:'draft'|'approved'|'suspended';warranty:string;returns:string;provenance:string;images:string[];source:string;observedAt:string;license:{scope:string;resale:boolean;sites:number}|null;asset:{version:string;content:string;rights:string[]}|null;siteId?:string;domain?:string}
export interface Order {id:string;buyer:string;sellerId:string;listingId:string;quantity:number;amount:number;currency:string;fee:number;state:'pending_payment'|'paid'|'fulfilling'|'shipped'|'delivered'|'completed'|'cancelled'|'return_requested'|'returned';payment:'created'|'processing'|'succeeded'|'failed'|'cancelled';refundState:'none'|'requested'|'processing'|'succeeded'|'failed';reservedUntil:number;reservation:boolean;snapshot:Listing;address:string;sessionId?:string;paymentIntent?:string;checkoutUrl?:string;refunded:number;disputed:boolean;tracking:string;createdAt:string;history:Array<{at:string;state:string}>}
export interface Refund {id:string;orderId:string;amount:number;reason:string;state:'requested'|'processing'|'succeeded'|'failed';providerId?:string}
export interface Ledger {id:string;orderId:string;type:'sale'|'refund'|'provider_fee'|'fee'|'fee_reversal'|'transfer'|'transfer_reversal'|'payout';amount:number;currency:string;providerRef:string;at:string}
export interface SitePage {title:string;body:string;confirmed:boolean;source:string}
export interface SiteRevision {revision:number;title:string;headline:string;introduction:string;pages?:Record<string,SitePage>}
export interface CommerceDomain {name:string;token:string;verified:boolean;certificate:'unconfigured'|'pending'|'active';provisioned?:boolean;lastCheckedAt?:string;error?:string}
export interface CommerceSite {id:string;makerId:string;slug:string;title:string;revision:number;publishedRevision:number;revisions:SiteRevision[];domain?:CommerceDomain}
export interface GenerationJob {id:string;makerId:string;key:string;fingerprint:string;limit:number;cost:number;concurrency?:number;items:Array<{title:string;slug:string;state:'queued'|'generating'|'validating'|'draft_ready'|'failed';error?:string;siteId?:string;pages?:Record<string,SitePage>}>}
export interface Transfer {id:string;orderId:string;siteId:string;from:string;to:string;state:'paid'|'transferring'|'delivered'|'accepted'|'completed'|'failed';rights:string[];error?:string}
export interface Part {id:string;category:'cpu'|'gpu'|'motherboard'|'memory'|'storage'|'psu'|'case'|'cooler';name:string;spec:Record<string,string|number|string[]|boolean>;source:string;verifiedAt:string}
export interface Build {id:string;owner:string;revision:number;title:string;purpose:string;budget:number;parts:Array<{id:string;quantity:number}>;positions:Record<string,{x:number;y:number}>;public:boolean}
export interface CommerceState {products:Product[];makers:Maker[];projects:Project[];listings:Listing[];orders:Order[];refunds:Refund[];ledger:Ledger[];sites:CommerceSite[];jobs:GenerationJob[];transfers:Transfer[];parts:Part[];builds:Build[];quotes:AssemblyQuote[];events:Array<{id:string;type:string;objectId:string;state:'pending'|'processed'|'failed';error?:string;receivedAt:string}>;audit:Array<{id:string;actor:string;action:string;entity:string;at:string}>;keys:Record<string,{fingerprint:string;id:string}>}
export const emptyCommerce=():CommerceState=>({products:[],makers:[],projects:[],listings:[],orders:[],refunds:[],ledger:[],sites:[],jobs:[],transfers:[],parts:[],builds:[],quotes:[],events:[],audit:[],keys:{}});
export class CommerceError extends Error { constructor(public code:string,message:string,public statusCode=400){super(message)} }
export function check(condition:unknown,code:string,message:string,status=400):asserts condition {if(!condition)throw new CommerceError(code,message,status)}
export function text(value:unknown,label:string,max=2000):string {check(typeof value==='string'&&value.trim().length>0&&value.length<=max,'invalid_input',`${label}を${max}文字以内で入力してください。`);return value.trim()}
export function integer(value:unknown,label:string,min=0,max=1_000_000_000):number {check(Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max,'invalid_amount',`${label}は${min}〜${max}の整数で指定してください。`);return Number(value)}
