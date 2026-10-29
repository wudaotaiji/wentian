/** Workflow integrationデータパトロールAPIを安全に呼び出す専用クライアントです。 */
export interface PatrolInput { systemPrompt:string; userRequest:string; catalog:string; schema:string; table:string; sources?:unknown[] }
export interface PatrolClient { run(input:PatrolInput):Promise<unknown> }
interface IntegrationPatrolOptions { baseUrl:string; session?:string; serviceToken?:string; serviceId?:string; timeoutMs:number }
export class IntegrationPatrolClient implements PatrolClient {
  constructor(private readonly options:IntegrationPatrolOptions={
    baseUrl:process.env.WENTIAN_INTEGRATION_BASE_URL||'',
    session:process.env.WENTIAN_INTEGRATION_SESSION||'',
    serviceToken:process.env.WENTIAN_INTEGRATION_SERVICE_TOKEN||'',
    serviceId:process.env.WENTIAN_INTEGRATION_SERVICE_ID||'wentian-gateway',
    timeoutMs:Number(process.env.WENTIAN_INTEGRATION_TIMEOUT_MS||90000),
  }){
    // 接続を使うまで未設定を許し、外部サービスなしでも起動できます。
    if(!options.baseUrl.trim())return;
    const url=new URL(options.baseUrl);
    if(url.username||url.password||!['https:','http:'].includes(url.protocol))throw new Error('Workflow integration Base URLが不正です。');
    if(url.protocol==='http:'&&!['127.0.0.1','localhost','::1'].includes(url.hostname)&&!url.hostname.endsWith('.svc.cluster.local'))throw new Error('非ローカルのWorkflow integration接続にはHTTPSが必要です。');
  }
  async run(input:PatrolInput):Promise<unknown>{
    if(!this.options.baseUrl.trim())throw new Error('WENTIAN_INTEGRATION_BASE_URLが未設定です。');
    if(!this.options.serviceToken&&!this.options.session)throw new Error('Workflow integrationのサービスTokenまたは一時セッションが未設定です。');
    const base=this.options.baseUrl.replace(/\/$/,'');
    const origin=new URL(base).origin;
    const correlationId=crypto.randomUUID();
    const authenticationHeaders:Record<string,string>=this.options.serviceToken
      ? {authorization:`Bearer ${this.options.serviceToken}`,'x-integration-service-id':this.options.serviceId||'wentian-gateway'}
      : {cookie:'integration_session='+this.options.session};
    const response=await fetch(base+'/integration/api/ai/extraction-assist',{method:'POST',signal:AbortSignal.timeout(this.options.timeoutMs),headers:{'content-type':'application/json',origin,'x-correlation-id':correlationId,...authenticationHeaders},body:JSON.stringify({provider:process.env.WENTIAN_INTEGRATION_PROVIDER||'default',catalog:input.catalog,schema:input.schema,table:input.table,sources:input.sources||[],request:input.userRequest,systemPrompt:input.systemPrompt})});
    const body=await response.text();
    if(!response.ok)throw new Error(`Workflow integration APIがHTTP ${response.status}を返しました: ${body.slice(0,500)}`);
    try{return JSON.parse(body)}catch{return{report:body}}
  }
}
