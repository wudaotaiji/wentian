/**
 * MCP（Model Context Protocol） JSON-RPC 2.0 のコア処理を実装します。
 *
 * - HTTP公開は公式SDKへ委譲し、業務処理と既存JSON-RPC単体検証を分離します。
 * - HTTPでは標準の初期化・通知・セッション・resources・promptsにも対応します。
 * - 共通タスク、データパトロール、ワークフロー定義参照・実行のToolを提供し、
 *   入力検証、所有者分離、認証済みサービス主体へのテナント固定を行います。
 * - Fastify統合は公式Streamable HTTPで、環境変数で明示的に有効化します。
 */

import type { CommonTaskService, SubmitTaskInput, TaskInfo, TaskResult } from './common-task-foundation.js';
import type { PatrolClient } from './integration-patrol.js';
import { registerMcpHttpRoutes } from './mcp-http-server.js';
import { WORKFLOW_RUN_STATUSES, type WorkflowClient, type WorkflowRunStatus } from './workflow-client.js';

// =============================================================================
// 型定義
// =============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface AuthContext {
  ownerId: string;
}

// =============================================================================
// インメモリ共通タスクサービス（検証・プロトタイプ用）
// =============================================================================

export class InMemoryTaskService implements CommonTaskService {
  private readonly tasks = new Map<string, TaskInfo>();
  private readonly results = new Map<string, TaskResult>();
  private idCounter = 0;

  async submitTask(ownerId: string, input: SubmitTaskInput): Promise<TaskInfo> {
    const taskId = `task_${Date.now()}_${++this.idCounter}`;
    const task: TaskInfo = {
      taskId,
      ownerId,
      status: 'queued',
      prompt: input.prompt,
      context: input.context,
      artifacts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, task);
    return { ...task };
  }

  async getTask(_ownerId: string, taskId: string): Promise<TaskInfo> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`タスク '${taskId}' は存在しません。`);
    }
    this.ensureOwner(task, _ownerId);
    return { ...task };
  }

  async listTasks(ownerId: string): Promise<TaskInfo[]> {
    return [...this.tasks.values()].filter(task => task.ownerId === ownerId).map(task => structuredClone(task));
  }

  async cancelTask(_ownerId: string, taskId: string): Promise<TaskInfo> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`タスク '${taskId}' は存在しません。`);
    }
    this.ensureOwner(task, _ownerId);
    if (task.status !== 'canceled') {
      task.status = 'canceled';
      task.updatedAt = new Date().toISOString();
    }
    return { ...task };
  }

  async getResult(_ownerId: string, taskId: string): Promise<TaskResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`タスク '${taskId}' は存在しません。`);
    }
    this.ensureOwner(task, _ownerId);

    let result = this.results.get(taskId);
    if (!result) {
      result = {
        taskId,
        status: task.status,
        artifacts: structuredClone(task.artifacts),
      };
      this.results.set(taskId, result);
    }
    return { ...result };
  }

  private ensureOwner(task: TaskInfo, ownerId: string): void {
    if (task.ownerId !== ownerId) {
      throw new Error('このタスクへのアクセス権がありません。');
    }
  }

  setTaskStatus(taskId: string, status: TaskInfo['status']): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`タスク '${taskId}' は存在しません。`);
    }
    task.status = status;
    task.updatedAt = new Date().toISOString();
  }
}

// =============================================================================
// MCP JSON-RPC アダプター
// =============================================================================

import { searchPublicWeb } from './agent-web-search.js';

