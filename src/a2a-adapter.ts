import type { CommonTaskService, TaskInfo, TaskResult } from './common-task-foundation.js';

/** 相互運用検証前の内部アダプターです。現段階ではA2A仕様準拠を表明しません。 */

export interface AgentCard {
  name: string;
  description: string;
  capabilities: {
    task_types: string[];
  };
  urls?: {
    task?: string;
    artifact?: string;
  };
}

export interface A2ATaskInput {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface A2ATask {
  taskId: string;
  ownerId: string;
  status: TaskInfo['status'];
  progress?: TaskInfo['progress'];
  createdAt: string;
  updatedAt: string;
}

export interface A2AArtifact {
  name: string;
  uri?: string;
  mediaType?: string;
}

export interface A2AResult {
  taskId: string;
  status: string;
  artifacts?: A2AArtifact[];
  verification?: TaskResult['verification'];
}

export interface A2AAuthContext {
  ownerId: string;
}

export class A2ATaskAdapter {
  constructor(private readonly taskService: CommonTaskService) {}

  agentCard(): AgentCard {
    return {
      name: 'wentian-gateway',
      description: 'Wentian GatewayのA2A接続口。共通タスク基盤への依頼、状態確認、中断、結果取得を提供します。',
      capabilities: {
        task_types: ['text', 'code', 'research'],
      },
      urls: {
        task: '/a2a/tasks',
        artifact: '/a2a/artifacts',
      },
    };
  }

  async createTask(ownerId: string, input: A2ATaskInput): Promise<A2ATask> {
    const task = await this.taskService.submitTask(ownerId, input);
    return { ...task };
  }

  async getTask(ownerId: string, taskId: string): Promise<A2ATask> {
    const task = await this.taskService.getTask(ownerId, taskId);
    return { ...task };
  }

  async cancelTask(ownerId: string, taskId: string): Promise<A2ATask> {
    const task = await this.taskService.cancelTask(ownerId, taskId);
    return { ...task };
  }

  async getResult(ownerId: string, taskId: string): Promise<A2AResult> {
    const result = await this.taskService.getResult(ownerId, taskId);
    return {
      ...result,
      artifacts: result.artifacts,
      verification: result.verification,
    };
  }

  registerHttpRoutes(app: A2AFastifyApp, contextResolver: (req: A2AFastifyRequest) => A2AAuthContext): void {
    app.get('/a2a/.well-known/agent-card', async () => this.agentCard());

    app.post('/a2a/tasks', async (req, reply) => {
      const context = contextResolver(req);
      const body = (req.body as { prompt?: string; context?: Record<string, unknown> } | undefined) ?? {};
      if (!body.prompt || typeof body.prompt !== 'string') {
        return reply.code(400).send({ error: { message: "'prompt' は文字列で指定してください。", code: 'invalid_request' } });
      }
      const task = await this.createTask(context.ownerId, { prompt: body.prompt, context: body.context });
      return reply.code(201).send(task);
    });

    app.get('/a2a/tasks/:id', async (req, reply) => {
      const context = contextResolver(req);
      const task = await this.getTask(context.ownerId, String((req.params as any).id));
      return reply.send(task);
    });

    app.post('/a2a/tasks/:id/cancel', async (req, reply) => {
      const context = contextResolver(req);
      const task = await this.cancelTask(context.ownerId, String((req.params as any).id));
      return reply.send(task);
    });

    app.get('/a2a/tasks/:id/result', async (req, reply) => {
      const context = contextResolver(req);
      const result = await this.getResult(context.ownerId, String((req.params as any).id));
      return reply.send(result);
    });
  }
}

export interface A2AFastifyApp {
  get(path: string, handler: (req: any, reply: any) => Promise<any>): any;
  post(path: string, handler: (req: any, reply: any) => Promise<any>): any;
}

export interface A2AFastifyRequest {
  headers: Record<string, unknown>;
  body?: unknown;
  params?: Record<string, unknown>;
}
