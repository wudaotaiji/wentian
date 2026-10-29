import assert from 'node:assert/strict';
import test from 'node:test';
import { MCPTaskAdapter, InMemoryTaskService, JsonRpcResponse } from './mcp-task-adapter.js';
import type { WorkflowClient } from './workflow-client.js';

const createAdapter = () => {
  const service = new InMemoryTaskService();
  return { adapter: new MCPTaskAdapter(service), service };
};
const authContext = { ownerId: 'user-123' };

test('initialize はプロトコル情報を返す', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.ok(response.result);
  const initializeResult = response.result as Record<string, unknown>;
  assert.equal(initializeResult.protocolVersion, '2025-11-25');
  assert.ok((initializeResult.capabilities as Record<string, unknown>).tools);
  assert.equal(((initializeResult.serverInfo as Record<string, unknown>).name as string), 'wentian-gateway');
});

test('tools/list はデータパトロールとワークフロー実行を含む12個のツール一覧を返す', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 2);
  const tools = (response.result as { tools: Array<{ name: string }> }).tools;
  assert.ok(Array.isArray(tools));
  assert.equal(tools.length, 12);
  assert.equal(tools[0].name, 'wentian_submit_task');
  assert.equal(tools[1].name, 'wentian_get_task');
  assert.equal(tools[2].name, 'wentian_cancel_task');
  assert.equal(tools[3].name, 'wentian_get_result');
  assert.equal(tools[4].name, 'wentian_run_data_patrol');
  assert.equal(tools[5].name, 'wentian_list_workflows');
  assert.equal(tools[6].name, 'wentian_get_workflow');
  assert.equal(tools[7].name, 'wentian_run_workflow');
  assert.equal(tools[8].name, 'wentian_get_workflow_run');
  assert.equal(tools[9].name, 'wentian_list_workflow_runs');
  assert.equal(tools[10].name, 'wentian_cancel_workflow_run');
});

test('データパトロールはSystem RoleとUser Roleを分離して渡す', async () => {
  let received: any;
  const adapter = new MCPTaskAdapter(new InMemoryTaskService(), { run: async input => { received=input; return { report:'ok' }; } });
  const response=JSON.parse(await adapter.handleRequest(JSON.stringify({jsonrpc:'2.0',id:70,method:'tools/call',params:{name:'wentian_run_data_patrol',arguments:{system_prompt:'安全規則',user_request:'対象を検査',catalog:'iceberg',schema:'sales',table:'orders'}}}),authContext)) as JsonRpcResponse;
  assert.equal(received.systemPrompt,'安全規則');
  assert.equal(received.userRequest,'対象を検査');
  assert.equal(JSON.parse((response.result as any).content[0].text).report,'ok');
});

test('データパトロールはSystem Role欠如と不正なテーブル名を拒否する', async () => {
  const adapter = new MCPTaskAdapter(new InMemoryTaskService(), { run: async()=>({}) });
  const missing=JSON.parse(await adapter.handleRequest(JSON.stringify({jsonrpc:'2.0',id:71,method:'tools/call',params:{name:'wentian_run_data_patrol',arguments:{user_request:'検査',catalog:'iceberg',schema:'sales',table:'orders'}}}),authContext)) as JsonRpcResponse;
  assert.ok(missing.error?.message.includes('system_prompt'));
  const unsafe=JSON.parse(await adapter.handleRequest(JSON.stringify({jsonrpc:'2.0',id:72,method:'tools/call',params:{name:'wentian_run_data_patrol',arguments:{system_prompt:'規則',user_request:'検査',catalog:'iceberg',schema:'sales',table:'orders;DROP'}}}),authContext)) as JsonRpcResponse;
  assert.ok(unsafe.error?.message.includes('使用できない文字'));
});

test('wentian_submit_task はタスクIDを返す', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'wentian_submit_task',
      arguments: { prompt: 'テストの依頼' },
    },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 3);
  assert.ok(response.result);
  const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0].type, 'text');
  const body = JSON.parse(content[0].text) as { task_id: string; status: string };
  assert.ok(body.task_id.startsWith('task_'));
  assert.equal(body.status, 'queued');
});