export class MCPTaskAdapter {
  private static readonly TOOLS: ToolDefinition[] = [
    {
      name: 'wentian_submit_task',
      description: '新しいタスクを登録し、タスクIDと受付状態を返します。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '依頼内容の本文' },
          context: { type: 'object', description: '追加のメタデータやコンテキスト' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'wentian_get_task',
      description: 'タスクIDを指定して、現在の状態と進捗を取得します。',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '照会対象のタスクID' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'wentian_cancel_task',
      description: '実行中または保留中のタスクを中断します。',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '中断対象のタスクID' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'wentian_get_result',
      description: '完了したタスクの成果物と検証結果を取得します。',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '結果を取得するタスクID' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'wentian_run_data_patrol',
      description: 'System RoleとUser Roleを分離してWorkflow integrationデータパトロールを実行します。',
      inputSchema: { type:'object', properties:{
        system_prompt:{type:'string',description:'データパトロールAIへ渡すSystem Role'},
        user_request:{type:'string',description:'利用者の調査依頼であるUser Role'},
        catalog:{type:'string'}, schema:{type:'string'}, table:{type:'string'},
        sources:{type:'array'},
      }, required:['system_prompt','user_request','catalog','schema','table'] },
    },
    {
      name: 'wentian_list_workflows',
      description: '公開済みワークフロー定義の一覧を取得します。',
      inputSchema: { type:'object', properties:{}, required:[] },
    },
    {
      name: 'wentian_get_workflow',
      description: '指定IDのワークフロー定義詳細を取得します。',
      inputSchema: { type:'object', properties:{
        workflow_id:{type:'string',format:'uuid',description:'ワークフロー定義ID（UUID）'},
      }, required:['workflow_id'], additionalProperties:false },
    },
    {
      name: 'wentian_run_workflow',
      description: '公開済みワークフローを実行開始します。変換エンジン未接続時はCREATED状態で待機し、RunnerがQUEUEDへ遷移してから実処理が始まります。',
      inputSchema: { type:'object', properties:{
        workflow_id:{type:'string',format:'uuid',description:'実行対象のワークフロー定義ID（UUID）'},
        input_params:{type:'object',description:'工程へ渡す入力パラメータ（任意）'},
        idempotency_key:{type:'string',format:'uuid',description:'同一開始要求の重複防止キー（UUID形式、任意）'},
      }, required:['workflow_id'], additionalProperties:false },
    },
    {
      name: 'wentian_get_workflow_run',
      description: 'ワークフロー実行の詳細状態・工程実行結果を取得します。',
      inputSchema: { type:'object', properties:{
        run_id:{type:'string',format:'uuid',description:'実行記録ID（UUID）'},
      }, required:['run_id'], additionalProperties:false },
    },
    {
      name: 'wentian_list_workflow_runs',
      description: 'ワークフロー実行履歴の一覧を取得します。',
      inputSchema: { type:'object', properties:{
        workflow_id:{type:'string',format:'uuid',description:'対象ワークフロー定義ID（任意）'},
        status:{type:'string',enum:['CREATED','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','TIMEOUT'],description:'実行ステータスで絞り込み（任意）'},
        limit:{type:'integer',minimum:1,maximum:100,default:20,description:'返す件数上限（1〜100、既定20）'},
        offset:{type:'integer',minimum:0,default:0,description:'オフセット（既定0）'},
      }, required:[], additionalProperties:false },
    },
    {
      name: 'wentian_cancel_workflow_run',
      description: '実行中のワークフロー実行を停止します。COMPLETED/FAILED/CANCELLED/TIMEOUTの終了済み実行は停止できません。',
      inputSchema: { type:'object', properties:{
        run_id:{type:'string',format:'uuid',description:'停止対象の実行記録ID（UUID）'},
        reason:{type:'string',maxLength:500,description:'停止理由（任意、最大500文字）'},
      }, required:['run_id'], additionalProperties:false },
    },
    {
      name: 'wentian_web_search', description: '公開Web資料を検索し、見出し・抜粋・URL・取得時刻を返します。検索語に秘密情報を含めないでください。',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 400 } }, required: ['query'], additionalProperties: false },
    },
  ];

  constructor(
    private readonly taskService: CommonTaskService,
    private readonly patrolClient?: PatrolClient,
    private readonly workflowClient?: WorkflowClient,
  ) {}

  async handleRequest(rawMessage: string, context: AuthContext): Promise<string> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(rawMessage) as JsonRpcRequest;
    } catch {
      return this.buildErrorResponse(null, -32700, 'JSONのパースに失敗しました。');
    }

    if (
      typeof request !== 'object' ||
      request === null ||
      request.jsonrpc !== '2.0' ||
      typeof request.method !== 'string'
    ) {
      return this.buildErrorResponse(request?.id ?? null, -32600, '無効なリクエストです。');
    }

    const { id, method } = request;
    const params = (request.params ?? {}) as Record<string, unknown>;

    try {
      switch (method) {
        case 'initialize':
          return this.buildResponse(id, this.handleInitialize());
        case 'tools/list':
          return this.buildResponse(id, this.handleToolsList());
        case 'tools/call':
          return this.buildResponse(id, await this.handleToolsCall(params, context));
        default:
          return this.buildErrorResponse(id, -32601, `メソッド '${method}' は存在しません。`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '不明なエラーが発生しました。';
      return this.buildErrorResponse(id, -32603, message);
    }
  }

  private handleInitialize(): Record<string, unknown> {
    return {
      protocolVersion: '2025-11-25',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'wentian-gateway',
        version: '0.5.0',
      },
    };
  }

  handleToolsList(): Record<string, unknown> {
    return {
      tools: MCPTaskAdapter.TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: ['wentian_web_search', 'wentian_get_task', 'wentian_get_result', 'wentian_list_workflows', 'wentian_get_workflow', 'wentian_get_workflow_run', 'wentian_list_workflow_runs'].includes(tool.name),
          destructiveHint: ['wentian_cancel_task', 'wentian_cancel_workflow_run'].includes(tool.name),
          openWorldHint: tool.name.includes('workflow') || tool.name === 'wentian_run_data_patrol' || tool.name === 'wentian_web_search',
        },
      })),
    };
  }

  async handleToolsCall(params: Record<string, unknown>, context: AuthContext): Promise<Record<string, unknown>> {
    const name = params.name as string | undefined;
    const argumentsArg = (params.arguments as Record<string, unknown> | undefined) ?? {};

    if (!name || typeof name !== 'string') {
      throw new Error('ツール名 "name" は文字列で指定してください。');
    }

    this.validateArguments(name, argumentsArg);

    switch (name) {
      case 'wentian_web_search': {
        const evidence = await searchPublicWeb(argumentsArg.query as string);
        return { content: [{ type: 'text', text: JSON.stringify(evidence) }] };
      }
      case 'wentian_submit_task': {
        const prompt = (argumentsArg.prompt as string) ?? '';
        const result = await this.taskService.submitTask(context.ownerId, {
          prompt,
          context: argumentsArg.context as Record<string, unknown> | undefined,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                task_id: result.taskId,
                status: result.status,
              }),
            },
          ],
        };
      }
      case 'wentian_get_task': {
        const taskId = argumentsArg.task_id as string;
        const task = await this.taskService.getTask(context.ownerId, taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                task_id: task.taskId,
                status: task.status,
                progress: task.progress,
                updated_at: task.updatedAt,
              }),
            },
          ],
        };
      }
      case 'wentian_cancel_task': {
        const taskId = argumentsArg.task_id as string;
        const task = await this.taskService.cancelTask(context.ownerId, taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                task_id: task.taskId,
                status: task.status,
              }),
            },
          ],
        };
      }
      case 'wentian_get_result': {
        const taskId = argumentsArg.task_id as string;
        const result = await this.taskService.getResult(context.ownerId, taskId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                task_id: result.taskId,
                status: result.status,
                artifacts: result.artifacts,
                verification: result.verification,
              }),
            },
          ],
        };
      }
      case 'wentian_run_data_patrol': {
        if(!this.patrolClient)throw new Error('Workflow integrationデータパトロール接続が構成されていません。');
        const result=await this.patrolClient.run({systemPrompt:argumentsArg.system_prompt as string,userRequest:argumentsArg.user_request as string,catalog:argumentsArg.catalog as string,schema:argumentsArg.schema as string,table:argumentsArg.table as string,sources:argumentsArg.sources as unknown[]|undefined});
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      }
      case 'wentian_list_workflows': {
        if(!this.workflowClient)throw new Error('Workflow integrationワークフロー接続が構成されていません。');
        const result=await this.workflowClient.listWorkflows();
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      }
      case 'wentian_get_workflow': {
        if(!this.workflowClient)throw new Error('Workflow integrationワークフロー接続が構成されていません。');
        const workflowId=argumentsArg.workflow_id as string;
        const result=await this.workflowClient.getWorkflow(workflowId);
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      }
      case 'wentian_run_workflow': {
        if(!this.workflowClient)throw new Error('Workflow integrationワークフロー実行接続が構成されていません。');
        const workflowId=argumentsArg.workflow_id as string;
        const inputParams=argumentsArg.input_params as Record<string, unknown>|undefined;
        const idempotencyKey=argumentsArg.idempotency_key as string|undefined;
        const result=await this.workflowClient.startWorkflowRun(workflowId,inputParams,idempotencyKey);
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      }
      case 'wentian_get_workflow_run': {
        if(!this.workflowClient)throw new Error('Workflow integrationワークフロー実行接続が構成されていません。');
        const runId=argumentsArg.run_id as string;
        const result=await this.workflowClient.getWorkflowRun(runId);
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      }
      case 'wentian_list_workflow_runs': {
        if(!this.workflowClient)throw new Error('Workflow integrationワークフロー実行接続が構成されていません。');
        const options={
          workflowId:argumentsArg.workflow_id as string|undefined,
          status:argumentsArg.status as WorkflowRunStatus|undefined,
          limit:(typeof argumentsArg.limit==='number')?argumentsArg.limit:20,
          offset:(typeof argumentsArg.offset==='number')?argumentsArg.offset:0,
        };
        const result=await this.workflowClient.listWorkflowRuns(options);
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      }
      case 'wentian_cancel_workflow_run': {
        if(!this.workflowClient)throw new Error('Workflow integrationワークフロー実行接続が構成されていません。');
        const runId=argumentsArg.run_id as string;
        const reason=argumentsArg.reason as string|undefined;
        const result=await this.workflowClient.cancelWorkflowRun(runId,reason);
        return {content:[{type:'text',text:JSON.stringify(result)}]};
      }
      default:
        throw new Error(`ツール '${name}' は実装されていません。`);
    }
  }

  private validateArguments(name: string, args: Record<string, unknown>): void {
    const tool = MCPTaskAdapter.TOOLS.find((t) => t.name === name);
    if (!tool) {
      throw new Error(`ツール '${name}' は定義されていません。`);
    }

    const required = tool.inputSchema.required ?? [];
    for (const key of required) {
      if (!(key in args) || args[key] === null || args[key] === undefined || args[key] === '') {
        throw new Error(`必須パラメータ '${key}' が不足しています。`);
      }
    }

    // MCP Tool の公開スキーマとサーバー側検証を一致させます。特に tenant_id、user_id、
    // service_token などを受け付けないことで、認証済みサービス主体のテナントへ固定します。
    if (tool.inputSchema.additionalProperties === false) {
      const allowed = new Set(Object.keys(tool.inputSchema.properties));
      const unknown = Object.keys(args).find((key) => !allowed.has(key));
      if (unknown) throw new Error(`未定義パラメータ '${unknown}' は指定できません。`);
    }

    if (name === 'wentian_submit_task' && typeof args.prompt !== 'string') {
      throw new Error("'prompt' は文字列で指定してください。");
    }
    if(name==='wentian_run_data_patrol'){
      for(const key of ['system_prompt','user_request','catalog','schema','table'])if(typeof args[key]!=='string'||!(args[key] as string).trim())throw new Error(`'${key}' は空でない文字列で指定してください。`);
      for(const key of ['catalog','schema','table'])if(!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(args[key] as string))throw new Error(`'${key}' に使用できない文字が含まれています。`);
      if(args.sources!==undefined&&!Array.isArray(args.sources))throw new Error("'sources' は配列で指定してください。");
    }
    if(name==='wentian_get_workflow'){
      if(typeof args.workflow_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.workflow_id))throw new Error("'workflow_id' はUUID形式で指定してください。");
    }
    if (
      (name === 'wentian_get_task' || name === 'wentian_cancel_task' || name === 'wentian_get_result') &&
      typeof args.task_id !== 'string'
    ) {
      throw new Error("'task_id' は文字列で指定してください。");
    }
    if(name==='wentian_run_workflow'){
      if(typeof args.workflow_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.workflow_id))throw new Error("'workflow_id' はUUID形式で指定してください。");
      if(args.input_params!==undefined&&(typeof args.input_params!=='object'||args.input_params===null||Array.isArray(args.input_params)))throw new Error("'input_params' はオブジェクトで指定してください。");
      if(args.idempotency_key!==undefined&&(typeof args.idempotency_key!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.idempotency_key)))throw new Error("'idempotency_key' はUUID形式で指定してください。");
    }
    if(name==='wentian_get_workflow_run'||name==='wentian_cancel_workflow_run'){
      if(typeof args.run_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.run_id))throw new Error("'run_id' はUUID形式で指定してください。");
    }
    if(name==='wentian_list_workflow_runs'){
      if(args.workflow_id!==undefined&&(typeof args.workflow_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.workflow_id)))throw new Error("'workflow_id' はUUID形式で指定してください。");
      if(args.status!==undefined){
        if(typeof args.status!=='string'||!WORKFLOW_RUN_STATUSES.includes(args.status as WorkflowRunStatus))throw new Error("'status' に無効な値が指定されました。");
      }
      if(args.limit!==undefined&&(typeof args.limit!=='number'||!Number.isInteger(args.limit)||args.limit<1||args.limit>100))throw new Error("'limit' は1〜100の整数で指定してください。");
      if(args.offset!==undefined&&(typeof args.offset!=='number'||!Number.isInteger(args.offset)||args.offset<0))throw new Error("'offset' は0以上の整数で指定してください。");
    }
    if(name==='wentian_cancel_workflow_run'&&args.reason!==undefined&&(typeof args.reason!=='string'||args.reason.length>500)){
      throw new Error("'reason' は500文字以内の文字列で指定してください。");
    }
  }

  private buildResponse(id: string | number | null | undefined, result: Record<string, unknown>): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  private buildErrorResponse(
    id: string | number | null | undefined,
    code: number,
    message: string,
  ): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  registerHttpRoutes(app: FastifyApp, contextResolver: (req: FastifyRequest) => AuthContext, basePath = ''): void {
    registerMcpHttpRoutes(app, this, this.taskService, contextResolver, basePath);
  }
}

export interface FastifyApp {
  post(path: string, handler: (req: any, reply: any) => Promise<any>): any;
  get(path: string, handler: (req: any, reply: any) => Promise<any>): any;
  delete(path: string, handler: (req: any, reply: any) => Promise<any>): any;
  addHook(name: 'onClose', handler: () => Promise<void>): any;
}

export interface FastifyRequest {
  headers: Record<string, unknown>;
  body?: unknown;
}
