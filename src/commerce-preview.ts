import Fastify from 'fastify';
import path from 'node:path';
import {registerCommerce} from './commerce/routes.js';
import {PublicSiteStore,renderPublicHome} from './public-site.js';
import {StripeCommercePayments} from './commerce/payments.js';

/** 検証専用プレビュー（Preview）。ループバック限定・模擬データ・決済未設定で起動します。 */
const workspace=path.resolve('.wentian/commerce-preview');
const app=Fastify();
// 起動スクリプトが別サービスを誤認しないための、検証専用の識別応答です。
app.get('/api/commerce/preview-status',()=>({kind:'wentian-commerce-preview',payments:'disabled'}));
app.addHook('onRequest',async(req,reply)=>{if(!['127.0.0.1','::1'].includes(req.ip))return reply.code(403).send({error:'ローカル検証専用です。'})});
const {service,repo}=registerCommerce(app,{workspace,origin:'http://127.0.0.1:8799',payments:new StripeCommercePayments('','','http://127.0.0.1:8799'),identity:()=>({id:'preview-admin',admin:true})});
app.get('/sites/:slug/',async(req,reply)=>{const site=await new PublicSiteStore(workspace,(req.params as {slug:string}).slug).load();return reply.type('text/html; charset=utf-8').send(renderPublicHome(site,[],'http://127.0.0.1:8799'))});
const actor={id:'preview-admin',admin:true};
if(repo.read().makers.length===0){
  const maker=service.createMaker(actor,{name:'Atelier / 検証用ブランド',legalName:'架空の検証事業者',contact:'preview@example.invalid',country:'JP'});
  for(const [index,title] of ['Desk collection / 概念商品','Creator workstation / 概念商品'].entries()){
    const listing=service.listing(actor,{makerId:maker.id,productId:'preview-'+index,model:'CONCEPT-'+index,title,kind:'product',condition:'new',currency:'JPY',price:12000*(index+1),shipping:500,tax:1200,stock:10,warranty:'検証用の条件です。販売していません。',returns:'検証用の条件です。販売していません。',provenance:'架空の検証データ',images:[],source:'preview-only'});
    service.moderate(actor,listing.id,{status:'approved',reason:'ローカル検証用の概念展示'});
  }
  // 部品は実在型番ではありません。資料不足のunknown判定をブラウザーで確認します。
  for(const category of ['cpu','gpu','motherboard','memory','storage','psu','case','cooler'])service.part(actor,{id:'preview-'+category,category,name:'Concept '+category,spec:{},source:'https://example.invalid/synthetic-spec',verifiedAt:new Date().toISOString()});
}
// 応答時間の検証資料を100部品にそろえます。実在製品・実測性能を装いません。
for(let index=8;index<100;index++)if(!repo.read().parts.some(p=>p.id==='preview-memory-'+index))service.part(actor,{id:'preview-memory-'+index,category:'memory',name:'Synthetic memory '+index,spec:{},source:'https://example.invalid/synthetic-spec',verifiedAt:new Date().toISOString()});
if(!repo.read().builds.some(b=>b.title==='100 parts / 50 rules / synthetic'))service.build(actor,{title:'100 parts / 50 rules / synthetic',purpose:'ローカル応答時間の合成資料',budget:0,parts:repo.read().parts.slice(0,23).map(p=>({id:p.id,quantity:1})),positions:{},public:false});
try {await app.listen({host:'127.0.0.1',port:8799})}catch(error){
  await app.close();
  if((error as NodeJS.ErrnoException).code==='EADDRINUSE')console.error('8799番ポートは使用中です。既存の検証画面 http://127.0.0.1:8799/commerce を確認してください。別サービスの場合は、その管理者がポート使用を調整してください。');
  throw error;
}
console.log('商取引の検証専用プレビュー: http://127.0.0.1:8799/commerce（決済未設定・架空データ）');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>void app.close());