test('wentian_get_task は登録済みタスクの状態を返す', async () => {
  const { adapter } = createAdapter();
  const submitRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'wentian_submit_task',
      arguments: { prompt: '状態確認テスト' },
    },
  });
  const submitRes = JSON.parse(await adapter.handleRequest(submitRaw, authContext)) as JsonRpcResponse;
  const taskId = JSON.parse((submitRes.result as { content: Array<{ text: string }> }).content[0].text).task_id;

  const getRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: {
      name: 'wentian_get_task',
      arguments: { task_id: taskId },
    },
  });
  const getRes = JSON.parse(await adapter.handleRequest(getRaw, authContext)) as JsonRpcResponse;
  assert.equal(getRes.jsonrpc, '2.0');
  assert.equal(getRes.id, 11);
  const body = JSON.parse((getRes.result as { content: Array<{ text: string }> }).content[0].text) as {
    task_id: string;
    status: string;
  };
  assert.equal(body.task_id, taskId);
  assert.equal(body.status, 'queued');
});

test('wentian_cancel_task はタスクを中断する', async () => {
  const { adapter } = createAdapter();
  const submitRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 20,
    method: 'tools/call',
    params: {
      name: 'wentian_submit_task',
      arguments: { prompt: '中断テスト' },
    },
  });
  const submitRes = JSON.parse(await adapter.handleRequest(submitRaw, authContext)) as JsonRpcResponse;
  const taskId = JSON.parse((submitRes.result as { content: Array<{ text: string }> }).content[0].text).task_id;

  const cancelRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 21,
    method: 'tools/call',
    params: {
      name: 'wentian_cancel_task',
      arguments: { task_id: taskId },
    },
  });
  const cancelRes = JSON.parse(await adapter.handleRequest(cancelRaw, authContext)) as JsonRpcResponse;
  assert.equal(cancelRes.jsonrpc, '2.0');
  assert.equal(cancelRes.id, 21);
  const body = JSON.parse((cancelRes.result as { content: Array<{ text: string }> }).content[0].text) as {
    task_id: string;
    status: string;
  };
  assert.equal(body.task_id, taskId);
  assert.equal(body.status, 'canceled');
});

test('wentian_get_result は成果物を返す', async () => {
  const { adapter, service } = createAdapter();
  const submitRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 30,
    method: 'tools/call',
    params: {
      name: 'wentian_submit_task',
      arguments: { prompt: '結果取得テスト' },
    },
  });
  const submitRes = JSON.parse(await adapter.handleRequest(submitRaw, authContext)) as JsonRpcResponse;
  const taskId = JSON.parse((submitRes.result as { content: Array<{ text: string }> }).content[0].text).task_id;

  service.setTaskStatus(taskId, 'completed');

  const resultRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 31,
    method: 'tools/call',
    params: {
      name: 'wentian_get_result',
      arguments: { task_id: taskId },
    },
  });
  const resultRes = JSON.parse(await adapter.handleRequest(resultRaw, authContext)) as JsonRpcResponse;
  assert.equal(resultRes.jsonrpc, '2.0');
  assert.equal(resultRes.id, 31);
  const body = JSON.parse((resultRes.result as { content: Array<{ text: string }> }).content[0].text) as {
    task_id: string;
    status: string;
    artifacts?: Array<{ name: string }>;
  };
  assert.equal(body.task_id, taskId);
  assert.equal(body.status, 'completed');
  assert.ok(Array.isArray(body.artifacts));
});

test('無効なJSONはパースエラーを返す', async () => {
  const { adapter } = createAdapter();
  const responseStr = await adapter.handleRequest('not-json', authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, null);
  assert.ok(response.error);
  assert.equal(response.error.code, -32700);
  assert.ok(response.error.message.includes('パース'));
});

test('必須フィールド欠如はInvalid Requestエラーを返す', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '1.0',
    id: 2,
    method: 'initialize',
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32600);
});

test('未対応メソッドはMethod Not Foundを返す', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 99,
    method: 'unknown/method',
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 99);
  assert.ok(response.error);
  assert.equal(response.error.code, -32601);
});

test('wentian_submit_task で prompt が欠けているとエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 50,
    method: 'tools/call',
    params: {
      name: 'wentian_submit_task',
      arguments: {},
    },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('prompt'));
});

test('wentian_submit_task で prompt が空文字の場合はエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 51,
    method: 'tools/call',
    params: {
      name: 'wentian_submit_task',
      arguments: { prompt: '' },
    },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
});

test('wentian_get_task で task_id が欠けているとエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 52,
    method: 'tools/call',
    params: {
      name: 'wentian_get_task',
      arguments: {},
    },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
});

