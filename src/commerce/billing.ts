import {createHash,randomUUID} from 'node:crypto';
import {CommerceOperations} from './operations.js';
import {makerAccess} from './service.js';
import {check,text,integer,type Actor,type BillingPlan,type BillingPurchase,type CommerceState} from './model.js';

/** 運営利用料（Platform Billing）は販売者の売上と台帳を分離します。 */
export class CommerceBilling extends CommerceOperations {
  saveBillingPlan(actor:Actor,input:any){
    check(actor.admin,'admin_required','料金設定には運営者権限が必要です。',403);
    check(/^price_[A-Za-z0-9]+$/.test(input.priceId),'invalid_price','Stripeの価格IDを指定してください。');
    check(/^[A-Z]{3}$/.test(input.currency)&&['once','month','year'].includes(input.interval),'invalid_plan','通貨と課金周期を確認してください。');
    return this.repo.transaction(state=>{const id=text(input.id,'料金プランID',100),old=state.billingPlans?.find(p=>p.id===id);if(old)check(old.revision===input.revision,'revision_conflict','料金設定が更新されています。',409);
      const plan:BillingPlan={id,name:text(input.name,'料金名',150),priceId:input.priceId,amount:integer(input.amount,'利用料',1),currency:input.currency,interval:input.interval,credits:integer(input.credits,'生成枠',0,100000),active:input.active===true,revision:(old?.revision||0)+1};
      if(old)state.billingPlans![state.billingPlans!.indexOf(old)]=plan;else (state.billingPlans||=[]).push(plan);
      state.audit.push({id:randomUUID(),actor:actor.id,action:'billing.plan',entity:id,at:new Date().toISOString()});return plan;});
  }
  billingOverview(actor:Actor,makerId:string){const state=this.repo.read();makerAccess(state,actor,makerId,false);return {plans:(state.billingPlans||[]).filter(p=>p.active),purchases:(state.billingPurchases||[]).filter(p=>p.makerId===makerId),credits:this.creditBalance(state,makerId),entries:(state.generationCredits||[]).filter(c=>c.makerId===makerId)}}
  private creditBalance(state:CommerceState,makerId:string){return (state.generationCredits||[]).filter(c=>c.makerId===makerId).reduce((sum,c)=>sum+c.units,0)}
  async billingCheckout(actor:Actor,input:any,key:unknown){
    check(this.payments.billingCheckout,'billing_unconfigured','利用料の決済が未接続です。',503);
    const requestKey=text(key,'Idempotency-Key',160),fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const purchase=this.repo.transaction(state=>{const maker=makerAccess(state,actor,input.makerId);check(maker.owner===actor.id,'forbidden','事業所有者が申し込んでください。',403);
      const old=state.billingPurchases?.find(p=>p.owner===actor.id&&p.key===requestKey);if(old){check(old.fingerprint===fingerprint,'idempotency_conflict','同じ利用料キーの内容が異なります。',409);return old}
      const plan=state.billingPlans?.find(p=>p.id===input.planId&&p.active);check(plan,'plan_unavailable','この料金プランは利用できません。',409);check(input.expectedAmount===plan.amount&&input.currency===plan.currency&&input.revision===plan.revision,'billing_price_changed','料金が変わりました。再確認してください。',409);
      const value:BillingPurchase={id:randomUUID(),owner:actor.id,makerId:maker.id,plan:structuredClone(plan),key:requestKey,fingerprint,state:'pending',cancelAtPeriodEnd:false};(state.billingPurchases||=[]).push(value);return value;});
    if(purchase.sessionId)return {id:purchase.sessionId,url:purchase.url,purchaseId:purchase.id};
    const checkout=await this.payments.billingCheckout(purchase);return this.repo.transaction(state=>{const current=state.billingPurchases!.find(p=>p.id===purchase.id)!;check(!current.sessionId||current.sessionId===checkout.id,'checkout_conflict','利用料の決済参照が競合しています。',409);current.sessionId=checkout.id;current.url=checkout.url;return {...checkout,purchaseId:current.id}});
  }
  async reconcileBilling(actor:Actor,purchaseId:string){
    const state=this.repo.read(),purchase=state.billingPurchases?.find(p=>p.id===purchaseId);check(purchase,'not_found','利用料契約が見つかりません。',404);makerAccess(state,actor,purchase.makerId,false);
    check(purchase.sessionId&&this.payments.billingObserve,'billing_unconfigured','利用料の決済照合が未接続です。',503);const observed=await this.payments.billingObserve(purchase.sessionId);
    check(observed.id===purchase.sessionId&&observed.purchaseId===purchase.id&&observed.amount===purchase.plan.amount&&observed.currency===purchase.plan.currency,'billing_mismatch','利用料の決済内容が一致しません。',409);
    return this.repo.transaction(state=>{const current=state.billingPurchases!.find(p=>p.id===purchaseId)!;current.state=observed.state;current.subscriptionId=observed.subscriptionId;current.cancelAtPeriodEnd=observed.cancelAtPeriodEnd;current.periodEnd=observed.periodEnd;current.observedAt=new Date().toISOString();
      for(const invoice of observed.paidInvoices){
        check(invoice.amount===current.plan.amount&&invoice.currency===current.plan.currency,'invoice_mismatch','更新請求の金額が料金規則と一致しません。',409);
        const grant=state.generationCredits?.find(c=>c.purchaseId===current.id&&c.invoiceId===invoice.id&&c.units>=0);
        if(!invoice.refunded&&!grant)(state.generationCredits||=[]).push({id:randomUUID(),makerId:current.makerId,purchaseId:current.id,invoiceId:invoice.id,units:current.plan.credits,at:current.observedAt});
        if(invoice.refunded&&grant&&!state.generationCredits?.some(c=>c.invoiceId===invoice.id&&c.units<0&&!c.jobId))(state.generationCredits||=[]).push({id:randomUUID(),makerId:current.makerId,purchaseId:current.id,invoiceId:invoice.id,units:-grant.units,at:current.observedAt});
      }
      return current;
    });
  }
  async cancelBilling(actor:Actor,purchaseId:string){const purchase=this.repo.read().billingPurchases?.find(p=>p.id===purchaseId);check(purchase,'not_found','利用料契約が見つかりません。',404);check(purchase.owner===actor.id,'forbidden','申込者だけが解約できます。',403);check(purchase.subscriptionId&&this.payments.billingCancel,'subscription_missing','継続契約が確認できません。',409);await this.payments.billingCancel(purchase.subscriptionId,purchase.id);return this.reconcileBilling(actor,purchaseId)}
  /** 生成枠（Generation Credits）はジョブ作成と同じ取引内で一度だけ消費します。 */
  override generation(actor:Actor,input:any,key:unknown){return this.repo.transaction(state=>{
    const job=this.createGeneration(state,actor,input,key);
    if(input.useCredits===true&&!state.generationCredits?.some(c=>c.jobId===job.id)){
      const units=job.items.length;check(this.creditBalance(state,job.makerId)>=units,'credits_insufficient','生成枠が不足しています。',409);
      (state.generationCredits||=[]).push({id:randomUUID(),makerId:job.makerId,jobId:job.id,units:-units,at:new Date().toISOString()});job.creditUnits=units;
    }return job;
  })}
}
