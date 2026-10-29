import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import Stripe from 'stripe';
import {createServer} from 'node:http';
import {CommerceRepository} from './commerce/repository.js';
import {ContractPrices} from './commerce/prices.js';
import {CommerceSupply} from './commerce/supply.js';
import {CommerceBilling} from './commerce/billing.js';
import type {BillingObservation} from './commerce/payments.js';
import type {BillingPurchase} from './commerce/model.js';
import {CaddyCommerceDomains,CommerceDomainManager} from './commerce/domains.js';
import {StripeCommercePayments,type CommercePayments,type PaymentObservation} from './commerce/payments.js';
import {registerCommerce} from './commerce/routes.js';
import {evaluateBuild} from './commerce/compatibility.js';
import type {Actor,Part,Build,Order,Maker} from './commerce/model.js';

const admin:Actor={id:'admin',admin:true},seller:Actor={id:'seller'},buyer:Actor={id:'buyer'},other:Actor={id:'other'};
test('契約価格は新品・中古を分離し、送料不明・古い観測・紹介を保持して外部在庫を予約しない',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'commerce-prices-')),repo=new CommerceRepository(path.join(directory,'state.sqlite'));
  try{const source={id:'contract',endpoint:'https://supplier.example/offers',purchaseHosts:['shop.example'],contractConfirmed:true,attribution:'契約資料'};let purchaseUrl='https://shop.example/item';
    const prices=new ContractPrices(repo,[source],(async()=>new Response(JSON.stringify({offers:['new','used'].map((condition,i)=>({id:String(i),productId:'part',model:'model',variant:'standard',specVersion:'1',condition,currency:'JPY',price:100,shipping:i?20:null,tax:0,stock:null,observedAt:'2020-01-01T00:00:00Z',purchaseUrl,sponsored:true,referral:true}))}))) as typeof fetch);
    await assert.rejects(prices.refresh(buyer,'contract'),{code:'admin_required'});await prices.refresh(admin,'contract');const groups=prices.offers('part');assert.equal(groups.length,2);assert.equal(groups[0].offers[0].total,null);assert.equal(groups[0].offers[0].stale,true);assert.equal(groups[1].offers[0].total,120);assert.equal(repo.read().listings.length,0);
    purchaseUrl='https://unapproved.example/item';await assert.rejects(prices.refresh(admin,'contract'),{code:'purchase_host_invalid'});assert.equal(prices.offers('part').length,2);
    assert.throws(()=>new ContractPrices(repo,[{...source,contractConfirmed:false}]),{code:'price_source_invalid'});
  }finally{repo.close();await rm(directory,{recursive:true,force:true})}
});
/** 模擬事業者（Simulated Provider）は実金銭を動かさず、照会結果・署名・障害を制御します。 */
class SimulatedPayments implements CommercePayments {
  mode='simulated' as const;observations=new Map<string,PaymentObservation>();fail=false;calls=0;refundKeys=new Map<string,{id:string;state:string}>();
  async account(_id:string){return {chargesEnabled:true}}
  async checkout(order:Order,_maker:Maker){const id='cs_'+order.id;this.observations.set(id,{id,orderId:order.id,amount:order.amount,currency:order.currency,paid:false,refunded:0,disputed:false,paymentIntent:'pi_'+order.id,refunds:[]});return {id,url:'https://checkout.stripe.com/test/'+id}}
  async observe(id:string){if(this.fail)throw new Error('模擬障害');return structuredClone(this.observations.get(id)!)}
  async refund(order:Order,amount:number,key:string){if(this.refundKeys.has(key))return this.refundKeys.get(key)!;const observation=this.observations.get(order.sessionId!)!;observation.refunded+=amount;const result={id:'re_'+key,state:'succeeded'};observation.refunds.push({id:result.id,amount,state:result.state});this.refundKeys.set(key,result);this.calls++;return result}
  verify(raw:Buffer,signature:string){assert.equal(signature,'verified');return JSON.parse(raw.toString())}
}
function fixture(){const repo=new CommerceRepository(':memory:'),payments=new SimulatedPayments(),service=new CommerceSupply(repo,payments);const maker=service.createMaker(seller,{name:'Atelier',legalName:'販売者',contact:'seller@example.test',country:'JP'});return {repo,payments,service,maker,close:()=>repo.close()}}
function listingInput(makerId:string,extra:any={}){return {makerId,productId:'desk-1',model:'D1',title:'Desk',kind:'product',condition:'new',currency:'JPY',price:1000,shipping:100,tax:100,stock:1,warranty:'1年',returns:'14日',provenance:'自社製造',images:[],source:'seller',...extra}}
function buy(f:ReturnType<typeof fixture>,listingId:string,key='order-1',who=buyer){return f.service.order(who,{listingId,quantity:1,expectedTotal:1200,currency:'JPY',address:'検証用住所'},key)}
async function paid(f:ReturnType<typeof fixture>,listingId:string,key='order-1'){const order=buy(f,listingId,key);await f.service.checkout(buyer,order.id);f.payments.observations.get('cs_'+order.id)!.paid=true;await f.service.reconcile(buyer,order.id);return f.service.getOrder(buyer,order.id)}
function approved(f:ReturnType<typeof fixture>,extra:any={}){const l=f.service.listing(seller,listingInput(f.maker.id,extra));f.service.moderate(admin,l.id,{status:'approved',reason:'確認済み'});return l}