test('他人のタスクにはアクセスできない', async () => {
  const { adapter } = createAdapter();
  const submitRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 60,
    method: 'tools/call',
    params: {
      name: 'wentian_submit_task',
      arguments: { prompt: '所有者テスト' },
    },
  });
  const submitRes = JSON.parse(await adapter.handleRequest(submitRaw, authContext)) as JsonRpcResponse;
  const taskId = JSON.parse((submitRes.result as { content: Array<{ text: string }> }).content[0].text).task_id;

  const otherContext = { ownerId: 'user-999' };
  const getRaw = JSON.stringify({
    jsonrpc: '2.0',
    id: 61,
    method: 'tools/call',
    params: {
      name: 'wentian_get_task',
      arguments: { task_id: taskId },
    },
  });
  const getRes = JSON.parse(await adapter.handleRequest(getRaw, otherContext)) as JsonRpcResponse;
  assert.ok(getRes.error);
  assert.equal(getRes.error.code, -32603);
  assert.ok(getRes.error.message.includes('アクセス権'));
});

test('存在しないタスクを取得しようとするとエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 62,
    method: 'tools/call',
    params: {
      name: 'wentian_get_task',
      arguments: { task_id: 'task_00000000-0000-4000-8000-000000000000' },
    },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('存在しません'));
});

test('wentian_list_workflows はワークフロー一覧を返す', async () => {
  const mockClient = {
    listWorkflows: async () => [{ id: 'wf-1', name: 'Test Workflow', status: 'PUBLISHED' as const, version: 1, steps: [], ownerName: 'Owner', assignedToName: null, updatedAt: new Date().toISOString() }],
    getWorkflow: async (id: string) => ({ id, name: 'Test Workflow', status: 'PUBLISHED' as const, version: 1, steps: [], ownerName: 'Owner', assignedToName: null, updatedAt: new Date().toISOString(), ownerId: 'owner-1', assignedToId: null, tenantId: 'tenant-1' }),
    startWorkflowRun: async () => ({}),
    getWorkflowRun: async () => ({}),
    listWorkflowRuns: async () => ({ runs: [], total: 0 }),
    cancelWorkflowRun: async () => ({}),
  };
  const adapter = new MCPTaskAdapter(new InMemoryTaskService(), undefined, mockClient as unknown as WorkflowClient);
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 70,
    method: 'tools/call',
    params: { name: 'wentian_list_workflows', arguments: {} },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result);
  const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
  const body = JSON.parse(content[0].text);
  assert.ok(Array.isArray(body));
  assert.equal(body.length, 1);
  assert.equal(body[0].name, 'Test Workflow');
});

test('wentian_get_workflow はワークフロー詳細を返す', async () => {
  const mockClient = {
    listWorkflows: async () => [],
    getWorkflow: async (id: string) => ({ id, name: 'Detail Workflow', status: 'PUBLISHED' as const, version: 1, steps: [], ownerName: 'Owner', assignedToName: null, updatedAt: new Date().toISOString(), ownerId: 'owner-1', assignedToId: null, tenantId: 'tenant-1' }),
    startWorkflowRun: async () => ({}),
    getWorkflowRun: async () => ({}),
    listWorkflowRuns: async () => ({ runs: [], total: 0 }),
    cancelWorkflowRun: async () => ({}),
  };
  const adapter = new MCPTaskAdapter(new InMemoryTaskService(), undefined, mockClient as unknown as WorkflowClient);
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 71,
    method: 'tools/call',
    params: { name: 'wentian_get_workflow', arguments: { workflow_id: '01234567-89ab-4cde-8f01-23456789abcd' } },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result);
  const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
  const body = JSON.parse(content[0].text);
  assert.equal(body.name, 'Detail Workflow');
  assert.equal(body.id, '01234567-89ab-4cde-8f01-23456789abcd');
});

test('wentian_run_workflow は実行開始を依頼しCREATED応答を返す', async () => {
  const mockClient = {
    listWorkflows: async () => [],
    getWorkflow: async () => ({ id: 'dummy', name: '', status: 'PUBLISHED' as const, version: 1, steps: [], ownerName: '', assignedToName: null, updatedAt: new Date().toISOString(), ownerId: '', assignedToId: null, tenantId: '' }),
    startWorkflowRun: async (workflowId: string) => ({
      id: 'run-cuid123',
      workflowId,
      tenantId: 'tenant-1',
      userId: 'user-1',
      status: 'CREATED' as const,
      idempotencyKey: null,
      inputParams: null,
      summary: null,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
      notice: '変換エンジン（Runner）が未接続です。',
    }),
    getWorkflowRun: async () => ({}),
    listWorkflowRuns: async () => ({ runs: [], total: 0 }),
    cancelWorkflowRun: async () => ({}),
  };
  const adapter = new MCPTaskAdapter(new InMemoryTaskService(), undefined, mockClient as unknown as WorkflowClient);
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 72,
    method: 'tools/call',
    params: { name: 'wentian_run_workflow', arguments: { workflow_id: '01234567-89ab-4cde-8f01-23456789abcd' } },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result);
  const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
  const body = JSON.parse(content[0].text);
  assert.equal(body.status, 'CREATED');
  assert.ok(body.notice);
});

