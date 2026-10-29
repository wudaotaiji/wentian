/**
 * Workflow integration のワークフロー API（Application Programming Interface）を呼び出す専用クライアントです。
 * MCP（Model Context Protocol）引数からテナントや認証情報を受け取らず、ここで構成した
 * サービス認証だけを使います。実行 API のパスはこのクラスに集約します。
 */
export const WORKFLOW_RUN_STATUSES = ['CREATED','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','TIMEOUT'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export interface WorkflowListItem {
  id: string; name: string; status: 'DRAFT'|'PENDING_REVIEW'|'RETURNED'|'PUBLISHED'; version: number;
  steps: Array<{ id: string; kind: string; title: string; note: string }>;
  ownerName: string; assignedToName: string|null; updatedAt: string;
}
export interface WorkflowDetail extends WorkflowListItem { ownerId: string; assignedToId: string|null; tenantId: string; }
export interface WorkflowRunItem {
  id: string; workflowId: string; tenantId?: string; userId?: string; workflowName?: string; status: WorkflowRunStatus;
  idempotencyKey: string|null; inputParams?: unknown|null; summary?: unknown|null; errorMessage: string|null;
  startedAt: string|null; completedAt: string|null; createdAt: string; updatedAt: string;
}
export interface WorkflowStepExecutionItem {
  id: string; runId: string; stepId: string; stepKind: string; stepTitle: string; status: string;
  inputParams: unknown|null; outputSummary: unknown|null; errorMessage: string|null;
  startedAt: string|null; completedAt: string|null; createdAt: string; updatedAt: string;
}
export interface WorkflowRunDetail extends WorkflowRunItem {
  tenantId: string; userId: string; inputParams: unknown|null; summary: unknown|null;
  steps: WorkflowStepExecutionItem[]; notice?: string; label?: string;
}
export interface WorkflowRunListResponse { runs: WorkflowRunItem[]; total: number; }
export interface WorkflowRunListOptions { workflowId?: string; status?: WorkflowRunStatus; limit?: number; offset?: number; }
export interface WorkflowClient {
  listWorkflows(): Promise<WorkflowListItem[]>;
  getWorkflow(workflowId: string): Promise<WorkflowDetail>;
  startWorkflowRun(workflowId: string, inputParams?: Record<string,unknown>, idempotencyKey?: string): Promise<WorkflowRunDetail>;
  getWorkflowRun(runId: string): Promise<WorkflowRunDetail>;
  listWorkflowRuns(options?: WorkflowRunListOptions): Promise<WorkflowRunListResponse>;
  cancelWorkflowRun(runId: string, reason?: string): Promise<WorkflowRunItem>;
}
export interface IntegrationWorkflowOptions {
  baseUrl: string; session?: string; serviceToken?: string; serviceId?: string; timeoutMs: number;
  /** 将来 REST 形式へ統合する場合は runsPath と同じ値を指定できます。 */
  runStartPath?: string;
  /** 実行一覧・詳細・停止 API のコレクションパスです。 */
  runsPath?: string;
}

/** Workflow integration が返した HTTP エラーのステータスと安全な本文を保持します。 */
export class IntegrationWorkflowApiError extends Error {
  constructor(public readonly status: number, public readonly responseBody: string) {
    const detail=extractApiErrorMessage(responseBody);
    super(`Workflow integration APIがHTTP ${status}を返しました${detail?`: ${detail}`:'。'}`);
    this.name='IntegrationWorkflowApiError';
  }
}

const DEFAULT_RUN_START_PATH='/integration/api/ai/workflow-assist/run';
const DEFAULT_RUNS_PATH='/integration/api/ai/workflow-assist/executions';

export class IntegrationWorkflowClient implements WorkflowClient {
  private readonly options: IntegrationWorkflowOptions;
  constructor(options?: IntegrationWorkflowOptions) {
    this.options=options??{
      baseUrl:process.env.WENTIAN_INTEGRATION_BASE_URL||'',
      session:process.env.WENTIAN_INTEGRATION_SESSION||'', serviceToken:process.env.WENTIAN_INTEGRATION_SERVICE_TOKEN||'',
      serviceId:process.env.WENTIAN_INTEGRATION_SERVICE_ID||'wentian-gateway',
      timeoutMs:Number(process.env.WENTIAN_INTEGRATION_TIMEOUT_MS||90000),
      runStartPath:process.env.WENTIAN_INTEGRATION_WORKFLOW_RUN_START_PATH||DEFAULT_RUN_START_PATH,
      runsPath:process.env.WENTIAN_INTEGRATION_WORKFLOW_RUNS_PATH||DEFAULT_RUNS_PATH,
    };
    // 任意の連携は呼び出し時に設定を要求し、Gatewayの起動を妨げません。
    if(!this.options.baseUrl.trim())return;
    const url=new URL(this.options.baseUrl);
    if(url.username||url.password||!['https:','http:'].includes(url.protocol))throw new Error('Workflow integration Base URLが不正です。');
    if(url.protocol==='http:'&&!['127.0.0.1','localhost','::1'].includes(url.hostname)&&!url.hostname.endsWith('.svc.cluster.local'))throw new Error('非ローカルのWorkflow integration接続にはHTTPSが必要です。');
    if(!Number.isFinite(this.options.timeoutMs)||this.options.timeoutMs<=0)throw new Error('Workflow integration Timeoutは正の数で指定してください。');
    this.validateApiPath(this.runStartPath); this.validateApiPath(this.runsPath);
  }
  private get runStartPath(): string { return this.options.runStartPath||DEFAULT_RUN_START_PATH; }
  private get runsPath(): string { return (this.options.runsPath||DEFAULT_RUNS_PATH).replace(/\/$/,''); }
  private validateApiPath(path:string):void { if(!/^\/[A-Za-z0-9/_-]+$/.test(path))throw new Error('Workflow integrationワークフロー実行APIパスが不正です。'); }
  private buildHeaders():Record<string,string>{
    const origin=new URL(this.options.baseUrl).origin;
    if(this.options.serviceToken)return {authorization:`Bearer ${this.options.serviceToken}`,'x-integration-service-id':this.options.serviceId||'wentian-gateway',origin};
    if(this.options.session)return {cookie:`integration_session=${this.options.session}`,origin};
    throw new Error('Workflow integrationのサービスTokenまたは一時セッションが未設定です。');
  }
  private buildUrl(path:string):URL{return new URL(this.options.baseUrl.replace(/\/$/,'')+path);}
  private async request(path:string,init:RequestInit):Promise<unknown>{
    if(!this.options.baseUrl.trim())throw new Error('WENTIAN_INTEGRATION_BASE_URLが未設定です。');
    const response=await fetch(this.buildUrl(path),{...init,signal:AbortSignal.timeout(this.options.timeoutMs),headers:{'content-type':'application/json','x-correlation-id':crypto.randomUUID(),...this.buildHeaders(),...(init.headers??{})}});
    const text=await response.text();
    if(!response.ok)throw new IntegrationWorkflowApiError(response.status,text.slice(0,2000));
    try{return JSON.parse(text) as unknown;}catch{throw new Error('Workflow integration APIの応答がJSON形式ではありません。');}
  }
  async listWorkflows():Promise<WorkflowListItem[]>{
    const data=await this.request('/integration/api/ai/workflow-assist/list',{method:'GET'});
    if(!isRecord(data)||!Array.isArray(data.workflows))throw new Error('Workflow integration APIのワークフロー一覧応答が不正です。');
    return data.workflows as WorkflowListItem[];
  }
  async getWorkflow(workflowId:string):Promise<WorkflowDetail>{
    const data=await this.request('/integration/api/ai/workflow-assist/get',{method:'POST',body:JSON.stringify({workflow_id:workflowId})});
    if(!isRecord(data)||data.id!==workflowId||data.status!=='PUBLISHED')throw new Error('Workflow integration APIのワークフロー詳細応答が不正です。');
    return data as unknown as WorkflowDetail;
  }
  async startWorkflowRun(workflowId:string,inputParams?:Record<string,unknown>,idempotencyKey?:string):Promise<WorkflowRunDetail>{
    const body:Record<string,unknown>={workflow_id:workflowId}; if(inputParams!==undefined)body.input_params=inputParams; if(idempotencyKey!==undefined)body.idempotency_key=idempotencyKey;
    const data=await this.request(this.runStartPath,{method:'POST',body:JSON.stringify(body)}); assertWorkflowRunDetail(data); return data;
  }
  async getWorkflowRun(runId:string):Promise<WorkflowRunDetail>{const data=await this.request(`${this.runsPath}/${encodeURIComponent(runId)}`,{method:'GET'});assertWorkflowRunDetail(data);return data;}
  async listWorkflowRuns(options?:WorkflowRunListOptions):Promise<WorkflowRunListResponse>{
    const url=this.buildUrl(this.runsPath); if(options?.workflowId!==undefined)url.searchParams.set('workflow_id',options.workflowId); if(options?.status!==undefined)url.searchParams.set('status',options.status); if(options?.limit!==undefined)url.searchParams.set('limit',String(options.limit)); if(options?.offset!==undefined)url.searchParams.set('offset',String(options.offset));
    const data=await this.request(`${url.pathname}${url.search}`,{method:'GET'});
    if(!isRecord(data)||!Array.isArray(data.runs)||!Number.isInteger(data.total)||(data.total as number)<0)throw new Error('Workflow integration APIのワークフロー実行一覧応答が不正です。');
    for(const run of data.runs)assertWorkflowRunItem(run); return data as unknown as WorkflowRunListResponse;
  }
  async cancelWorkflowRun(runId:string,reason?:string):Promise<WorkflowRunItem>{
    const body:Record<string,unknown>={run_id:runId}; if(reason!==undefined)body.reason=reason;
    const data=await this.request(`${this.runsPath}/${encodeURIComponent(runId)}`,{method:'PATCH',body:JSON.stringify(body)}); assertWorkflowRunItem(data); return data;
  }
}

function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function isRunStatus(value:unknown):value is WorkflowRunStatus{return typeof value==='string'&&WORKFLOW_RUN_STATUSES.includes(value as WorkflowRunStatus);}
function assertWorkflowRunItem(value:unknown):asserts value is WorkflowRunItem{
  if(!isRecord(value)||typeof value.id!=='string'||typeof value.workflowId!=='string'||!isRunStatus(value.status)||typeof value.createdAt!=='string'||typeof value.updatedAt!=='string')throw new Error('Workflow integration APIのワークフロー実行応答が不正です。');
}
function assertWorkflowRunDetail(value:unknown):asserts value is WorkflowRunDetail{
  assertWorkflowRunItem(value); if(!isRecord(value)||typeof value.tenantId!=='string'||typeof value.userId!=='string'||!Array.isArray(value.steps))throw new Error('Workflow integration APIのワークフロー実行詳細応答が不正です。');
}
function extractApiErrorMessage(body:string):string{
  try{const data=JSON.parse(body) as unknown;if(isRecord(data)&&typeof data.error==='string')return data.error.slice(0,500);if(isRecord(data)&&typeof data.message==='string')return data.message.slice(0,500);}catch{/* JSONでない本文も長さを制限して伝えます。 */}
  return body.replace(/\s+/g,' ').trim().slice(0,500);
}