test('AC-01/03: 事業・企画・見積・製造を保存し、他事業と閲覧専用の変更を拒否する',()=>{const f=fixture();try{const p=f.service.project(seller,{makerId:f.maker.id,title:'デスク',purpose:'集中',budget:10000,quantity:10,deadline:'2030-01-01',bom:[{name:'木材',quantity:1,unitCost:100,source:'仕入先資料'}]});assert.throws(()=>f.service.project(other,{...p,revision:p.revision},p.id),{statusCode:403});f.service.members(seller,f.maker.id,{userId:other.id,role:'viewer'});assert.equal(f.service.dashboard(other).projects.length,1);assert.throws(()=>f.service.project(other,{...p},p.id),{statusCode:403});const q=f.service.quote(seller,p.id,{supplier:'工房',amount:1000,currency:'JPY',moq:1,leadDays:10,expiresAt:'2030-01-01'});let current=f.service.dashboard(seller).projects[0];for(const stage of ['prototype','inspection','manufacturing','completed']){current=f.service.manufacture(seller,p.id,{revision:current.revision,stage,note:'検査記録',quoteId:q.id})}assert.equal(current.stage,'completed');assert.ok(f.repo.read().audit.length>=7)}finally{f.close()}});
test('AC-02: 10サイト量産を冪等化し、成功を残して失敗項目だけ再実行する',async()=>{const f=fixture();try{const input={makerId:f.maker.id,costLimit:0,items:Array.from({length:10},(_,i)=>({title:'ブランド'+i,slug:'brand-'+i}))};const j=f.service.generation(seller,input,'batch');assert.equal(f.service.generation(seller,input,'batch').id,j.id);assert.throws(()=>f.service.generation(seller,{...input,costLimit:1},'batch'),{statusCode:409});let calls=0;await f.service.runGeneration(j.id,async title=>{calls++;if(title==='ブランド3')throw new Error('模擬失敗');return {headline:title,introduction:'紹介文'}});assert.equal(f.repo.read().sites.length,9);f.service.retryGeneration(seller,j.id);await f.service.runGeneration(j.id,async title=>{calls++;return {headline:title,introduction:'再開'}});assert.equal(calls,11);assert.equal(f.repo.read().sites.length,10);assert.ok(f.repo.read().sites.every(s=>s.publishedRevision===0));assert.throws(()=>f.service.job(other,j.id),{statusCode:403})}finally{f.close()}});
test('AC-04/12: 新品・中古・通貨を分け、送料不明・古い価格・商品差分を表示する',()=>{const f=fixture();try{approved(f);approved(f,{condition:'used',images:['https://example.test/photo.jpg'],stock:2});const unknown=approved(f,{shipping:null});f.repo.transaction(s=>{s.listings.find(l=>l.id===unknown.id)!.observedAt='2000-01-01'});const groups=f.service.offers('desk-1');assert.equal(groups.length,2);assert.equal(groups[0].offers.at(-1)!.total,null);assert.equal(groups[0].offers.at(-1)!.stale,true);assert.throws(()=>buy(f,unknown.id),{code:'total_unknown'});assert.throws(()=>f.service.listing(seller,listingInput(f.maker.id,{condition:'used'})),{code:'resale_evidence'})}finally{f.close()}});
test('AC-05/06/07: 残り1点を二重予約せず、支払帰還で入金扱いせず、再送・逆順を照合する',async()=>{const f=fixture();try{const l=approved(f),o=buy(f,l.id);assert.equal(buy(f,l.id).id,o.id);const outcomes=await Promise.allSettled([Promise.resolve().then(()=>buy(f,l.id,'second',other)),Promise.resolve().then(()=>buy(f,l.id,'third',other))]);assert.ok(outcomes.every(x=>x.status==='rejected'));assert.throws(()=>f.service.advance(seller,o.id,{state:'fulfilling'}),{code:'invalid_transition'});await f.service.checkout(buyer,o.id);assert.equal(f.service.getOrder(buyer,o.id).state,'pending_payment');f.payments.observations.get('cs_'+o.id)!.paid=true;for(const event of [{id:'evt_new',type:'checkout.session.completed',objectId:'cs_'+o.id},{id:'evt_old',type:'checkout.session.expired',objectId:'cs_'+o.id},{id:'evt_new',type:'checkout.session.completed',objectId:'cs_'+o.id}])f.service.receive(Buffer.from(JSON.stringify(event)),'verified');await f.service.processEvents();assert.equal(f.repo.read().ledger.filter(l=>l.type==='sale').length,1);assert.equal(f.repo.read().events.length,2);assert.throws(()=>f.service.getOrder(other,o.id),{statusCode:403});f.service.advance(seller,o.id,{state:'fulfilling'});f.service.advance(seller,o.id,{state:'shipped',tracking:'TRACK1'});f.service.advance(buyer,o.id,{state:'delivered'});assert.equal(f.service.advance(buyer,o.id,{state:'completed'}).state,'completed')}finally{f.close()}});
test('AC-08: 部分返金・再実行・上限超過と購入者による実行を検証する',async()=>{const f=fixture();try{const o=await paid(f,approved(f).id),r=f.service.refundRequest(buyer,o.id,{amount:500,reason:'一部返品'},'refund-1');assert.equal(f.service.refundRequest(buyer,o.id,{amount:500,reason:'一部返品'},'refund-1').id,r.id);assert.throws(()=>f.service.refundRequest(buyer,o.id,{amount:701,reason:'超過'},'refund-2'),{code:'refund_exceeded'});await assert.rejects(f.service.executeRefund(buyer,r.id),{statusCode:403});await f.service.executeRefund(admin,r.id);await f.service.executeRefund(admin,r.id);assert.equal(f.payments.calls,1);assert.equal(f.service.getOrder(buyer,o.id).refunded,500);const last=f.service.refundRequest(buyer,o.id,{amount:700,reason:'残額'},'refund-3');await f.service.executeRefund(admin,last.id);assert.equal(f.repo.read().ledger.filter(l=>l.type==='refund').reduce((n,l)=>n+l.amount,0),1200);assert.throws(()=>f.service.refundRequest(buyer,o.id,{amount:1,reason:'超過'},'refund-4'),{code:'refund_exceeded'})}finally{f.close()}});
test('AC-09: 購入時点の版と利用許諾だけを購入者へ渡し、未購入者を拒否する',async()=>{const f=fixture();try{const l=approved(f,{kind:'template',license:{scope:'1サイト利用',sites:1,resale:false},asset:{version:'v1',content:'PRIVATE_ASSET',rights:['自社著作'],resaleAuthorized:true}});assert.ok(!JSON.stringify(f.service.catalog()).includes('PRIVATE_ASSET'));const o=await paid(f,l.id);f.repo.transaction(s=>{s.listings.find(x=>x.id===l.id)!.asset!.content='NEW_VERSION'});assert.equal(f.service.entitlement(buyer,o.id).asset!.content,'PRIVATE_ASSET');assert.throws(()=>f.service.entitlement(other,o.id),{statusCode:403})}finally{f.close()}});
test('AC-10: 永続イベントを障害後・再起動後に再処理し、SQLite退避を復旧する',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'commerce-recovery-')),payments=new SimulatedPayments();let repo=new CommerceRepository(path.join(root,'store.sqlite'));try{const service=new CommerceSupply(repo,payments);const m=service.createMaker(seller,{name:'復旧',legalName:'販売者',contact:'x',country:'JP'});const l=service.listing(seller,listingInput(m.id));service.moderate(admin,l.id,{status:'approved',reason:'確認'});const o=service.order(buyer,{listingId:l.id,quantity:1,expectedTotal:1200,currency:'JPY',address:'テスト'},'first');await service.checkout(buyer,o.id);payments.observations.get('cs_'+o.id)!.paid=true;service.receive(Buffer.from(JSON.stringify({id:'evt_restart',type:'checkout.session.completed',objectId:'cs_'+o.id})),'verified');payments.fail=true;assert.equal(await service.processEvents(),1);repo.backup(path.join(root,'backup.sqlite'));await access(path.join(root,'backup.sqlite'));repo.close();repo=new CommerceRepository(path.join(root,'backup.sqlite'));payments.fail=false;const restored=new CommerceSupply(repo,payments);assert.equal(await restored.processEvents(),0);assert.equal(restored.getOrder(buyer,o.id).payment,'succeeded');assert.equal(repo.read().ledger.filter(l=>l.type==='sale').length,1)}finally{repo.close();await rm(root,{recursive:true,force:true})}});
test('AC-11: 移転失敗から再納品し、受領後は旧事業の編集権限を解除する',async()=>{const f=fixture();try{const job=f.service.generation(seller,{makerId:f.maker.id,costLimit:0,items:[{title:'移転',slug:'transfer-site'}]},'transfer');await f.service.runGeneration(job.id);const site=f.repo.read().sites[0],l=approved(f,{kind:'site',siteId:site.id,license:{scope:'所有権移転',sites:1,resale:true},asset:{version:'1',content:'移転対象',rights:['コード','文章'],resaleAuthorized:true}});await paid(f,l.id);const transfer=f.repo.read().transfers[0];f.service.transfer(seller,transfer.id,{failed:true,reason:'納品再確認'});f.service.transfer(seller,transfer.id,{confirmRights:true});const destination=f.service.createMaker(buyer,{name:'新所有者',legalName:'買主',contact:'buyer',country:'JP'});f.service.acceptTransfer(buyer,transfer.id,{makerId:destination.id});assert.throws(()=>f.service.editSite(seller,site.id,{revision:site.revision,title:'無権限',headline:'x',introduction:'y'}),{statusCode:403});assert.equal(f.service.site(buyer,site.id).makerId,destination.id)}finally{f.close()}});

