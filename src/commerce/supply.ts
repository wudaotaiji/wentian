import {randomUUID} from 'node:crypto';
import {CommerceBilling} from './billing.js';
import {makerAccess} from './service.js';
import {evaluateBuild} from './compatibility.js';
import {check,text,integer,type Actor,type AssemblyQuote,type CostBreakdown,type AssemblyAnswer} from './model.js';

/** 原価内訳（Cost Breakdown）は不明費用を暗黙のゼロへ変換しません。 */
export function costBreakdown(input:any):CostBreakdown{
  const costs={} as CostBreakdown;
  for(const key of ['parts','processing','assembly','inspection','packaging','shipping','tax','fees'] as const)costs[key]=integer(input?.[key],key);
  integer(Object.values(costs).reduce((sum,n)=>sum+n,0),'原価合計');return costs;
}

/** 製造者への招待・回答・検査・製品化を、人による確認の工程として管理します。 */
export class CommerceSupply extends CommerceBilling {
  override quote(actor:Actor,projectId:string,input:any){
    const costs=input.costs?costBreakdown(input.costs):undefined;if(costs)check(Object.values(costs).reduce((sum,n)=>sum+n,0)===input.amount,'quote_total_mismatch','原価内訳と見積総額が一致しません。');
    const regions=input.regions===undefined?[]:input.regions;check(Array.isArray(regions)&&regions.length<=50&&regions.every((r:unknown)=>typeof r==='string'&&/^[A-Z]{2}$/.test(r)),'invalid_regions','供給対象国を指定してください。');
    const answer=super.quote(actor,projectId,input);return this.repo.transaction(state=>{const quote=state.projects.find(p=>p.id===projectId)!.quotes.find(q=>q.id===answer.id)!;quote.costs=costs;quote.regions=regions;quote.receivedAt=new Date().toISOString();return quote});
  }
  partners(){return this.repo.read().makers.filter(m=>!m.suspended).map(m=>({id:m.id,name:m.name,country:m.country}))}
  override dashboard(actor:Actor){const dashboard=super.dashboard(actor),state=this.repo.read(),ids=new Set(dashboard.makers.map(m=>m.id));return {...dashboard,billingPlans:actor.admin?state.billingPlans||[]:undefined,assemblyQuotes:state.quotes.filter(q=>q.owner===actor.id||q.supplierMakerIds?.some(id=>ids.has(id)))}}
  override buildQuote(actor:Actor,buildId:string,input:any){return this.repo.transaction(state=>{
    const build=state.builds.find(b=>b.id===buildId);check(build&&build.owner===actor.id,'forbidden','構成の所有者だけが依頼できます。',403);check(build.revision===input.revision,'revision_conflict','構成が更新されています。',409);
    const evaluation=evaluateBuild(build,state.parts);check(evaluation.status==='compatible','compatibility_unresolved','未確認・不適合の部品を解消してください。',409);
    const recipients=input.supplierMakerIds||[];check(Array.isArray(recipients)&&recipients.length<=10&&new Set(recipients).size===recipients.length&&recipients.every((id:unknown)=>state.makers.some(m=>m.id===id&&!m.suspended)),'invalid_suppliers','見積先を10事業以内で指定してください。');
    const quote:AssemblyQuote={id:randomUUID(),owner:actor.id,buildId,revision:build.revision,bom:build.parts.map(p=>({part:state.parts.find(x=>x.id===p.id),quantity:p.quantity})),status:'requested',buildSnapshot:structuredClone(build),dataVersion:evaluation.dataVersion,supplierMakerIds:recipients,answers:[]};state.quotes.push(quote);return quote;
  })}
  assemblyAnswer(actor:Actor,quoteId:string,input:any){return this.repo.transaction(state=>{
    const quote=state.quotes.find(q=>q.id===quoteId);check(quote,'not_found','見積依頼が見つかりません。',404);makerAccess(state,actor,input.makerId);check(quote.supplierMakerIds?.includes(input.makerId),'not_invited','この見積への招待が必要です。',403);check(quote.status==='requested','quote_closed','見積回答は締め切られています。',409);
    check(/^[A-Z]{3}$/.test(input.currency)&&Date.parse(input.expiresAt)>Date.now(),'invalid_quote','通貨と見積有効期限を確認してください。');
    const costs=costBreakdown(input.costs),answer:AssemblyAnswer={id:randomUUID(),makerId:input.makerId,costs,amount:Object.values(costs).reduce((sum,n)=>sum+n,0),currency:input.currency,leadDays:integer(input.leadDays,'納期日数',1,3650),expiresAt:input.expiresAt,warranty:text(input.warranty,'保証条件')};
    (quote.answers||=[]).push(answer);state.audit.push({id:randomUUID(),actor:actor.id,action:'assembly.answer',entity:answer.id,at:new Date().toISOString()});return answer;
  })}
  acceptAssembly(actor:Actor,quoteId:string,input:any){return this.repo.transaction(state=>{
    const quote=state.quotes.find(q=>q.id===quoteId);check(quote&&quote.owner===actor.id,'forbidden','依頼者だけが見積を採用できます。',403);check(quote.status==='requested','quote_closed','この見積は採用済みです。',409);const build=state.builds.find(b=>b.id===quote.buildId);check(build?.revision===quote.revision,'revision_conflict','構成が更新されています。再見積してください。',409);
    const answer=quote.answers?.find(a=>a.id===input.answerId);check(answer&&Date.parse(answer.expiresAt)>Date.now(),'quote_expired','有効な見積を選択してください。',409);check(input.confirmed===true,'approval_required','内訳・納期・保証を確認してください。');quote.acceptedAnswerId=answer.id;quote.status='accepted';state.audit.push({id:randomUUID(),actor:actor.id,action:'assembly.accept',entity:quote.id,at:new Date().toISOString()});return quote;
  })}
  assemblyInspection(actor:Actor,quoteId:string,input:any){return this.repo.transaction(state=>{
    const quote=state.quotes.find(q=>q.id===quoteId),answer=quote?.answers?.find(a=>a.id===quote.acceptedAnswerId);check(quote&&answer,'not_found','採用済み見積が見つかりません。',404);makerAccess(state,actor,answer.makerId);check(input.confirmed===true,'inspection_required','検査結果の確認が必要です。');answer.inspection={at:new Date().toISOString(),report:text(input.report,'検査記録',10000),confirmed:true};quote.status='inspected';state.audit.push({id:randomUUID(),actor:actor.id,action:'assembly.inspection',entity:quote.id,at:new Date().toISOString()});return quote;
  })}
  assembledListing(actor:Actor,quoteId:string,input:any){
    const state=this.repo.read(),quote=state.quotes.find(q=>q.id===quoteId),answer=quote?.answers?.find(a=>a.id===quote.acceptedAnswerId);
    check(quote?.status==='inspected'&&quote.buildSnapshot&&answer?.inspection?.confirmed,'inspection_required','製造者の検査と構成記録が必要です。',409);makerAccess(state,actor,answer.makerId);
    const listing=this.listing(actor,{...input,makerId:answer.makerId,kind:'product',condition:'new',warranty:answer.warranty});
    return this.repo.transaction(s=>{const saved=s.listings.find(l=>l.id===listing.id)!;saved.assemblyReference={quoteId:quote.id,answerId:answer.id,build:{...quote.buildSnapshot!,owner:'',budget:0,purpose:'assembled_product'},bom:quote.bom,inspection:answer.inspection!.report};s.audit.push({id:randomUUID(),actor:actor.id,action:'assembly.listing',entity:saved.id,at:new Date().toISOString()});return this.publicListing(saved)});
  }
  alternative(actor:Actor,projectId:string,input:any){return this.repo.transaction(state=>{
    const project=state.projects.find(p=>p.id===projectId);check(project,'not_found','企画が見つかりません。',404);makerAccess(state,actor,project.makerId);check(project.revision===input.revision,'revision_conflict','企画が更新されています。',409);
    if(input.confirmId){const candidate=project.alternatives?.find(a=>a.id===input.confirmId);check(candidate&&input.manufacturerConfirmed===true,'approval_required','製造者の適合確認が必要です。');const original=project.bom.find(b=>b.name===candidate.original);check(original,'bom_changed','元の部品が変更されています。',409);candidate.state='confirmed';candidate.note=text(input.note,'適合確認の記録');original.name=candidate.candidate;original.unitCost=candidate.unitCost;original.source=candidate.source;}
    else{const original=text(input.original,'元の部品',200);check(project.bom.some(b=>b.name===original),'bom_missing','元の部品が見つかりません。');(project.alternatives||=[]).push({id:randomUUID(),original,candidate:text(input.candidate,'代替候補',200),unitCost:integer(input.unitCost,'候補原価'),source:text(input.source,'資料の出典',1000),state:'candidate',note:text(input.note,'候補の理由')})}
    project.revision++;return project;
  })}
}