test('wentian_get_workflow_run は実行詳細を返す', async () => {
  const mockClient = {
    listWorkflows: async () => [],
    getWorkflow: async () => ({ id: 'dummy', name: '', status: 'PUBLISHED' as const, version: 1, steps: [], ownerName: '', assignedToName: null, updatedAt: new Date().toISOString(), ownerId: '', assignedToId: null, tenantId: '' }),
    startWorkflowRun: async () => ({}),
    getWorkflowRun: async (runId: string) => ({
      id: runId,
      workflowId: 'wf-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      status: 'RUNNING' as const,
      idempotencyKey: null,
      inputParams: null,
      summary: null,
      errorMessage: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ id: 'step-1', runId, stepId: 's1', stepKind: 'convert', stepTitle: '変換', status: 'RUNNING', inputParams: null, outputSummary: null, errorMessage: null, startedAt: new Date().toISOString(), completedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    }),
    listWorkflowRuns: async () => ({ runs: [], total: 0 }),
    cancelWorkflowRun: async () => ({}),
  };
  const adapter = new MCPTaskAdapter(new InMemoryTaskService(), undefined, mockClient as unknown as WorkflowClient);
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 73,
    method: 'tools/call',
    params: { name: 'wentian_get_workflow_run', arguments: { run_id: '12345678-1234-4abc-8def-123456789abc' } },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result);
  const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
  const body = JSON.parse(content[0].text);
  assert.equal(body.status, 'RUNNING');
  assert.equal(body.steps.length, 1);
  assert.equal(body.steps[0].stepKind, 'convert');
});

test('wentian_list_workflow_runs は実行履歴一覧を返す', async () => {
  const mockClient = {
    listWorkflows: async () => [],
    getWorkflow: async () => ({}),
    startWorkflowRun: async () => ({}),
    getWorkflowRun: async () => ({}),
    listWorkflowRuns: async () => ({
      runs: [
        { id: 'run-1', workflowId: 'wf-1', status: 'COMPLETED' as const, idempotencyKey: null, errorMessage: null, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 'run-2', workflowId: 'wf-1', status: 'FAILED' as const, idempotencyKey: null, errorMessage: 'error', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ],
      total: 2,
    }),
    cancelWorkflowRun: async () => ({}),
  };
  const adapter = new MCPTaskAdapter(new InMemoryTaskService(), undefined, mockClient as unknown as WorkflowClient);
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 74,
    method: 'tools/call',
    params: { name: 'wentian_list_workflow_runs', arguments: { limit: 10 } },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result);
  const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
  const body = JSON.parse(content[0].text);
  assert.equal(body.total, 2);
  assert.equal(body.runs.length, 2);
  assert.equal(body.runs[0].status, 'COMPLETED');
  assert.equal(body.runs[1].status, 'FAILED');
});

test('wentian_cancel_workflow_run は実行停止を依頼しCANCELLED応答を返す', async () => {
  const mockClient = {
    listWorkflows: async () => [],
    getWorkflow: async () => ({}),
    startWorkflowRun: async () => ({}),
    getWorkflowRun: async () => ({}),
    listWorkflowRuns: async () => ({ runs: [], total: 0 }),
    cancelWorkflowRun: async (runId: string) => ({
      id: runId,
      workflowId: 'wf-1',
      status: 'CANCELLED' as const,
      idempotencyKey: null,
      errorMessage: 'テスト停止',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  };
  const adapter = new MCPTaskAdapter(new InMemoryTaskService(), undefined, mockClient as unknown as WorkflowClient);
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 75,
    method: 'tools/call',
    params: { name: 'wentian_cancel_workflow_run', arguments: { run_id: '12345678-1234-4abc-8def-123456789abc', reason: 'テスト停止' } },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result);
  const content = (response.result as { content: Array<{ type: string; text: string }> }).content;
  const body = JSON.parse(content[0].text);
  assert.equal(body.status, 'CANCELLED');
});

test('wentian_run_workflow で workflow_id がUUID形式でない場合はエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 85,
    method: 'tools/call',
    params: { name: 'wentian_run_workflow', arguments: { workflow_id: 'wf-invalid' } },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('UUID'));
});

test('wentian_run_workflow で workflow_id が欠けているとエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 86,
    method: 'tools/call',
    params: { name: 'wentian_run_workflow', arguments: {} },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('workflow_id'));
});

