import Stripe from 'stripe';
import {check,type Order,type Maker,type BillingPurchase,type BillingPlan} from './model.js';
export interface BillingObservation {id:string;purchaseId:string;amount:number;currency:string;state:'pending'|'active'|'past_due'|'cancelled';subscriptionId?:string;invoiceId?:string;cancelAtPeriodEnd:boolean;periodEnd?:number;paidInvoices:Array<{id:string;amount:number;currency:string;refunded:boolean}>}
export interface CommercePayments {billingCheckout?(purchase:BillingPurchase):Promise<{id:string;url:string}>;billingObserve?(sessionId:string):Promise<BillingObservation>;billingCancel?(subscriptionId:string,key:string):Promise<void>}

export interface PaymentObservation {id:string;orderId:string;amount:number;currency:string;paid:boolean;refunded:number;disputed:boolean;paymentIntent:string;refunds:Array<{id:string;amount:number;state:string}>;transferred?:number;transferReversed?:number;feeRefunded?:number}
export interface PaymentObservation {providerCosts?:Array<{id:string;amount:number;currency:string}>}
export interface CommercePayments {mode:'stripe-test'|'stripe-live'|'unconfigured'|'simulated';checkout(order:Order,maker:Maker):Promise<{id:string;url:string}>;observe(sessionId:string):Promise<PaymentObservation>;refund(order:Order,amount:number,key:string):Promise<{id:string;state:string}>;verify(raw:Buffer,signature:string):{id:string;type:string;objectId:string};account(id:string):Promise<{chargesEnabled:boolean}>;payouts?(accountId:string):Promise<Array<{id:string;amount:number;currency:string;status:string;arrivalDate:number}>>}

