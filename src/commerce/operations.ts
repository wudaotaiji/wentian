import {randomUUID,createHash} from 'node:crypto';
import {MakerWorkspace} from './workspace.js';
import {check,text,type Actor,type Build,type Part,type BenchmarkObservation,type ReconciliationRun} from './model.js';
import {evaluateBuild} from './compatibility.js';

/** 実測資料（Benchmark Observation）は構成と仕様・条件の完全一致でだけ関連付けます。 */
export function benchmarkSignature(build:Build,parts:Part[]){
  return JSON.stringify(build.parts.map(item=>({id:item.id,quantity:item.quantity,spec:parts.find(p=>p.id===item.id)?.spec??null})).sort((a,b)=>a.id.localeCompare(b.id)));
}

/** 照合と実測資料を永続化し、外部の未確認状態を成功へ変換しません。 */
export class CommerceOperations extends MakerWorkspace {
  /** 部品購入（Parts Purchase）は構成版・現価格・全在庫を一つの確定境界で再検証します。 */
  buildOrders(actor:Actor,buildId:string,input:any,key:unknown){
    this.expire();return this.repo.transaction(state=>{
      const requestKey=text(key,'Idempotency-Key',160),fingerprint=createHash('sha256').update(JSON.stringify({buildId,...input})).digest('hex');
      const old=state.buildPurchases?.find(p=>p.owner===actor.id&&p.key===requestKey);
      if(old){check(old.fingerprint===fingerprint,'idempotency_conflict','同じ購入キーの内容が異なります。',409);return {purchase:old,orders:old.orderIds.map(id=>state.orders.find(o=>o.id===id)!)};}
      const build=state.builds.find(b=>b.id===buildId);check(build&&build.owner===actor.id,'forbidden','構成の所有者だけが購入できます。',403);
      check(build.revision===input.revision,'revision_conflict','構成が更新されています。',409);
      const evaluation=evaluateBuild(build,state.parts);
      check(evaluation.status==='compatible','compatibility_unresolved','未解決の互換性を確認してください。',409);
      check(evaluation.dataVersion===input.dataVersion,'specification_changed','部品資料が更新されています。再評価してください。',409);
      check(Array.isArray(input.selections)&&input.selections.length===build.parts.length,'invalid_selection','構成の全部品について出品を選択してください。');
      check(new Set(input.selections.map((s:any)=>s.partId)).size===build.parts.length,'invalid_selection','部品の選択が重複しています。');
      const orders=build.parts.map(part=>{
        const selection=input.selections.find((s:any)=>s.partId===part.id),listing=state.listings.find(l=>l.id===selection?.listingId);
        check(listing&&listing.productId===part.id&&listing.kind==='product','invalid_selection','構成部品と出品が一致しません。');
        const order=this.createOrder(state,actor,{listingId:listing.id,quantity:part.quantity,expectedTotal:selection.expectedTotal,currency:selection.currency,address:input.address,buildReference:{id:build.id,revision:build.revision,ruleVersion:evaluation.ruleVersion,dataVersion:evaluation.dataVersion}},createHash('sha256').update(requestKey+':'+part.id).digest('hex'));
        order.buildReference={id:build.id,revision:build.revision,ruleVersion:evaluation.ruleVersion,dataVersion:evaluation.dataVersion};return order;
      });
      const purchase={id:randomUUID(),owner:actor.id,key:requestKey,fingerprint,buildId,revision:build.revision,orderIds:orders.map(o=>o.id)};
      (state.buildPurchases||=[]).push(purchase);state.audit.push({id:randomUUID(),actor:actor.id,action:'build.orders',entity:purchase.id,at:new Date().toISOString()});
      return {purchase,orders};
    });
  }
  private reconciliationPromise?:Promise<ReconciliationRun>;
  reconcileAll(actor:Actor){
    check(actor.admin,'admin_required','全体照合には運営者権限が必要です。',403);
    if(this.reconciliationPromise)return this.reconciliationPromise;
    const promise=this.runReconciliation(actor).finally(()=>{this.reconciliationPromise=undefined});
    this.reconciliationPromise=promise;return promise;
  }
  private async runReconciliation(actor:Actor){
    check(actor.admin,'admin_required','全体照合には運営者権限が必要です。',403);
    const existing=this.repo.read().reconciliationRuns?.find(r=>r.state==='running');
    if(existing)return this.resumeReconciliation(actor,existing.id);
    const run:ReconciliationRun={id:randomUUID(),startedAt:new Date().toISOString(),state:'running',checked:0,differences:[],failures:[]};
    this.repo.transaction(s=>(s.reconciliationRuns||=[]).push(run));
    return this.resumeReconciliation(actor,run.id);
  }
  private async resumeReconciliation(actor:Actor,runId:string){
    // 再起動後も同じ取引を再照合できます。売上・返金の記帳は既存の冪等処理に委ねます。
    const orders=this.repo.read().orders.filter(o=>o.sessionId);
    for(const order of orders){
      const before={payment:order.payment,refunded:order.refunded,disputed:order.disputed};
      try{
        const observed=await this.reconcile(actor,order.id),after={payment:observed.payment,refunded:observed.refunded,disputed:observed.disputed};
        this.repo.transaction(s=>{const run=s.reconciliationRuns!.find(r=>r.id===runId)!;run.checked++;if(JSON.stringify(before)!==JSON.stringify(after))run.differences.push({orderId:order.id,before,after})});
      }catch(error){
        this.repo.transaction(s=>{const run=s.reconciliationRuns!.find(r=>r.id===runId)!;run.failures.push({orderId:order.id,code:typeof (error as any)?.code==='string'?(error as any).code:'provider_unavailable'})});
      }
    }
    return this.repo.transaction(s=>{const run=s.reconciliationRuns!.find(r=>r.id===runId)!;run.state='completed';run.completedAt=new Date().toISOString();s.audit.push({id:randomUUID(),actor:actor.id,action:run.failures.length?'reconciliation.attention':'reconciliation.complete',entity:run.id,at:run.completedAt});return run});
  }
  reconciliationHistory(actor:Actor){check(actor.admin,'admin_required','照合履歴には運営者権限が必要です。',403);return this.repo.read().reconciliationRuns||[]}
  benchmark(actor:Actor,input:any){
    check(actor.admin,'admin_required','実測資料の登録には運営者権限が必要です。',403);
    const build=this.getBuild(actor,input.buildId);
    check(['fps','ai_tokens_per_second','memory_mb_per_second','storage_mb_per_second','score'].includes(input.metric),'invalid_metric','測定指標を指定してください。');
    check(Number.isFinite(input.low)&&Number.isFinite(input.high)&&input.low>=0&&input.high>=input.low,'invalid_benchmark','測定範囲を確認してください。');
    check(input.conditions&&typeof input.conditions==='object'&&!Array.isArray(input.conditions),'invalid_conditions','測定条件を指定してください。');
    const conditions:Record<string,string>={};for(const [key,value] of Object.entries(input.conditions)){check(Object.keys(conditions).length<20,'invalid_conditions','測定条件は20項目以内です。');conditions[text(key,'条件名',100)]=text(value,'測定条件',1000)}
    const required=input.metric==='fps'?['game','version','resolution','quality','driver']:input.metric==='ai_tokens_per_second'?['model','parameters','quantization','context','batch','runtime','memory']:['tool','version','workload'];
    check(required.every(key=>conditions[key]),'benchmark_conditions_missing','指標に必要な測定条件が不足しています。');
    const source=text(input.source,'出典',2000);check(/^https:\/\//.test(source),'invalid_source','HTTPSの出典を指定してください。');
    check(Number.isFinite(Date.parse(input.measuredAt))&&Date.parse(input.measuredAt)<=Date.now(),'invalid_date','測定日時を確認してください。');
    const observation:BenchmarkObservation={id:randomUUID(),buildSignature:benchmarkSignature(build,this.repo.read().parts),metric:input.metric,low:input.low,high:input.high,conditions,source,measuredAt:input.measuredAt,environment:text(input.environment,'実行環境',2000),methodVersion:text(input.methodVersion,'測定手法の版',150)};
    return this.repo.transaction(s=>{(s.benchmarks||=[]).push(observation);s.audit.push({id:randomUUID(),actor:actor.id,action:'benchmark.register',entity:observation.id,at:new Date().toISOString()});return observation});
  }
  performance(actor:Actor,buildId:string,conditions?:Record<string,string>){
    const build=this.getBuild(actor,buildId),state=this.repo.read(),signature=benchmarkSignature(build,state.parts);
    const observations=(state.benchmarks||[]).filter(b=>b.buildSignature===signature&&(!conditions||Object.entries(conditions).every(([key,value])=>b.conditions[key]===value)));
    return {status:observations.length?'observed':'unavailable',scope:'whole_build',observations,reason:observations.length?'条件別の実測範囲です。条件が異なる結果を合算しません。':'構成・仕様・条件が一致する実測資料はありません。推定値を生成しません。'};
  }
}
