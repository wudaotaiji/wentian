import path from 'node:path';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {CommerceRepository} from './repository.js';
import {CommerceSupply} from './supply.js';
import {ContractPrices} from './prices.js';
import {StripeCommercePayments,type CommercePayments} from './payments.js';
import {check,CommerceError,type Actor} from './model.js';
import {makerAccess} from './service.js';
import {PublicSiteStore,defaultPublicSite,renderPublicHome,validatePublicSite} from '../public-site.js';
import {templateSite} from '../site-templates.js';
import {commerceHtml} from './ui.js';
import {makerLanguages} from '../maker-example.js';
import {evaluateBuild} from './compatibility.js';
import {requiredSitePages,renderSitePage} from './site-content.js';
import {CommerceDomainManager,CaddyCommerceDomains,type CommerceDomainProvider} from './domains.js';

export interface CommerceOptions {workspace:string;identity:(req:FastifyRequest)=>Actor|undefined;payments?:CommercePayments;origin?:string;database?:string;worker?:boolean;domains?:CommerceDomainProvider;planner?:{model:string;generate:(input:unknown)=>Promise<unknown>}}
/** 既存ログイン（Login）へ接続し、公開閲覧と本人の取引操作を明確に分離します。 */
export function registerCommerce(app:FastifyInstance,options:CommerceOptions){
  const repo=new CommerceRepository(options.database||path.join(options.workspace,'.wentian','commerce.sqlite'));
  const payments=options.payments||new StripeCommercePayments(process.env.WENTIAN_STRIPE_SECRET_KEY||'',process.env.WENTIAN_STRIPE_WEBHOOK_SECRET||'',options.origin||process.env.WENTIAN_COMMERCE_ORIGIN||'http://127.0.0.1:8787',process.env.WENTIAN_COMMERCE_ALLOW_LIVE==='true');
  const service=new CommerceSupply(repo,payments),running=new Map<string,Promise<unknown>>();
  const domainProvider=options.domains||(process.env.WENTIAN_COMMERCE_CADDY_ADMIN&&process.env.WENTIAN_COMMERCE_CADDY_ROUTES?new CaddyCommerceDomains(process.env.WENTIAN_COMMERCE_CADDY_ADMIN,process.env.WENTIAN_COMMERCE_CADDY_ROUTES,process.env.WENTIAN_COMMERCE_UPSTREAM||'127.0.0.1:8787'):undefined);
  const domains=new CommerceDomainManager(service,domainProvider);
  const prices=ContractPrices.configured(repo);
  let lastBackup=0,backupError=false;
  const run=(jobId:string)=>{if(running.has(jobId))return running.get(jobId)!;const promise=service.runGeneration(jobId).finally(()=>running.delete(jobId));running.set(jobId,promise);return promise};
  app.get('/commerce',async(_req,reply)=>reply.header('content-security-policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'").type('text/html; charset=utf-8').send(commerceHtml));
  // 公開済みの版だけを返します。下書き更新や差分の本文はこの経路へ出しません。
  app.get('/api/commerce/public-sites/:slug/pages/:page',async(req,reply)=>{
    const params=req.params as {slug:string;page:string};const site=repo.read().sites.find(s=>s.slug===params.slug);
    const revision=site?.revisions.find(r=>r.revision===site.publishedRevision),page=revision?.pages?.[params.page];
    if(!site||!revision||!page?.confirmed)return reply.code(404).send({error:{code:'not_found',message:'公開ページが見つかりません。'}});
    return reply.header('content-security-policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'").type('text/html; charset=utf-8').send(renderSitePage(revision.title,page,'/sites/maker-'+site.slug+'/'));
  });
  app.register(async routes=>{
    const windows=new Map<string,{at:number;count:number}>();
    // 注文の固定スナップショット（Snapshot）には納品物原本を保存しますが、通常応答へ内容を出しません。
    // 成果物の取得は入金・本人・返金を確認する専用entitlement経路だけに限定します。
    routes.addHook('preSerialization',async(_req,_reply,payload)=>{
      const redact=(value:any):any=>{if(Array.isArray(value))return value.map(redact);if(!value||typeof value!=='object')return value;const output={...value};if(output.snapshot?.asset)output.snapshot={...output.snapshot,asset:{version:output.snapshot.asset.version,rights:output.snapshot.asset.rights}};if(output.assemblyReference){const ref=output.assemblyReference;output.assemblyReference={revision:ref.build?.revision,parts:ref.build?.parts,bom:ref.bom,inspectionConfirmed:true}}for(const key of Object.keys(output))output[key]=redact(output[key]);return output};
      return redact(payload);
    });
    routes.setErrorHandler((error,req,reply)=>{const known=error instanceof CommerceError;const identity=options.identity(req);repo.transaction(s=>s.audit.push({id:req.id,actor:identity?.id||'anonymous',action:'request.error.'+(known?error.code:'invalid_request'),entity:req.routeOptions.url||'unknown',at:new Date().toISOString()}));reply.code(known?error.statusCode:400).send({error:{code:known?error.code:'invalid_request',message:known?error.message:'要求を処理できません。入力または接続設定を確認してください。',traceId:req.id}})});
    routes.addHook('preHandler',async(req,reply)=>{const actor=options.identity(req);const key=actor?.id||req.ip;let rate=windows.get(key);if(!rate||Date.now()-rate.at>60000){rate={at:Date.now(),count:0};windows.set(key,rate)}check(++rate.count<=120,'rate_limited','操作回数の上限です。時間をおいてください。',429);if(windows.size>10000)for(const [key,value] of windows)if(Date.now()-value.at>60000)windows.delete(key);
      if(!['GET','HEAD'].includes(req.method)&&req.headers.origin)check(req.headers.origin===(options.origin||`${req.protocol}://${req.headers.host}`),'origin_forbidden','同一サイトから操作してください。',403);
      if(!['/api/commerce/catalog','/api/commerce/parts','/api/commerce/compatibility.js'].includes(req.url.split('?')[0])&&!/^\/api\/commerce\/products\/[^/]+\/offers$/.test(req.url.split('?')[0])&&!(req.method==='GET'&&/^\/api\/commerce\/pc-builds\/[^/]+$/.test(req.url.split('?')[0])))check(actor,'authentication_required','ログインが必要です。',401);
    });
    const actor=(req:FastifyRequest)=>{const identity=options.identity(req);check(identity,'authentication_required','ログインが必要です。',401);return identity};
    const body=(req:FastifyRequest)=>req.body as any;
    const param=(req:FastifyRequest,key='id')=>(req.params as Record<string,string>)[key];
    routes.get('/api/commerce/catalog',()=>({listings:service.catalog()}));
    // 同じ純粋関数（Pure Function）をブラウザーにも配信し、配置時は通信なしで即時評価します。
    // __nameはtsxが付与する関数名補助です。ルール・入力データ・秘密情報には介入しません。
    routes.get('/api/commerce/compatibility.js',(_req,reply)=>reply.type('text/javascript; charset=utf-8').header('cache-control','no-store').send(`const __name=(fn)=>fn; export const evaluateBuild=${evaluateBuild.toString()};`));
    routes.get('/api/commerce/dashboard',req=>service.dashboard(actor(req)));
    routes.post('/api/commerce/makers',req=>service.createMaker(actor(req),body(req)));
    routes.put('/api/commerce/makers/:id/members',req=>service.members(actor(req),param(req),body(req)));
    routes.put('/api/commerce/makers/:id/policy',req=>service.policy(actor(req),param(req),body(req)));
    routes.post('/api/commerce/makers/:id/payment-account',req=>service.connectSeller(actor(req),param(req),body(req)));
    routes.put('/api/commerce/billing/plans',req=>service.saveBillingPlan(actor(req),body(req)));
    routes.get('/api/commerce/billing/makers/:id',req=>service.billingOverview(actor(req),param(req)));
    routes.post('/api/commerce/billing/purchases',req=>service.billingCheckout(actor(req),body(req),req.headers['idempotency-key']));
    routes.post('/api/commerce/billing/purchases/:id/reconcile',req=>service.reconcileBilling(actor(req),param(req)));
    routes.post('/api/commerce/billing/purchases/:id/cancel',req=>service.cancelBilling(actor(req),param(req)));
    routes.post('/api/commerce/projects',req=>service.project(actor(req),body(req)));
    routes.put('/api/commerce/projects/:id',req=>service.project(actor(req),body(req),param(req)));
    routes.post('/api/commerce/projects/:id/plan',req=>{check(options.planner,'planner_unconfigured','企画支援のモデルが未設定です。',503);return service.planProject(actor(req),param(req),options.planner.model,options.planner.generate)});
    routes.post('/api/commerce/projects/:id/quotes',req=>service.quote(actor(req),param(req),body(req)));
    routes.post('/api/commerce/projects/:id/manufacture',req=>service.manufacture(actor(req),param(req),body(req)));
    routes.post('/api/commerce/projects/:id/alternatives',req=>service.alternative(actor(req),param(req),body(req)));
    routes.get('/api/commerce/partners',()=>({partners:service.partners()}));
    routes.post('/api/commerce/generation-jobs',async req=>{const job=service.generation(actor(req),body(req),req.headers['idempotency-key']);void run(job.id).catch(()=>undefined);return job});
    routes.get('/api/commerce/generation-jobs/:id',req=>service.job(actor(req),param(req)));
    routes.post('/api/commerce/generation-jobs/:id/retry',async req=>{const job=service.retryGeneration(actor(req),param(req));void run(job.id).catch(()=>undefined);return job});
    routes.get('/api/commerce/sites/:id',req=>service.site(actor(req),param(req)));
    routes.put('/api/commerce/sites/:id',req=>service.editSite(actor(req),param(req),body(req)));
    routes.put('/api/commerce/sites/:id/pages',req=>service.sitePages(actor(req),param(req),body(req)));
    routes.get('/api/commerce/sites/:id/diff',req=>{const query=req.query as {from:string;to:string};return service.siteDiff(actor(req),param(req),Number(query.from),Number(query.to))});
    const siteContent=(site:ReturnType<typeof service.site>)=>{
      const content=site.revisions.find(r=>r.revision===site.revision)!,template=templateSite('maker-atelier',defaultPublicSite,content.title);
      const esc=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
      // 編集した既定言語の内容を実際のHTMLへ反映し、他言語の翻訳を保持します。
      template.customHtml=template.customHtml.replace(makerLanguages['zh-CN'].hero,esc(content.headline).replaceAll('\n','<br>')).replace(makerLanguages['zh-CN'].intro,esc(content.introduction));
      const pageLinks=requiredSitePages.map(slug=>'<a href="/api/commerce/public-sites/'+esc(site.slug)+'/pages/'+slug+'">'+esc(content.pages?.[slug]?.title||slug)+'</a>').join(' · ');
      template.customHtml=template.customHtml.replace('</body>','<nav style="padding:30px;text-align:center" aria-label="Site pages">'+pageLinks+'</nav></body>');
      return validatePublicSite({...template,headline:content.headline,introduction:content.introduction});
    };
    routes.get('/api/commerce/sites/:id/preview',async(req,reply)=>reply.type('text/html; charset=utf-8').send(renderPublicHome(siteContent(service.site(actor(req),param(req))),[],'',false)));
    routes.post('/api/commerce/sites/:id/publish',async req=>{const identity=actor(req),site=service.site(identity,param(req));makerAccess(repo.read(),identity,site.makerId);check(body(req)?.approved===true,'approval_required','公開内容を確認してください。');check(site.revision===body(req).revision,'revision_conflict','サイトが更新されています。',409);const revision=site.revisions.find(r=>r.revision===site.revision)!;check(requiredSitePages.every(slug=>revision.pages?.[slug]?.confirmed),'pages_unconfirmed','必須ページの内容・権利・販売条件を確認してください。',409);const store=new PublicSiteStore(options.workspace,'maker-'+site.slug);const existing=await store.load();check(existing.revision===0||existing.commerceSiteId===site.id,'public_page_owned','この公開URLは他のページが使用しています。',409);await store.save({...siteContent(site),commerceSiteId:site.id,revision:existing.revision});service.markPublished(identity,site.id,site.revision);return {href:'/sites/maker-'+site.slug+'/',revision:site.revision}});
    routes.post('/api/commerce/sites/:id/domain',req=>domains.set(actor(req),param(req),body(req)));
    routes.post('/api/commerce/sites/:id/domain/verify',req=>domains.verify(actor(req),param(req)));
    routes.post('/api/commerce/sites/:id/domain/activate',req=>domains.activate(actor(req),param(req)));
    routes.post('/api/commerce/listings',req=>service.listing(actor(req),body(req)));
    routes.put('/api/commerce/listings/:id',req=>service.updateListing(actor(req),param(req),body(req)));
    routes.post('/api/commerce/listings/:id/reports',req=>service.report(actor(req),param(req),body(req)));
    routes.post('/api/commerce/listings/:id/moderate',req=>service.moderate(actor(req),param(req),body(req)));
    routes.get('/api/commerce/products/:id/offers',req=>({groups:service.offers(param(req)),externalGroups:prices.offers(param(req))}));
    routes.post('/api/commerce/price-sources/:id/refresh',req=>prices.refresh(actor(req),param(req)));
    routes.post('/api/commerce/orders',req=>service.order(actor(req),body(req),req.headers['idempotency-key']));
    routes.get('/api/commerce/orders/:id',req=>service.getOrder(actor(req),param(req)));
    routes.post('/api/commerce/orders/:id/checkout',req=>service.checkout(actor(req),param(req)));
    routes.post('/api/commerce/orders/:id/reconcile',req=>service.reconcile(actor(req),param(req)));
    routes.post('/api/commerce/orders/:id/advance',req=>service.advance(actor(req),param(req),body(req)));
    routes.post('/api/commerce/orders/:id/refund-requests',req=>service.refundRequest(actor(req),param(req),body(req),req.headers['idempotency-key']));
    routes.post('/api/commerce/refunds/:id/execute',req=>service.executeRefund(actor(req),param(req)));
    routes.get('/api/commerce/orders/:id/entitlement',req=>service.entitlement(actor(req),param(req)));
    routes.get('/api/commerce/seller/balance',req=>service.balance(actor(req),String((req.query as any).makerId||'')));
    routes.get('/api/commerce/seller/payouts',req=>service.payouts(actor(req),String((req.query as any).makerId||'')));
    routes.post('/api/commerce/site-transfers/:id/deliver',req=>service.transfer(actor(req),param(req),body(req)));
    routes.post('/api/commerce/site-transfers/:id/accept',req=>domains.acceptTransfer(actor(req),param(req),body(req)));
    routes.get('/api/commerce/parts',()=>({parts:repo.read().parts}));
    routes.post('/api/commerce/parts',req=>service.part(actor(req),body(req)));
    routes.post('/api/commerce/pc-builds',req=>service.build(actor(req),body(req)));
    routes.put('/api/commerce/pc-builds/:id',req=>service.build(actor(req),body(req),param(req)));
    routes.get('/api/commerce/pc-builds/:id',req=>{const build=service.getBuild(options.identity(req)||{id:'anonymous'},param(req));const {owner,...shared}=build;return options.identity(req)?.id===owner?build:shared});
    routes.post('/api/commerce/pc-builds/:id/evaluate',req=>service.evaluate(actor(req),param(req)));
    routes.get('/api/commerce/pc-builds/:id/offers',req=>service.buildOffers(actor(req),param(req)));
    routes.post('/api/commerce/pc-builds/:id/quote-requests',req=>service.buildQuote(actor(req),param(req),body(req)));
    routes.post('/api/commerce/pc-builds/:id/orders',req=>service.buildOrders(actor(req),param(req),body(req),req.headers['idempotency-key']));
    routes.post('/api/commerce/assembly-quotes/:id/answers',req=>service.assemblyAnswer(actor(req),param(req),body(req)));
    routes.post('/api/commerce/assembly-quotes/:id/accept',req=>service.acceptAssembly(actor(req),param(req),body(req)));
    routes.post('/api/commerce/assembly-quotes/:id/inspection',req=>service.assemblyInspection(actor(req),param(req),body(req)));
    routes.post('/api/commerce/assembly-quotes/:id/listing',req=>service.assembledListing(actor(req),param(req),body(req)));
    routes.get('/api/commerce/pc-builds/:id/performance',req=>service.performance(actor(req),param(req)));
    routes.post('/api/commerce/benchmarks',req=>service.benchmark(actor(req),body(req)));
    routes.post('/api/commerce/operations/reconcile-all',req=>service.reconcileAll(actor(req)));
    routes.get('/api/commerce/operations/reconciliations',req=>({runs:service.reconciliationHistory(actor(req))}));
    routes.post('/api/commerce/operations/reprocess',async req=>{check(actor(req).admin,'admin_required','運営権限が必要です。',403);return {pending:await service.processEvents()}});
    routes.get('/api/commerce/audit',req=>{check(actor(req).admin,'admin_required','運営権限が必要です。',403);return {events:repo.read().events,audit:repo.read().audit}});
    routes.get('/api/commerce/operations/health',req=>{check(actor(req).admin,'admin_required','運営権限が必要です。',403);const s=repo.read();return {paymentMode:payments.mode,generated:s.jobs.flatMap(j=>j.items).filter(i=>i.state==='draft_ready').length,generationFailures:s.jobs.flatMap(j=>j.items).filter(i=>i.state==='failed').length,pendingEvents:s.events.filter(e=>e.state!=='processed').length,pendingRefunds:s.refunds.filter(r=>r.state==='requested'||r.state==='processing').length,disputes:s.orders.filter(o=>o.disputed).length,inventoryConflicts:s.audit.filter(a=>a.action==='request.error.out_of_stock').length,lastBackup:lastBackup?new Date(lastBackup).toISOString():null,backupError,observedAt:new Date().toISOString()}});
  });
  // 生の本文（Raw Body）はこの経路だけで保持し、JSON変換前にStripeの署名を検証します。
  app.register(async webhook=>{webhook.removeContentTypeParser('application/json');webhook.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:1024*1024},(_req,body,done)=>done(null,body));webhook.post('/api/commerce/payment-webhooks/stripe',async(req,reply)=>{try{const event=service.receive(req.body as Buffer,String(req.headers['stripe-signature']||''));return reply.code(202).send({id:event.id,state:event.state})}catch(error){return reply.code(error instanceof CommerceError?error.statusCode:400).send({error:{code:'webhook_rejected',message:'決済イベントを検証できません。',traceId:req.id}})}})});
  let busy=false;const tick=async()=>{if(busy)return;busy=true;try{
    service.expire();await service.processEvents();
    await domains.tick();
    for(const purchase of repo.read().billingPurchases||[])if(purchase.sessionId&&(!purchase.observedAt||Date.now()-Date.parse(purchase.observedAt)>60_000)){
      try{await service.reconcileBilling({id:'commerce-billing-worker',admin:true},purchase.id)}catch{/* 次の処理周期で再照合し、利用権を先に付与しません。 */}
    }
    // 日次照合（Daily Reconciliation）はWebhookの有無に依存せず、全決済参照を照会します。
    const latest=repo.read().reconciliationRuns?.at(-1);
    if(payments.mode!=='unconfigured'&&(!latest||latest.state==='running'||Date.now()-Date.parse(latest.startedAt)>=24*60*60_000))await service.reconcileAll({id:'commerce-reconciliation-worker',admin:true});
    for(const job of repo.read().jobs)if(job.items.some(i=>['queued','generating','validating'].includes(i.state)))await run(job.id);
    // バックアップ（Backup）は10分間隔。失敗は運営状態へ残し、既存コピーを削除しません。
    if(options.database!==':memory:'&&Date.now()-lastBackup>10*60_000){try{repo.backup(path.join(options.workspace,'.wentian','commerce-backups',new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite'));lastBackup=Date.now();backupError=false}catch{backupError=true}}
  }finally{busy=false}};
  const timer=options.worker===false?undefined:setInterval(()=>void tick().catch(()=>undefined),5000);timer?.unref();
  app.addHook('onClose',async()=>{if(timer)clearInterval(timer);await Promise.allSettled(running.values());while(busy)await new Promise(resolve=>setTimeout(resolve,10));repo.close()});
  return {service,repo,tick};
}