/** Stripe公式SDKを使用し、カード番号を取得せずホスト型決済（Hosted Checkout）へ接続します。 */
export class StripeCommercePayments implements CommercePayments {
  readonly mode:CommercePayments['mode'];
  private stripe?:Stripe;
  constructor(private key:string,private secret:string,private origin:string,allowLive=false,client?:Stripe){
    this.mode=!key?'unconfigured':key.startsWith('sk_test_')?'stripe-test':'stripe-live';
    check(this.mode!=='stripe-live'||allowLive,'live_disabled','本番決済は明示設定が必要です。',503);
    if(key)this.stripe=client||new Stripe(key,{maxNetworkRetries:2,timeout:20000});
  }
  private client(){check(this.stripe,'payments_unconfigured','決済事業者の認証情報が未設定です。',503);return this.stripe}
  async checkout(order:Order,maker:Maker){
    check(maker.stripeAccount&&maker.chargesEnabled&&!maker.suspended,'seller_unverified','販売者の決済確認が未完了です。',409);
    const account=await this.account(maker.stripeAccount);check(account.chargesEnabled,'seller_unverified','販売者の決済権限が無効です。',409);
    const session=await this.client().checkout.sessions.create({mode:'payment',client_reference_id:order.id,success_url:this.origin+'/commerce?order='+encodeURIComponent(order.id),cancel_url:this.origin+'/commerce?order='+encodeURIComponent(order.id),line_items:[{price_data:{currency:order.currency.toLowerCase(),unit_amount:order.amount,product_data:{name:order.snapshot.title}},quantity:1}],metadata:{orderId:order.id},payment_intent_data:{metadata:{orderId:order.id},application_fee_amount:order.fee,transfer_data:{destination:maker.stripeAccount}}},{idempotencyKey:'checkout:'+order.id});
    check(session.url,'checkout_unavailable','決済URLを取得できません。',502);return {id:session.id,url:session.url};
  }
  async account(id:string){const account=await this.client().accounts.retrieve(id);return {chargesEnabled:account.charges_enabled===true&&account.payouts_enabled===true&&account.details_submitted===true}}
  async observe(sessionId:string):Promise<PaymentObservation>{
    const session=await this.client().checkout.sessions.retrieve(sessionId,{expand:['payment_intent']});
    const pi=session.payment_intent;const paymentIntent=typeof pi==='string'?pi:pi?.id||'';
    const charges=paymentIntent?await this.client().charges.list({payment_intent:paymentIntent,limit:100}):{data:[]};
    const refunds=paymentIntent?await this.client().refunds.list({payment_intent:paymentIntent,limit:100}):{data:[]};
    let transferred=0,transferReversed=0,feeRefunded=0;const providerCosts:NonNullable<PaymentObservation['providerCosts']>=[];
    for(const charge of charges.data){
      if(charge.transfer){const transfer=typeof charge.transfer==='string'?await this.client().transfers.retrieve(charge.transfer):charge.transfer;transferred+=transfer.amount;transferReversed+=transfer.amount_reversed}
      if(charge.application_fee){const fee=typeof charge.application_fee==='string'?await this.client().applicationFees.retrieve(charge.application_fee):charge.application_fee;feeRefunded+=fee.amount_refunded}
      if(charge.balance_transaction){const transaction=typeof charge.balance_transaction==='string'?await this.client().balanceTransactions.retrieve(charge.balance_transaction):charge.balance_transaction;providerCosts.push({id:transaction.id,amount:transaction.fee,currency:transaction.currency.toUpperCase()})}
    }
    return {id:session.id,orderId:session.client_reference_id||'',amount:session.amount_total||0,currency:(session.currency||'').toUpperCase(),paid:session.payment_status==='paid',refunded:charges.data.reduce((n,c)=>n+c.amount_refunded,0),disputed:charges.data.some(c=>c.disputed),paymentIntent,refunds:refunds.data.map(r=>({id:r.id,amount:r.amount,state:r.status||'pending'})),transferred,transferReversed,feeRefunded,providerCosts};
  }
  async refund(order:Order,amount:number,key:string){check(order.paymentIntent,'payment_missing','入金参照がありません。',409);const refund=await this.client().refunds.create({payment_intent:order.paymentIntent,amount,reverse_transfer:true,refund_application_fee:true},{idempotencyKey:'refund:'+key});return {id:refund.id,state:refund.status||'pending'}}
  async payouts(accountId:string){const payouts=await this.client().payouts.list({limit:100},{stripeAccount:accountId});return payouts.data.map(p=>({id:p.id,amount:p.amount,currency:p.currency.toUpperCase(),status:p.status,arrivalDate:p.arrival_date}))}
  private async billingPrice(plan:BillingPlan){
    const price=await this.client().prices.retrieve(plan.priceId);
    check(price.active&&price.unit_amount===plan.amount&&price.currency.toUpperCase()===plan.currency&&(plan.interval==='once'?!price.recurring:price.recurring?.interval===plan.interval&&price.recurring.interval_count===1),'billing_price_mismatch','運営料金とStripeの価格が一致しません。',409);
  }
  async billingCheckout(purchase:BillingPurchase){
    await this.billingPrice(purchase.plan);
    const metadata={billingPurchaseId:purchase.id,makerId:purchase.makerId};
    const session=await this.client().checkout.sessions.create({mode:purchase.plan.interval==='once'?'payment':'subscription',client_reference_id:purchase.id,success_url:this.origin+'/commerce?billing='+encodeURIComponent(purchase.id),cancel_url:this.origin+'/commerce?billing='+encodeURIComponent(purchase.id),line_items:[{price:purchase.plan.priceId,quantity:1}],metadata,...(purchase.plan.interval==='once'?{payment_intent_data:{metadata}}:{subscription_data:{metadata}})},{idempotencyKey:'billing:'+purchase.id});
    check(session.url,'checkout_unavailable','利用料の決済URLを取得できません。',502);return {id:session.id,url:session.url};
  }
  async billingObserve(sessionId:string):Promise<BillingObservation>{
    const client=this.client(),session=await client.checkout.sessions.retrieve(sessionId,{expand:['subscription']});
    const subscription=typeof session.subscription==='string'?await client.subscriptions.retrieve(session.subscription):session.subscription;
    const paidInvoices:BillingObservation['paidInvoices']=[];
    if(subscription){
      // 複数更新分のイベントが欠落しても、全請求書をページ送りで復元します。
      for await(const invoice of client.invoices.list({subscription:subscription.id,limit:100})){
        if(invoice.status!=='paid')continue;let refunded=false;
        for await(const payment of client.invoicePayments.list({invoice:invoice.id,limit:100})){
          const intent=payment.payment.payment_intent;const intentId=typeof intent==='string'?intent:intent?.id;
          if(intentId)for await(const charge of client.charges.list({payment_intent:intentId,limit:100}))if(charge.amount_refunded>0||charge.disputed)refunded=true;
        }
        paidInvoices.push({id:invoice.id,amount:invoice.amount_paid,currency:invoice.currency.toUpperCase(),refunded});
      }
    }else if(session.payment_status==='paid'){
      const intent=session.payment_intent,intentId=typeof intent==='string'?intent:intent?.id;let refunded=false;
      if(intentId)for await(const charge of client.charges.list({payment_intent:intentId,limit:100}))if(charge.amount_refunded>0||charge.disputed)refunded=true;
      paidInvoices.push({id:session.id,amount:session.amount_total||0,currency:(session.currency||'').toUpperCase(),refunded});
    }
    const state:BillingObservation['state']=subscription?(subscription.status==='active'?'active':['past_due','unpaid','incomplete','paused'].includes(subscription.status)?'past_due':subscription.status==='trialing'?'pending':'cancelled'):session.payment_status==='paid'?(paidInvoices.some(i=>i.refunded)?'cancelled':'active'):session.status==='expired'?'cancelled':'pending';
    return {id:session.id,purchaseId:session.client_reference_id||'',amount:session.amount_total||0,currency:(session.currency||'').toUpperCase(),state,subscriptionId:subscription?.id,invoiceId:paidInvoices.at(0)?.id,cancelAtPeriodEnd:subscription?.cancel_at_period_end||false,periodEnd:subscription?Math.max(0,...subscription.items.data.map(item=>item.current_period_end)):undefined,paidInvoices};
  }
  async billingCancel(subscriptionId:string,key:string){await this.client().subscriptions.update(subscriptionId,{cancel_at_period_end:true},{idempotencyKey:'billing-cancel:'+key})}
  verify(raw:Buffer,signature:string){check(this.secret,'webhook_unconfigured','Webhook署名鍵が未設定です。',503);const event=this.client().webhooks.constructEvent(raw,signature,this.secret,300);check(event.livemode===(this.mode==='stripe-live'),'environment_mismatch','決済環境が一致しません。');const object=event.data.object as {id:string};return {id:event.id,type:event.type,objectId:object.id}}
}
