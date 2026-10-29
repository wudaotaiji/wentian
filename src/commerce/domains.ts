import {check,type Actor,type CommerceSite} from './model.js';
import {MakerWorkspace} from './workspace.js';
import {makerAccess} from './service.js';

export interface CommerceDomainProvider {ensure(site:CommerceSite):Promise<void>;remove(site:CommerceSite):Promise<void>;probe(site:CommerceSite):Promise<boolean>}

/** Caddyの自動HTTPS（Automatic HTTPS）と設定APIへ、所有確認済みホストだけを登録します。 */
export class CaddyCommerceDomains implements CommerceDomainProvider {
  private admin:URL;
  constructor(admin:string,private routesPath:string,private upstream:string,private request:typeof fetch=fetch){
    this.admin=new URL(admin);
    check(this.admin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(this.admin.hostname)&&!this.admin.username&&!this.admin.password,'invalid_caddy_admin','Caddy管理APIはローカル専用URLを指定してください。');
    check(/^\/config\/apps\/http\/servers\/[A-Za-z0-9_-]+\/routes$/.test(routesPath),'invalid_caddy_path','専用サーバーのルート配列パスを指定してください。');
    check(/^(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/.test(upstream)&&Number(upstream.split(':')[1])<=65535,'invalid_upstream','Wentianのローカル待受先を指定してください。');
  }
  private route(site:CommerceSite){
    check(site.domain?.verified&&site.publishedRevision>0,'domain_ineligible','所有確認とサイト公開を先に行ってください。',409);
    const proxy={handler:'reverse_proxy',upstreams:[{dial:this.upstream}],headers:{request:{set:{Host:[this.upstream]}}}};
    return {'@id':'wentian-commerce-'+site.id,match:[{host:[site.domain.name]}],handle:[{handler:'subroute',routes:[
      {match:[{path:['/.well-known/wentian-commerce']}],handle:[{handler:'static_response',status_code:200,body:site.id+':'+site.domain.token}]},
      {match:[{path:['/']}],handle:[{handler:'rewrite',uri:'/sites/maker-'+site.slug+'/'},proxy]},
      {match:[{path:['/sites/maker-'+site.slug+'/','/api/commerce/public-sites/'+site.slug+'/pages/*']}],handle:[proxy]},
      {handle:[{handler:'static_response',status_code:404,body:'Not found'}]}
    ]}],terminal:true};
  }
  private async update(site:CommerceSite,remove:boolean){
    const id='wentian-commerce-'+site.id;
    // ETag（Entity Tag）で他サイトの同時変更を保護し、接続設定全体を上書きしません。
    for(let attempt=0;attempt<3;attempt++){
      const response=await this.request(new URL(this.routesPath,this.admin),{signal:AbortSignal.timeout(10000),redirect:'error'});
      check(response.ok,'caddy_unavailable','Caddyの設定を取得できません。',503);const etag=response.headers.get('etag'),routes=await response.json() as Array<any>;
      check(Array.isArray(routes)&&etag,'caddy_config_invalid','Caddyのルート配列とETagを確認してください。',503);
      const current=routes.find(r=>r['@id']===id);
      check(!current||current.match?.[0]?.host?.[0]===site.domain?.name,'domain_route_changed','専用ルートの内容が別途変更されています。',409);
      if(remove&&!current)return;
      const desired=remove?undefined:this.route(site);if(!remove&&JSON.stringify(current)===JSON.stringify(desired))return;
      const next=routes.filter(r=>r['@id']!==id);if(desired)next.unshift(desired);
      const saved=await this.request(new URL(this.routesPath,this.admin),{method:'PATCH',headers:{'content-type':'application/json','if-match':etag},body:JSON.stringify(next),signal:AbortSignal.timeout(10000),redirect:'error'});
      if(saved.status===412)continue;check(saved.ok,'caddy_update_failed','Caddyの接続設定に失敗しました。既存設定を確認してください。',503);return;
    }
    check(false,'caddy_config_conflict','接続設定が同時更新されています。再実行してください。',409);
  }
  ensure(site:CommerceSite){return this.update(site,false)}
  remove(site:CommerceSite){return this.update(site,true)}
  async probe(site:CommerceSite){
    check(site.domain,'domain_missing','ドメインが未設定です。');
    try{
      // 標準TLS検証を維持し、リダイレクト先や自己署名証明書を受け入れません。
      const response=await this.request('https://'+site.domain.name+'/.well-known/wentian-commerce',{redirect:'error',signal:AbortSignal.timeout(10000)});
      return response.ok&&(await response.text())===site.id+':'+site.domain.token;
    }catch{return false}
  }
}

/** 所有確認・接続・解除・売買移転をサイト単位で直列化するドメイン管理（Domain Manager）です。 */
export class CommerceDomainManager {
  private locks=new Map<string,Promise<unknown>>();
  constructor(private service:MakerWorkspace,private provider?:CommerceDomainProvider){}
  private exclusive<T>(siteId:string,operation:()=>Promise<T>){const previous=this.locks.get(siteId)||Promise.resolve();const next=previous.catch(()=>undefined).then(operation);this.locks.set(siteId,next);void next.finally(()=>{if(this.locks.get(siteId)===next)this.locks.delete(siteId)}).catch(()=>undefined);return next}
  private authorized(actor:Actor,id:string){const site=this.service.site(actor,id);makerAccess(this.service.repo.read(),actor,site.makerId);return site}
  async set(actor:Actor,siteId:string,input:any){return this.exclusive(siteId,async()=>{const site=this.authorized(actor,siteId);if(site.domain?.provisioned){check(this.provider,'domains_unconfigured','接続済みドメインの解除設定が未接続です。',503);await this.provider.remove(site)}return this.service.domain(actor,siteId,input)})}
  async verify(actor:Actor,siteId:string){return this.exclusive(siteId,()=>this.service.verifyDomain(actor,siteId))}
  async activate(actor:Actor,siteId:string){return this.exclusive(siteId,async()=>{
    const site=this.authorized(actor,siteId);check(this.provider,'domains_unconfigured','独自ドメインのホスティング設定が未接続です。',503);
    check(site.domain?.verified&&site.publishedRevision>0,'domain_ineligible','所有確認とサイト公開を先に行ってください。',409);
    // 接続の意図を先に永続化し、外部登録直後のクラッシュでも解除・再開できるようにします。
    this.service.repo.transaction(s=>{const current=s.sites.find(p=>p.id===siteId)!;check(current.domain?.token===site.domain!.token,'domain_changed','ドメインが更新されています。',409);current.domain.provisioned=true;current.domain.certificate='pending'});
    await this.provider.ensure(site);
    return this.inspect(siteId);
  })}
  private async inspect(siteId:string){
    const site=this.service.repo.read().sites.find(s=>s.id===siteId);check(site?.domain&&this.provider,'domains_unconfigured','接続対象が見つかりません。',503);
    const active=await this.provider.probe(site);
    return this.service.repo.transaction(s=>{const current=s.sites.find(p=>p.id===siteId)!;check(current.domain?.token===site.domain!.token,'domain_changed','ドメインが更新されています。',409);current.domain.certificate=active?'active':'pending';current.domain.lastCheckedAt=new Date().toISOString();if(active)delete current.domain.error;else current.domain.error='有効なTLS接続を確認できません。DNS・公開ポート・証明書発行を確認してください。';return current.domain});
  }
  async tick(){if(!this.provider)return;for(const site of this.service.repo.read().sites)if(site.domain?.provisioned&&(!site.domain.lastCheckedAt||Date.now()-Date.parse(site.domain.lastCheckedAt)>60_000)){
    await this.exclusive(site.id,async()=>{try{const current=this.service.repo.read().sites.find(s=>s.id===site.id)!;if(!current.domain?.provisioned)return;await this.provider!.ensure(current);await this.inspect(current.id)}catch{this.service.repo.transaction(s=>{const current=s.sites.find(p=>p.id===site.id);if(current?.domain){current.domain.certificate='pending';current.domain.lastCheckedAt=new Date().toISOString();current.domain.error='ドメイン接続を確認できません。再接続してください。'}})}});
  }}
  async acceptTransfer(actor:Actor,transferId:string,input:any){
    const transfer=this.service.repo.read().transfers.find(t=>t.id===transferId);check(transfer,'not_found','移転が見つかりません。',404);
    return this.exclusive(transfer.siteId,async()=>{
      const state=this.service.repo.read(),current=state.transfers.find(t=>t.id===transferId)!,order=state.orders.find(o=>o.id===current.orderId)!;
      check(current.to===actor.id,'forbidden','購入者だけが受領できます。',403);if(current.state==='completed')return current;
      check(current.state==='delivered'&&order.payment==='succeeded'&&!order.disputed&&order.refunded===0,'transfer_ineligible','納品と決済を確認してください。',409);
      const target=makerAccess(state,actor,input?.makerId);check(target.owner===actor.id,'forbidden','購入者の所有事業を指定してください。',403);
      const site=state.sites.find(s=>s.id===current.siteId)!;if(site.domain?.provisioned){check(this.provider,'domains_unconfigured','接続済みドメインの解除設定が未接続です。',503);await this.provider.remove(site)}
      return this.service.acceptTransfer(actor,transferId,input);
    });
  }
}