test('wentian_get_workflow_run で run_id が欠けているとエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 87,
    method: 'tools/call',
    params: { name: 'wentian_get_workflow_run', arguments: {} },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('run_id'));
});

test('wentian_cancel_workflow_run で run_id が欠けているとエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 88,
    method: 'tools/call',
    params: { name: 'wentian_cancel_workflow_run', arguments: {} },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('run_id'));
});

test('wentian_list_workflow_runs で limit が範囲外の場合はエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 89,
    method: 'tools/call',
    params: { name: 'wentian_list_workflow_runs', arguments: { limit: 200 } },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('limit'));
});

test('ワークフロー実行ツールはクライアント未設定時にエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 91,
    method: 'tools/call',
    params: { name: 'wentian_run_workflow', arguments: { workflow_id: '01234567-89ab-4cde-8f01-23456789abcd' } },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('ワークフロー実行接続が構成されていません'));
});

test('ワークフロー実行ToolのJSON SchemaはUUID・整数・追加引数禁止を宣言する', async () => {
  const { adapter } = createAdapter();
  const response = JSON.parse(await adapter.handleRequest(JSON.stringify({
    jsonrpc: '2.0', id: 92, method: 'tools/list',
  }), authContext)) as JsonRpcResponse;
  const tools = (response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
  const run = tools.find(tool => tool.name === 'wentian_run_workflow');
  const list = tools.find(tool => tool.name === 'wentian_list_workflow_runs');
  assert.equal(run?.inputSchema.additionalProperties, false);
  assert.equal(((run?.inputSchema.properties as Record<string, Record<string, unknown>>).workflow_id).format, 'uuid');
  assert.equal(list?.inputSchema.additionalProperties, false);
  assert.equal(((list?.inputSchema.properties as Record<string, Record<string, unknown>>).limit).type, 'integer');
});

test('MCP引数によるテナント上書きと未定義引数を拒否する', async () => {
  const { adapter } = createAdapter();
  const response = JSON.parse(await adapter.handleRequest(JSON.stringify({
    jsonrpc: '2.0', id: 93, method: 'tools/call',
    params: {
      name: 'wentian_run_workflow',
      arguments: { workflow_id: '01234567-89ab-4cde-8f01-23456789abcd', tenant_id: 'attacker-tenant' },
    },
  }), authContext)) as JsonRpcResponse;
  assert.ok(response.error?.message.includes("未定義パラメータ 'tenant_id'"));
});

test('冪等キー・入力オブジェクト・ページ番号を厳密に検証する', async () => {
  const { adapter } = createAdapter();
  const calls = [
    { name: 'wentian_run_workflow', arguments: { workflow_id: '01234567-89ab-4cde-8f01-23456789abcd', idempotency_key: 'not-uuid' } },
    { name: 'wentian_run_workflow', arguments: { workflow_id: '01234567-89ab-4cde-8f01-23456789abcd', input_params: [] } },
    { name: 'wentian_list_workflow_runs', arguments: { limit: 1.5 } },
    { name: 'wentian_list_workflow_runs', arguments: { offset: -1 } },
  ];
  for (const [index, params] of calls.entries()) {
    const response = JSON.parse(await adapter.handleRequest(JSON.stringify({ jsonrpc: '2.0', id: 100 + index, method: 'tools/call', params }), authContext)) as JsonRpcResponse;
    assert.ok(response.error, `不正入力 ${index} は拒否される必要があります`);
  }
});

test('wentian_get_workflow で workflow_id が欠けているとエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 80,
    method: 'tools/call',
    params: {
      name: 'wentian_get_workflow',
      arguments: {},
    },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('workflow_id'));
});

test('詳細取得はUUID形式以外のIDを拒否する', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 82,
    method: 'tools/call',
    params: {
      name: 'wentian_get_workflow',
      arguments: { workflow_id: 'wf-123' },
    },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('UUID'));
});

test('ワークフロークライアント未設定時はエラーになる', async () => {
  const { adapter } = createAdapter();
  const raw = JSON.stringify({
    jsonrpc: '2.0',
    id: 90,
    method: 'tools/call',
    params: {
      name: 'wentian_list_workflows',
      arguments: {},
    },
  });
  const responseStr = await adapter.handleRequest(raw, authContext);
  const response = JSON.parse(responseStr) as JsonRpcResponse;
  assert.ok(response.error);
  assert.equal(response.error.code, -32603);
  assert.ok(response.error.message.includes('ワークフロー接続が構成されていません'));
});
