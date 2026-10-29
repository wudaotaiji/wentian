import Fastify from 'fastify';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import {mkdir,writeFile} from 'node:fs/promises';
import {registerCommerce} from './commerce/routes.js';
import {StripeCommercePayments} from './commerce/payments.js';
import {evaluateBuild} from './commerce/compatibility.js';
import type {Part,Build} from './commerce/model.js';

/** 実HTTPとローカルルール（Local Rules）を測定し、外部決済時間を測定対象に混ぜません。 */
const app=Fastify(),actor={id:'verification',admin:true};
const {service}=registerCommerce(app,{workspace:os.tmpdir(),database:':memory:',worker:false,payments:new StripeCommercePayments('','','http://localhost'),identity:req=>req.headers.authorization==='verification'?actor:undefined});
const percentile=(values:number[])=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
try{
  const maker=service.createMaker(actor,{name:'性能検証',legalName:'架空の検証者',contact:'fixture@example.invalid',country:'JP'});
  const l=service.listing(actor,{makerId:maker.id,productId:'fixture',model:'F1',title:'検証商品',kind:'product',condition:'new',currency:'JPY',price:1000,shipping:100,tax:100,stock:10,warranty:'検証用',returns:'検証用',provenance:'検証用',images:[],source:'synthetic'});
  service.moderate(actor,l.id,{status:'approved',reason:'性能検証用'});
  await app.listen({host:'127.0.0.1',port:0});const origin='http://127.0.0.1:'+(app.server.address() as any).port;
  const readTimes:number[]=[],orderTimes:number[]=[];
  await Promise.all([
    ...Array.from({length:100},async()=>{const start=performance.now();const response=await fetch(origin+'/api/commerce/catalog');await response.json();if(!response.ok)throw new Error('公開閲覧が失敗しました。');readTimes.push(performance.now()-start)}),
    ...Array.from({length:10},async(_,index)=>{const start=performance.now();const response=await fetch(origin+'/api/commerce/orders',{method:'POST',headers:{authorization:'verification','content-type':'application/json','idempotency-key':'performance-'+index},body:JSON.stringify({listingId:l.id,quantity:1,expectedTotal:1200,currency:'JPY',address:'架空の検証住所'})});await response.json();if(!response.ok)throw new Error('注文が失敗しました。');orderTimes.push(performance.now()-start)})
  ]);
  // カタログ100部品・評価50ルールの合成資料で100回測定します。実在製品の適合根拠ではありません。
  const categories=['cpu','gpu','motherboard','memory','storage','psu','case','cooler'] as const;
  const parts:Part[]=Array.from({length:100},(_,i)=>({id:'part-'+i,category:i<8?categories[i]:'memory',name:'検証部品'+i,spec:{},source:'https://example.invalid/synthetic',verifiedAt:new Date().toISOString()}));
  const build:Build={id:'performance',owner:actor.id,revision:1,title:'性能検証',purpose:'検証',budget:0,parts:parts.slice(0,23).map(p=>({id:p.id,quantity:1})),positions:{},public:false};
  const ruleTimes:number[]=[];let ruleCount=0;
  for(let i=0;i<100;i++){const start=performance.now(),result=evaluateBuild(build,parts);ruleTimes.push(performance.now()-start);ruleCount=result.results.length}
  const result={at:new Date().toISOString(),environment:{node:process.version,os:os.platform()+' '+os.release(),cpu:os.cpus()[0]?.model,memoryGb:Math.round(os.totalmem()/2**30)},scope:'実HTTP・合成資料・外部決済なし。単一ローカルプロセス。',concurrency:{reads:100,orders:10},readP95Ms:percentile(readTimes),orderP95Ms:percentile(orderTimes),ruleP95Ms:percentile(ruleTimes),catalogParts:100,ruleCount,ruleRuns:100,orders:service.repo.read().orders.length,stock:service.repo.read().listings[0].stock};
  if(result.readP95Ms>1000||result.orderP95Ms>2000||result.ruleP95Ms>500||ruleCount!==50||result.orders!==10||result.stock!==0)throw new Error('性能・在庫の受入条件を満たしません。');
  await mkdir('docs/evidence/20261008_commerce',{recursive:true});await writeFile('docs/evidence/20261008_commerce/performance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await app.close()}