test('未入金の注文応答・一覧からデジタル納品物の内容を漏らさない',async()=>{const app=Fastify(),payments=new SimulatedPayments();const {service}=registerCommerce(app,{workspace:os.tmpdir(),database:':memory:',worker:false,payments,identity:req=>req.headers.authorization==='buyer'?buyer:undefined});try{const maker=service.createMaker(seller,{name:'デジタル',legalName:'販売者',contact:'contact',country:'JP'});const l=service.listing(seller,listingInput(maker.id,{kind:'template',license:{scope:'1サイト',sites:1,resale:false},asset:{version:'v1',content:'PAID_SECRET_ASSET',rights:['自社著作'],resaleAuthorized:true}}));service.moderate(admin,l.id,{status:'approved',reason:'確認済み'});const response=await app.inject({method:'POST',url:'/api/commerce/orders',headers:{authorization:'buyer','idempotency-key':'digital'},payload:{listingId:l.id,quantity:1,expectedTotal:1200,currency:'JPY',address:'テスト'}});assert.equal(response.statusCode,200);assert.ok(!response.body.includes('PAID_SECRET_ASSET'));const orderId=response.json().id;const dashboard=await app.inject({url:'/api/commerce/dashboard',headers:{authorization:'buyer'}});assert.ok(!dashboard.body.includes('PAID_SECRET_ASSET'));assert.equal((await app.inject({url:'/api/commerce/orders/'+orderId+'/entitlement',headers:{authorization:'buyer'}})).statusCode,403)}finally{await app.close()}});
test('予約失効後の入金・決済応答前のイベントでも二重在庫と誤発送を防ぐ',async()=>{const f=fixture();try{const l=approved(f),first=buy(f,l.id);const session=await f.payments.checkout(first,f.maker);f.payments.observations.get(session.id)!.paid=true;f.repo.transaction(s=>{s.orders.find(o=>o.id===first.id)!.reservedUntil=0});f.service.expire();buy(f,l.id,'new-owner',other);f.service.receive(Buffer.from(JSON.stringify({id:'early-event',type:'checkout.session.completed',objectId:session.id})),'verified');assert.equal(await f.service.processEvents(),0);const current=f.service.getOrder(buyer,first.id);assert.equal(current.payment,'succeeded');assert.equal(current.state,'pending_payment');assert.equal(current.reservation,false);assert.equal(f.repo.read().refunds[0].amount,1200);assert.throws(()=>f.service.advance(seller,current.id,{state:'fulfilling'}),{code:'invalid_transition'});assert.equal(f.repo.read().listings[0].stock,0)}finally{f.close()}});
test('AI企画支援は住所・連絡先を渡さず、根拠・不明点・企画版を保持する',async()=>{const f=fixture();try{const p=f.service.project(seller,{makerId:f.maker.id,title:'企画',purpose:'制作',budget:1000,quantity:1,deadline:'2030-01-01',bom:[]});const plan=await f.service.planProject(seller,p.id,'fixture/model',async input=>{assert.ok(!JSON.stringify(input).includes('seller@example'));assert.equal('address' in input,false);return {summary:'構想',requirements:['用途確認'],unknowns:['供給能力'],sources:[]}});assert.equal(plan.revision,p.revision);assert.equal(f.service.dashboard(seller).projects[0].plans!.length,1);await assert.rejects(f.service.planProject(other,p.id,'fixture/model',async()=>({})),{statusCode:403});await assert.rejects(f.service.planProject(seller,p.id,'',async()=>({})),{code:'planner_unconfigured'})}finally{f.close()}});
test('サイト版復帰とDNS所有確認を行い、証明書未接続をactiveへ変換しない',async()=>{const f=fixture();try{const job=f.service.generation(seller,{makerId:f.maker.id,costLimit:0,items:[{title:'Original',slug:'domain'}]},'domain');await f.service.runGeneration(job.id);const site=f.repo.read().sites[0];let current=f.service.editSite(seller,site.id,{revision:1,title:'Edited',headline:'新見出し',introduction:'新本文'});current=f.service.editSite(seller,site.id,{revision:current.revision,restoreRevision:1});assert.equal(current.title,'Original');assert.equal(current.revision,3);const domain=f.service.domain(seller,site.id,{name:'atelier.example'});assert.ok('token' in domain);await assert.rejects(f.service.verifyDomain(seller,site.id,(async()=>[['incorrect']]) as any),{code:'domain_unverified'});const verified=await f.service.verifyDomain(seller,site.id,(async()=>[['token' in domain?domain.token:'']]) as any);assert.equal(verified.verified,true);assert.equal(verified.certificate,'pending');assert.throws(()=>f.service.domain(other,site.id,{release:true}),{statusCode:403})}finally{f.close()}});
test('StripeアダプターのHTTP契約で金額・分配先・冪等性・返金取消・銀行入金を検証する',async()=>{
  const requests:Array<{url:string;body:URLSearchParams;key:string}>=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({url:req.url!,body:new URLSearchParams(raw),key:String(req.headers['idempotency-key']||'')});let value:any={};const url=req.url!.split('?')[0];if(url==='/v1/accounts/acct_fixture')value={id:'acct_fixture',charges_enabled:true,payouts_enabled:true,details_submitted:true};else if(url==='/v1/checkout/sessions'&&req.method==='POST')value={id:'cs_fixture',url:'https://checkout.stripe.com/fixture'};else if(url==='/v1/checkout/sessions/cs_fixture')value={id:'cs_fixture',client_reference_id:'order_fixture',amount_total:1200,currency:'jpy',payment_status:'paid',payment_intent:{id:'pi_fixture'}};else if(url==='/v1/charges')value={data:[{id:'ch_fixture',amount_refunded:0,disputed:false,transfer:'tr_fixture',application_fee:'fee_fixture'}]};else if(url==='/v1/transfers/tr_fixture')value={id:'tr_fixture',amount:1200,amount_reversed:0};else if(url==='/v1/application_fees/fee_fixture')value={id:'fee_fixture',amount_refunded:0};else if(url==='/v1/refunds')value=req.method==='POST'?{id:'re_fixture',status:'succeeded'}:{data:[]};else if(url==='/v1/payouts')value={data:[{id:'po_fixture',amount:1000,currency:'jpy',status:'paid',arrival_date:1}]};else res.statusCode=404;res.setHeader('content-type','application/json');res.end(JSON.stringify(value))});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const f=fixture();try{const client=new Stripe('sk_test_fixture',{host:'127.0.0.1',port:(server.address() as any).port,protocol:'http',maxNetworkRetries:0});const provider=new StripeCommercePayments('sk_test_fixture','whsec_fixture','http://localhost',false,client),l=approved(f),order=buy(f,l.id);order.id='order_fixture';order.fee=60;order.paymentIntent='pi_fixture';await provider.checkout(order,{...f.maker,stripeAccount:'acct_fixture',chargesEnabled:true});const post=requests.find(r=>r.url==='/v1/checkout/sessions')!;assert.equal(post.body.get('line_items[0][price_data][unit_amount]'),'1200');assert.equal(post.body.get('payment_intent_data[transfer_data][destination]'),'acct_fixture');assert.equal(post.body.get('payment_intent_data[application_fee_amount]'),'60');assert.equal(post.key,'checkout:order_fixture');const observation=await provider.observe('cs_fixture');assert.equal(observation.transferred,1200);assert.equal(observation.orderId,'order_fixture');await provider.refund(order,500,'unique-refund');const refund=requests.find(r=>r.body.get('reverse_transfer')==='true')!;assert.equal(refund.body.get('refund_application_fee'),'true');assert.equal(refund.key,'refund:unique-refund');assert.equal((await provider.payouts('acct_fixture'))[0].status,'paid')}finally{f.close();await new Promise<void>(resolve=>server.close(()=>resolve()))}
});

