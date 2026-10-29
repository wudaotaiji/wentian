import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { IntegrationWorkflowClient } from './workflow-client.js';

test('任意のワークフロー連携が未設定でも生成でき、利用時に設定不足を通知する', async () => {
  const client = new IntegrationWorkflowClient({baseUrl:'', timeoutMs:1000});
  await assert.rejects(client.listWorkflows(), /WENTIAN_INTEGRATION_BASE_URL/);
});

// MCP経由の公開定義参照ではサービス認証を使い、利用者指定テナントを送らないことを確認します。
test('公開ワークフローの一覧と詳細をサービス認証で取得する', async () => {
  const requests: Array<{ url: string; auth: string | undefined; serviceId: string | undefined; body: string }> = [];
  const id = '01234567-89ab-4cde-8f01-23456789abcd';
  const workflow = { id, name: '公開定義', status: 'PUBLISHED', version: 1, steps: [], ownerName: '管理者', assignedToName: null, updatedAt: new Date().toISOString(), ownerId: 'owner', assignedToId: 'owner', tenantId: 'tenant' };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url ?? '', auth: req.headers.authorization, serviceId: req.headers['x-integration-service-id'] as string | undefined, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url?.endsWith('/list') ? { workflows: [workflow] } : workflow));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('試験サーバー起動失敗');
    const client = new IntegrationWorkflowClient({ baseUrl: `http://127.0.0.1:${address.port}`, serviceToken: 'test-token', serviceId: 'wentian-gateway', timeoutMs: 3000 });
    assert.equal((await client.listWorkflows())[0].id, id);
    assert.equal((await client.getWorkflow(id)).status, 'PUBLISHED');
    assert.equal(requests.length, 2);
    assert.ok(requests.every(item => item.auth === 'Bearer test-token' && item.serviceId === 'wentian-gateway'));
    assert.ok(requests.every(item => !item.url.includes('tenant_id')));
    assert.deepEqual(JSON.parse(requests[1].body), { workflow_id: id });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

// 4つの実行操作が設定済みパスだけを使い、テナントや利用者を要求へ混入させないことを確認します。
test('ワークフロー実行の開始・詳細・一覧・停止をサービス主体のテナントへ固定する', async () => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const workflowId = '01234567-89ab-4cde-8f01-23456789abcd';
  const runId = '12345678-1234-4abc-8def-123456789abc';
  const now = new Date().toISOString();
  const run = {
    id: runId,
    workflowId,
    tenantId: 'server-selected-tenant',
    userId: 'service-user',
    status: 'CREATED',
    idempotencyKey: null,
    inputParams: null,
    summary: null,
    errorMessage: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    steps: [],
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url?.startsWith('/custom/executions?')) {
        res.end(JSON.stringify({ runs: [run], total: 1 }));
      } else {
        res.end(JSON.stringify(run));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('試験サーバー起動失敗');
    const client = new IntegrationWorkflowClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      serviceToken: 'test-token',
      timeoutMs: 3000,
      runStartPath: '/custom/executions',
      runsPath: '/custom/executions',
    });
    await client.startWorkflowRun(workflowId, { catalog: 'hive' });
    await client.getWorkflowRun(runId);
    await client.listWorkflowRuns({ workflowId, status: 'CREATED', limit: 10, offset: 0 });
    await client.cancelWorkflowRun(runId, '利用者要求');

    assert.deepEqual(requests.map(item => `${item.method} ${item.url}`), [
      'POST /custom/executions',
      `GET /custom/executions/${runId}`,
      `GET /custom/executions?workflow_id=${workflowId}&status=CREATED&limit=10&offset=0`,
      `PATCH /custom/executions/${runId}`,
    ]);
    assert.deepEqual(JSON.parse(requests[0].body), { workflow_id: workflowId, input_params: { catalog: 'hive' } });
    assert.deepEqual(JSON.parse(requests[3].body), { run_id: runId, reason: '利用者要求' });
    assert.ok(requests.every(item => !item.url.includes('tenant')));
    assert.ok(requests.filter(item => item.body).every(item => !('tenant_id' in JSON.parse(item.body)) && !('user_id' in JSON.parse(item.body))));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

// 本番構成で個別のパス環境変数を省略しても、Workflow integrationが公開する実APIへ到達することを確認します。
test('ワークフロー実行の既定パスはrunとexecutions APIへ一致する', async () => {
  const requests: string[] = [];
  const workflowId = '01234567-89ab-4cde-8f01-23456789abcd';
  const runId = '12345678-1234-4abc-8def-123456789abc';
  const now = new Date().toISOString();
  const run = {
    id: runId, workflowId, tenantId: 'tenant', userId: 'service-user', status: 'CREATED',
    idempotencyKey: null, inputParams: null, summary: null, errorMessage: null,
    startedAt: null, completedAt: null, createdAt: now, updatedAt: now, steps: [],
  };
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.method === 'GET' && req.url === '/integration/api/ai/workflow-assist/executions' ? { runs: [], total: 0 } : run));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('試験サーバー起動失敗');
    const client = new IntegrationWorkflowClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      serviceToken: 'test-token', timeoutMs: 3000,
    });
    await client.startWorkflowRun(workflowId);
    await client.getWorkflowRun(runId);
    await client.listWorkflowRuns();
    await client.cancelWorkflowRun(runId);
    assert.deepEqual(requests, [
      'POST /integration/api/ai/workflow-assist/run',
      `GET /integration/api/ai/workflow-assist/executions/${runId}`,
      'GET /integration/api/ai/workflow-assist/executions',
      `PATCH /integration/api/ai/workflow-assist/executions/${runId}`,
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

// Workflow integration の業務エラー文を MCP 層まで判別可能な形で伝えることを確認します。
test('Workflow integration APIのHTTPステータスとエラー文を透過する', async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 409;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: '同じ冪等キーの実行が既に存在します' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('試験サーバー起動失敗');
    const client = new IntegrationWorkflowClient({ baseUrl: `http://127.0.0.1:${address.port}`, serviceToken: 'test-token', timeoutMs: 3000 });
    await assert.rejects(
      client.startWorkflowRun('01234567-89ab-4cde-8f01-23456789abcd'),
      (error: Error) => error.message.includes('HTTP 409') && error.message.includes('同じ冪等キー'),
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