/** 仮想部品（Synthetic Parts）は実在製品の性能・適合を保証する資料として利用しません。 */
export function syntheticParts():Part[]{const source='https://example.test/synthetic-spec',verifiedAt='2026-10-08T00:00:00Z';const specifications:Array<{id:string;category:Part['category'];spec:Part['spec']}>= [
{id:'cpu',category:'cpu',spec:{socket:'S1',minimumBiosRevision:2,estimatedWatts:100}},
{id:'board',category:'motherboard',spec:{socket:'S1',supportedCpus:['cpu'],biosRevision:2,memoryGeneration:'DDR5',memoryForm:'DIMM',maxMemoryGb:128,memorySlots:4,form:'ATX',storageInterfaces:['NVMe'],storageForms:['2280'],storagePorts:2,gpuLanes:16,sharedPortsVerified:true,estimatedWatts:30}},
{id:'memory',category:'memory',spec:{generation:'DDR5',form:'DIMM',capacityGb:32,estimatedWatts:8}},
{id:'gpu',category:'gpu',spec:{lengthMm:200,heightMm:100,slots:2,requiredLanes:16,powerConnectors:['8pin'],estimatedWatts:200}},
{id:'storage',category:'storage',spec:{interface:'NVMe',form:'2280',estimatedWatts:5}},
{id:'psu',category:'psu',spec:{watts:800,gpuConnectors:['8pin']}},
{id:'case',category:'case',spec:{boardForms:['ATX'],gpuMaxLengthMm:300,gpuMaxHeightMm:150,gpuMaxSlots:3,coolerMaxHeightMm:170,estimatedWatts:5}},
{id:'cooler',category:'cooler',spec:{sockets:['S1'],heightMm:150,estimatedWatts:5}}
];return specifications.map(p=>({...p,name:'検証用 '+p.id,source,verifiedAt}))}
function syntheticBuild(parts=syntheticParts()):Build{return {id:'build',owner:buyer.id,revision:1,title:'検証用',purpose:'検証',budget:0,parts:parts.map(p=>({id:p.id,quantity:1})),positions:{},public:false}}
test('PC-AC-01〜07: ソケット・BIOS・寸法・電源・欠落を別判定し、根拠と版を保持する',()=>{const parts=syntheticParts(),build=syntheticBuild();assert.equal(evaluateBuild(build,parts).status,'compatible');const cases:Array<[string,string,unknown,string]>=[['cpu','socket','S2','incompatible'],['board','biosRevision',1,'conditional'],['case','gpuMaxLengthMm',100,'incompatible'],['psu','gpuConnectors',[],'incompatible'],['psu','watts',100,'incompatible'],['memory','generation','DDR4','incompatible']];for(const [id,key,value,status] of cases){const changed=structuredClone(parts);changed.find(p=>p.id===id)!.spec[key]=value as any;assert.equal(evaluateBuild(build,changed).status,status,id+key)}delete parts[0].spec.socket;const result=evaluateBuild(build,parts);assert.equal(result.status,'unknown');assert.ok(result.results.every(r=>r.version&&r.sources.length&&r.reason));assert.equal(result.performance.status,'unavailable');assert.equal(evaluateBuild({...build,parts:[]},parts).status,'incomplete')});
test('PC-AC-01/02/06/09: 保存・座標・数量・版競合・見積を検証する',()=>{const f=fixture();try{for(const p of syntheticParts())f.service.part(admin,p);const b=f.service.build(buyer,syntheticBuild());assert.deepEqual(f.service.getBuild(buyer,b.id).parts,b.parts);assert.throws(()=>f.service.getBuild(other,b.id),{statusCode:403});const moved=f.service.build(buyer,{...b,positions:{cpu:{x:50,y:90}}},b.id);assert.equal(f.service.evaluate(buyer,b.id).status,'compatible');assert.throws(()=>f.service.build(buyer,b,b.id),{statusCode:409});assert.throws(()=>f.service.build(buyer,{...b,parts:[{id:'cpu',quantity:2}]}),{code:'quantity_constraint'});const q=f.service.buildQuote(buyer,b.id,{revision:moved.revision});assert.equal(q.bom.length,8);assert.throws(()=>f.service.buildQuote(buyer,b.id,{revision:1}),{statusCode:409});const bad=f.service.build(buyer,{...moved,parts:[{id:'cpu',quantity:1}]},b.id);assert.throws(()=>f.service.buildQuote(buyer,b.id,{revision:bad.revision}),{code:'compatibility_unresolved'})}finally{f.close()}});
test('Stripe公式署名の改ざん・期限切れ・本番混入・未設定を拒否する',async()=>{const secret='whsec_test-only',provider=new StripeCommercePayments('sk_test_unit',secret,'http://localhost');const stripe=new Stripe('sk_test_unit');const payload=JSON.stringify({id:'evt_signed',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_signed'}}});const signature=stripe.webhooks.generateTestHeaderString({payload,secret});assert.equal(provider.verify(Buffer.from(payload),signature).id,'evt_signed');assert.throws(()=>provider.verify(Buffer.from(payload+' '),signature));const old=stripe.webhooks.generateTestHeaderString({payload,secret,timestamp:1});assert.throws(()=>provider.verify(Buffer.from(payload),old));const live=payload.replace('"livemode":false','"livemode":true');assert.throws(()=>provider.verify(Buffer.from(live),stripe.webhooks.generateTestHeaderString({payload:live,secret})),{code:'environment_mismatch'});const unconfigured=new StripeCommercePayments('','','http://localhost');await assert.rejects(unconfigured.account('acct_missing'),{statusCode:503});assert.throws(()=>new StripeCommercePayments('sk_live_never','','http://localhost'),{code:'live_disabled'})});
test('HTTPの認証・CSRF・審査・エラーコード・生本文Webhook・公開承認を検証する',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'commerce-http-')),app=Fastify(),payments=new SimulatedPayments();const {service}=registerCommerce(app,{workspace:root,database:':memory:',worker:false,payments,identity:req=>req.headers.authorization==='seller'?seller:req.headers.authorization==='admin'?admin:undefined});try{assert.equal((await app.inject('/commerce')).statusCode,200);assert.equal((await app.inject('/api/commerce/catalog')).statusCode,200);assert.equal((await app.inject('/api/commerce/dashboard')).statusCode,401);assert.equal((await app.inject({method:'POST',url:'/api/commerce/makers',headers:{authorization:'seller',origin:'https://evil.test'},payload:{}})).statusCode,403);const maker=service.createMaker(seller,{name:'HTTP',legalName:'テスト',contact:'test',country:'JP'});const j=service.generation(seller,{makerId:maker.id,costLimit:0,items:[{title:'HTTP',slug:'http'}]},'http');await service.runGeneration(j.id);const site=service.repo.read().sites[0];const rejected=await app.inject({method:'POST',url:'/api/commerce/sites/'+site.id+'/publish',headers:{authorization:'seller'},payload:{revision:1,approved:false}});assert.equal(rejected.statusCode,400);assert.ok(rejected.json().error.traceId);const unconfirmed=await app.inject({method:'POST',url:'/api/commerce/sites/'+site.id+'/publish',headers:{authorization:'seller'},payload:{revision:1,approved:true}});assert.equal(unconfirmed.statusCode,409);const pages=Object.fromEntries(Object.entries(site.revisions[0].pages!).map(([slug,page])=>[slug,{...page,confirmed:true}]));service.sitePages(seller,site.id,{revision:1,pages});const published=await app.inject({method:'POST',url:'/api/commerce/sites/'+site.id+'/publish',headers:{authorization:'seller'},payload:{revision:2,approved:true}});assert.equal(published.statusCode,200,published.body);await access(path.join(root,'.wentian/site-pages/maker-http.json'));const publicPage=await app.inject('/api/commerce/public-sites/http/pages/about');assert.equal(publicPage.statusCode,200);service.sitePages(seller,site.id,{revision:2,pages:{...pages,about:{...pages.about,body:'非公開の改稿'}}});assert.ok(!(await app.inject('/api/commerce/public-sites/http/pages/about')).body.includes('非公開の改稿'));assert.equal((await app.inject('/api/commerce/sites/'+site.id+'/diff?from=1&to=3')).statusCode,401);const event=await app.inject({method:'POST',url:'/api/commerce/payment-webhooks/stripe',headers:{'content-type':'application/json','stripe-signature':'verified'},payload:'{ "id":"raw", "type":"checkout.session.completed", "objectId":"none" }'});assert.equal(event.statusCode,202);assert.equal((await app.inject({method:'POST',url:'/api/commerce/payment-webhooks/stripe',headers:{'stripe-signature':'invalid'},payload:{}})).statusCode,400)}finally{await app.close();await rm(root,{recursive:true,force:true})}});


test('量産の同時数・必須ページ確認・差分・復帰を検証する',async()=>{
  const f=fixture();try{
    const job=f.service.generation(seller,{makerId:f.maker.id,costLimit:0,concurrency:2,items:Array.from({length:5},(_,i)=>({title:'並列'+i,slug:'parallel-'+i}))},'parallel');
    let current=0,maximum=0;
    await f.service.runGeneration(job.id,async title=>{current++;maximum=Math.max(maximum,current);await new Promise(resolve=>setTimeout(resolve,5));current--;return {headline:title,introduction:'確認前の下書き'}});
    assert.equal(maximum,2);assert.equal(f.service.job(seller,job.id).items.filter(i=>i.state==='draft_ready').length,5);
    const site=f.repo.read().sites[0],initial=site.revisions[0];
    assert.equal(Object.keys(initial.pages!).length,7);assert.equal(initial.pages!.terms.confirmed,false);
    const pages=Object.fromEntries(Object.entries(initial.pages!).map(([slug,page])=>[slug,{...page,confirmed:true}]));
    const confirmed=f.service.sitePages(seller,site.id,{revision:1,pages});assert.equal(confirmed.revision,2);
    assert.equal(f.service.siteDiff(seller,site.id,1,2).changes.length,7);
    const edited=f.service.editSite(seller,site.id,{revision:2,title:'変更',headline:'見出し',introduction:'本文'});assert.equal(edited.revisions.at(-1)!.pages!.terms.confirmed,true);
    const restored=f.service.editSite(seller,site.id,{revision:3,restoreRevision:1});assert.equal(restored.revisions.at(-1)!.pages!.terms.confirmed,false);
    assert.throws(()=>f.service.sitePages(other,site.id,{revision:4,pages}),{statusCode:403});
    assert.throws(()=>f.service.generation(seller,{makerId:f.maker.id,costLimit:0,concurrency:5,items:[{title:'上限',slug:'over'}]},'over'),{code:'invalid_amount'});
  }finally{f.close()}
});

test('日次照合でイベント欠落・差異・障害を記録し、実測資料を条件と構成別に保持する',async()=>{
  const f=fixture();try{
    const listing=approved(f),order=buy(f,listing.id);await f.service.checkout(buyer,order.id);
    f.payments.observations.get('cs_'+order.id)!.paid=true;
    const first=await f.service.reconcileAll(admin);assert.equal(first.checked,1);assert.equal(first.differences.length,1);
    assert.equal(f.service.getOrder(buyer,order.id).payment,'succeeded');
    const second=await f.service.reconcileAll(admin);assert.equal(second.differences.length,0);
    assert.equal(f.repo.read().ledger.filter(l=>l.type==='sale').length,1);
    f.payments.fail=true;const failed=await f.service.reconcileAll(admin);assert.equal(failed.failures.length,1);
    assert.throws(()=>f.service.reconciliationHistory(buyer),{statusCode:403});
    const parts=syntheticParts();for(const part of parts)f.service.part(admin,part);
    const build=f.service.build(admin,{title:'測定対象',purpose:'検証',budget:0,parts:parts.map(p=>({id:p.id,quantity:1})),positions:{},public:false});
    assert.equal(f.service.performance(admin,build.id).status,'unavailable');
    const observation={buildId:build.id,metric:'fps',low:50,high:60,conditions:{game:'合成ゲーム',version:'1',resolution:'1920x1080',quality:'high',driver:'test'},source:'https://example.invalid/synthetic-benchmark',measuredAt:'2026-01-01',environment:'合成資料。実製品の性能ではありません。',methodVersion:'synthetic-1'};
    assert.throws(()=>f.service.benchmark(admin,{...observation,conditions:{game:'不足'}}),{code:'benchmark_conditions_missing'});
    const measured=f.service.benchmark(admin,observation);assert.equal(measured.low,50);
    assert.equal(f.service.performance(admin,build.id,observation.conditions).observations.length,1);
    assert.equal(f.service.performance(admin,build.id,{resolution:'3840x2160'}).observations.length,0);
    f.service.part(admin,{...parts[0],spec:{...parts[0].spec,socket:'変更後'}});
    assert.equal(f.service.performance(admin,build.id).status,'unavailable');
  }finally{f.close()}
});

test('明示接続の方向・規格・端子数を検証し、構成購入の全在庫を原子的に確保する',()=>{
  const f=fixture();try{
    const parts=syntheticParts();parts.find(p=>p.id==='board')!.ports=[{id:'memory',protocol:'DDR5',direction:'output',capacity:1,required:false}];
    parts.find(p=>p.id==='memory')!.ports=[{id:'slot',protocol:'DDR5',direction:'input',capacity:1,required:true}];
    for(const part of parts)f.service.part(admin,part);
    const connection={id:'c1',from:{partId:'board',portId:'memory'},to:{partId:'memory',portId:'slot'},quantity:1};
    const input={...syntheticBuild(),connections:[connection]};
    assert.equal(evaluateBuild({...input,connections:[]},parts).status,'unknown');
    assert.equal(evaluateBuild(input,parts).status,'compatible');
    assert.throws(()=>f.service.build(buyer,{...input,connections:[{...connection,quantity:2}]}),{code:'connection_invalid'});
    assert.throws(()=>f.service.build(buyer,{...input,connections:[{...connection,from:connection.to,to:connection.from}]}),{code:'connection_invalid'});
    const build=f.service.build(buyer,input),evaluation=f.service.evaluate(buyer,build.id);
    const listings=parts.map(part=>approved(f,{productId:part.id,model:part.id,title:part.name,stock:2}));
    const purchaseInput={revision:build.revision,dataVersion:evaluation.dataVersion,address:'合成の配送先',selections:parts.map((part,index)=>({partId:part.id,listingId:listings[index].id,expectedTotal:1200,currency:'JPY'}))};
    f.repo.transaction(s=>{s.listings.find(l=>l.id===listings.at(-1)!.id)!.stock=0});
    assert.throws(()=>f.service.buildOrders(buyer,build.id,purchaseInput,'purchase'),{code:'out_of_stock'});
    assert.equal(f.repo.read().orders.length,0);assert.equal(f.repo.read().listings[0].stock,2);
    f.repo.transaction(s=>{s.listings.find(l=>l.id===listings.at(-1)!.id)!.stock=2});
    const purchased=f.service.buildOrders(buyer,build.id,purchaseInput,'purchase');assert.equal(purchased.orders.length,8);
    assert.ok(purchased.orders.every(o=>o.buildReference?.revision===build.revision));
    assert.deepEqual(f.service.buildOrders(buyer,build.id,purchaseInput,'purchase').purchase.orderIds,purchased.purchase.orderIds);
    assert.equal(f.repo.read().orders.length,8);assert.equal(f.repo.read().listings[0].stock,1);
    assert.throws(()=>f.service.buildOrders(buyer,build.id,{...purchaseInput,revision:99},'new'),{code:'revision_conflict'});
    assert.throws(()=>f.service.buildOrders(buyer,build.id,{...purchaseInput,dataVersion:'古い資料'},'new'),{code:'specification_changed'});
  }finally{f.close()}
});

test('継続利用料を照合して請求書ごとに生成枠を一度だけ付与し、失敗・解約・返金を反映する',async()=>{
  const repo=new CommerceRepository(':memory:');
  class BillingProvider extends SimulatedPayments {
    bills=new Map<string,BillingObservation>();
    async billingCheckout(p:BillingPurchase){const id='cs_bill_'+p.id;this.bills.set(id,{id,purchaseId:p.id,amount:p.plan.amount,currency:p.plan.currency,state:'pending',cancelAtPeriodEnd:false,paidInvoices:[]});return {id,url:'https://checkout.stripe.com/billing'}}
    async billingObserve(id:string){return structuredClone(this.bills.get(id)!)}
    async billingCancel(id:string,_key:string){for(const bill of this.bills.values())if(bill.subscriptionId===id)bill.cancelAtPeriodEnd=true}
  }
  const payments=new BillingProvider(),service=new CommerceBilling(repo,payments);
  try{
    const maker=service.createMaker(seller,{name:'利用料試験',legalName:'合成事業者',contact:'test',country:'JP'});
    const plan=service.saveBillingPlan(admin,{id:'maker',name:'合成プラン',priceId:'price_synthetic',amount:300,currency:'JPY',interval:'month',credits:10,active:true});
    const request={makerId:maker.id,planId:plan.id,revision:plan.revision,expectedAmount:300,currency:'JPY'};
    const checkout=await service.billingCheckout(seller,request,'billing');assert.equal((await service.billingCheckout(seller,request,'billing')).id,checkout.id);
    await service.reconcileBilling(seller,checkout.purchaseId);assert.equal(service.billingOverview(seller,maker.id).credits,0);
    const bill=payments.bills.get(checkout.id)!;bill.state='active';bill.subscriptionId='sub_synthetic';bill.paidInvoices=[{id:'invoice1',amount:300,currency:'JPY',refunded:false}];
    await service.reconcileBilling(seller,checkout.purchaseId);await service.reconcileBilling(seller,checkout.purchaseId);assert.equal(service.billingOverview(seller,maker.id).credits,10);
    const generationInput={makerId:maker.id,costLimit:0,useCredits:true,items:[{title:'有料枠',slug:'credits'}]};
    const job=service.generation(seller,generationInput,'credits');assert.equal(job.creditUnits,1);service.generation(seller,generationInput,'credits');assert.equal(service.billingOverview(seller,maker.id).credits,9);
    assert.throws(()=>service.generation(seller,{...generationInput,items:Array.from({length:10},(_,i)=>({title:'不足',slug:'insufficient-'+i}))},'insufficient'),{code:'credits_insufficient'});
    assert.equal(repo.read().jobs.length,1);
    bill.state='past_due';await service.reconcileBilling(seller,checkout.purchaseId);assert.equal(service.billingOverview(seller,maker.id).purchases[0].state,'past_due');
    await service.cancelBilling(seller,checkout.purchaseId);assert.equal(service.billingOverview(seller,maker.id).purchases[0].cancelAtPeriodEnd,true);
    bill.paidInvoices.push({id:'invoice2',amount:300,currency:'JPY',refunded:false});await service.reconcileBilling(seller,checkout.purchaseId);assert.equal(service.billingOverview(seller,maker.id).credits,19);
    bill.paidInvoices[0].refunded=true;await service.reconcileBilling(seller,checkout.purchaseId);await service.reconcileBilling(seller,checkout.purchaseId);assert.equal(service.billingOverview(seller,maker.id).credits,9);
    await assert.rejects(service.billingCheckout(other,request,'other'),{statusCode:403});
  }finally{repo.close()}
});

test('Stripe利用料SDKの価格検証・継続決済・請求書照合・期間末解約のHTTP契約を検証する',async()=>{
  const requests:Array<{url:string;body:URLSearchParams;key:string}>=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;requests.push({url:req.url!,body:new URLSearchParams(raw),key:String(req.headers['idempotency-key']||'')});
    const url=req.url!.split('?')[0];let value:unknown;
    if(url==='/v1/prices/price_billing')value={id:'price_billing',active:true,unit_amount:300,currency:'jpy',recurring:{interval:'month',interval_count:1}};
    else if(url==='/v1/checkout/sessions'&&req.method==='POST')value={id:'cs_billing',url:'https://checkout.stripe.com/billing'};
    else if(url==='/v1/checkout/sessions/cs_billing')value={id:'cs_billing',client_reference_id:'billing_purchase',amount_total:300,currency:'jpy',subscription:{id:'sub_billing',status:'active',cancel_at_period_end:false,items:{data:[{current_period_end:2000000000}]}}};
    else if(url==='/v1/invoices')value={data:[{id:'in_billing',status:'paid',amount_paid:300,currency:'jpy'}],has_more:false};
    else if(url==='/v1/invoice_payments')value={data:[{id:'inpay_billing',payment:{payment_intent:'pi_billing'}}],has_more:false};
    else if(url==='/v1/charges')value={data:[{id:'ch_billing',amount_refunded:0,disputed:false}],has_more:false};
    else if(url==='/v1/subscriptions/sub_billing')value={id:'sub_billing',cancel_at_period_end:true};
    else{res.statusCode=404;value={error:{message:'未定義の模擬経路'}}}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const client=new Stripe('sk_test_billing',{host:'127.0.0.1',port:(server.address() as any).port,protocol:'http',maxNetworkRetries:0});
    const provider=new StripeCommercePayments('sk_test_billing','whsec_billing','http://localhost',false,client);
    const purchase:BillingPurchase={id:'billing_purchase',owner:'seller',makerId:'maker',plan:{id:'plan',name:'合成',priceId:'price_billing',amount:300,currency:'JPY',interval:'month',credits:10,active:true,revision:1},key:'key',fingerprint:'test',state:'pending',cancelAtPeriodEnd:false};
    await provider.billingCheckout(purchase);const request=requests.find(r=>r.url==='/v1/checkout/sessions')!;
    assert.equal(request.body.get('mode'),'subscription');assert.equal(request.body.get('line_items[0][price]'),'price_billing');assert.equal(request.body.get('payment_intent_data[transfer_data][destination]'),null);assert.equal(request.key,'billing:billing_purchase');
    const observed=await provider.billingObserve('cs_billing');assert.equal(observed.paidInvoices[0].id,'in_billing');assert.equal(observed.periodEnd,2000000000);
    await provider.billingCancel('sub_billing','unique');assert.equal(requests.at(-1)!.body.get('cancel_at_period_end'),'true');assert.equal(requests.at(-1)!.key,'billing-cancel:unique');
    await assert.rejects(provider.billingCheckout({...purchase,plan:{...purchase.plan,amount:1}}),{code:'billing_price_mismatch'});
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
});

test('独自ドメインはTLS到達確認後だけ有効とし、解除・移転時は旧接続を除去する',async()=>{
  const f=fixture();try{
    const job=f.service.generation(seller,{makerId:f.maker.id,costLimit:0,items:[{title:'接続試験',slug:'host'}]},'host');await f.service.runGeneration(job.id);
    const site=f.repo.read().sites[0];f.service.markPublished(seller,site.id,1);
    let reachable=false,removes=0,fail=false;
    const provider={ensure:async()=>{},probe:async()=>reachable,remove:async()=>{if(fail)throw new Error('模擬接続障害');removes++}};
    const manager=new CommerceDomainManager(f.service,provider);
    await manager.set(seller,site.id,{name:'maker.example'});
    await assert.rejects(manager.activate(seller,site.id),{code:'domain_ineligible'});
    f.repo.transaction(s=>{s.sites[0].domain!.verified=true});
    assert.equal((await manager.activate(seller,site.id)).certificate,'pending');
    reachable=true;assert.equal((await manager.activate(seller,site.id)).certificate,'active');
    fail=true;await assert.rejects(manager.set(seller,site.id,{release:true}));assert.ok(f.service.site(seller,site.id).domain);
    fail=false;await manager.set(seller,site.id,{release:true});assert.equal(f.service.site(seller,site.id).domain,undefined);assert.equal(removes,1);
    await manager.set(seller,site.id,{name:'maker.example'});f.repo.transaction(s=>{s.sites[0].domain!.verified=true});await manager.activate(seller,site.id);
    const listing=approved(f,{kind:'site',siteId:site.id,license:{scope:'所有権移転',sites:1,resale:true},asset:{version:'1',content:'合成サイト',rights:['コード'],resaleAuthorized:true}});
    await paid(f,listing.id);const transfer=f.repo.read().transfers[0];f.service.transfer(seller,transfer.id,{confirmRights:true});
    const target=f.service.createMaker(buyer,{name:'買主',legalName:'合成',contact:'test',country:'JP'});
    await assert.rejects(manager.acceptTransfer(other,transfer.id,{makerId:target.id}),{statusCode:403});
    await manager.acceptTransfer(buyer,transfer.id,{makerId:target.id});assert.equal(removes,2);assert.equal(f.service.site(buyer,site.id).domain,undefined);
  }finally{f.close()}
});

test('Caddy設定はETag競合を再試行し、他サイトを保護して専用ホストだけを公開する',async()=>{
  let routes:any[]=[{'@id':'existing-site',match:[{host:['existing.example']}]}],revision=0,conflict=true,patches=0;
  const request:typeof fetch=async(input,init)=>{
    const url=String(input);if(url.startsWith('https://')){assert.equal(init?.redirect,'error');return new Response('site:token')}
    if(!init?.method)return new Response(JSON.stringify(routes),{headers:{etag:'"'+revision+'"'}});
    assert.equal(init.method,'PATCH');patches++;assert.equal(new Headers(init.headers).get('if-match'),'"'+revision+'"');
    if(conflict){conflict=false;revision++;routes.push({'@id':'concurrent-site'});return new Response('',{status:412})}
    routes=JSON.parse(String(init.body));revision++;return new Response('');
  };
  const provider=new CaddyCommerceDomains('http://127.0.0.1:2019','/config/apps/http/servers/wentian/routes','127.0.0.1:8787',request);
  const site={id:'site',makerId:'maker',slug:'brand',title:'合成',revision:1,publishedRevision:1,revisions:[],domain:{name:'maker.example',token:'token',verified:true,certificate:'pending' as const}};
  await provider.ensure(site);assert.equal(patches,2);assert.equal(routes.length,3);assert.ok(routes.some(r=>r['@id']==='concurrent-site'));
  assert.deepEqual(routes[0].match,[{host:['maker.example']}]);assert.equal(routes[0].handle[0].routes.at(-1).handle[0].status_code,404);
  await provider.ensure(site);assert.equal(patches,2);assert.equal(await provider.probe(site),true);
  await provider.remove(site);assert.equal(routes.length,2);assert.ok(routes.every(r=>r['@id']!=='wentian-commerce-site'));
  assert.throws(()=>new CaddyCommerceDomains('http://external.example:2019','/config/apps/http/servers/wentian/routes','127.0.0.1:8787'),{code:'invalid_caddy_admin'});
});

test('製造見積の招待・原価内訳・採用・検査・製品化と代替品の人による確認を検証する',()=>{
  const f=fixture();try{
    const supplier=f.service.createMaker(other,{name:'製造者',legalName:'合成製造者',contact:'test',country:'JP'});
    for(const part of syntheticParts())f.service.part(admin,part);
    const build=f.service.build(buyer,syntheticBuild()),quote=f.service.buildQuote(buyer,build.id,{revision:1,supplierMakerIds:[supplier.id]});
    const costs={parts:100,processing:20,assembly:30,inspection:10,packaging:5,shipping:5,tax:0,fees:0};
    assert.throws(()=>f.service.assemblyAnswer(seller,quote.id,{makerId:f.maker.id,costs,currency:'JPY',leadDays:7,expiresAt:'2099-01-01',warranty:'合成'}),{code:'not_invited'});
    const answer=f.service.assemblyAnswer(other,quote.id,{makerId:supplier.id,costs,currency:'JPY',leadDays:7,expiresAt:'2099-01-01',warranty:'検証用保証'});assert.equal(answer.amount,170);
    assert.equal(f.service.dashboard(other).assemblyQuotes.length,1);assert.equal(f.service.dashboard(seller).assemblyQuotes.length,0);
    assert.throws(()=>f.service.acceptAssembly(seller,quote.id,{answerId:answer.id,confirmed:true}),{statusCode:403});
    f.service.acceptAssembly(buyer,quote.id,{answerId:answer.id,confirmed:true});
    assert.throws(()=>f.service.assembledListing(other,quote.id,listingInput(supplier.id)),{code:'inspection_required'});
    f.service.assemblyInspection(other,quote.id,{confirmed:true,report:'合成検査記録'});
    const listing=f.service.assembledListing(other,quote.id,listingInput(supplier.id,{productId:'assembled',model:'assembled',title:'組立済み合成製品'}));
    assert.equal(listing.assembledSpecification?.parts.length,8);assert.equal(listing.warranty,'検証用保証');assert.equal((listing as any).assemblyReference,undefined);
    const stored=f.repo.read().listings.find(l=>l.id===listing.id)!;assert.equal(stored.assemblyReference?.build.owner,'');assert.equal(stored.assemblyReference?.build.budget,0);
    const project=f.service.project(seller,{makerId:f.maker.id,title:'調達',purpose:'試験',quantity:10,budget:1000,deadline:'2099-01-01',bom:[{name:'元部品',quantity:1,unitCost:100,source:'元資料'}]});
    const candidate=f.service.alternative(seller,project.id,{revision:project.revision,original:'元部品',candidate:'候補',unitCost:80,source:'確認資料',note:'供給候補'});
    assert.equal(candidate.bom[0].name,'元部品');assert.equal(candidate.alternatives![0].state,'candidate');
    assert.throws(()=>f.service.alternative(seller,project.id,{revision:candidate.revision,confirmId:candidate.alternatives![0].id,manufacturerConfirmed:false}),{code:'approval_required'});
    const confirmed=f.service.alternative(seller,project.id,{revision:candidate.revision,confirmId:candidate.alternatives![0].id,manufacturerConfirmed:true,note:'製造者が確認'});assert.equal(confirmed.bom[0].name,'候補');
    assert.throws(()=>f.service.quote(seller,project.id,{supplier:'供給先',amount:1,costs,currency:'JPY',moq:1,leadDays:7,expiresAt:'2099-01-01'}),{code:'quote_total_mismatch'});
    const supplied=f.service.quote(seller,project.id,{supplier:'供給先',amount:170,costs,regions:['JP'],currency:'JPY',moq:1,leadDays:7,expiresAt:'2099-01-01'});assert.equal(supplied.costs!.assembly,30);assert.deepEqual(supplied.regions,['JP']);
  }finally{f.close()}
});
