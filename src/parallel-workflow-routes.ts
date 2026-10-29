/** 並列作業API（Parallel Workflow API）。実行関数はホストが固定し、要求からコマンドを受け取らない。 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readFile, writeFile } from 'node:fs/promises';
import { WorkflowStore, createWorkflow, runWorkflow, retryWorkflow, publicWorkflowView, WorkflowBusyError, validateWorkflowPlan, type WorkflowRunDeps } from './parallel-workflow.js';
import { validateAcceptance, verifyDelivery } from './delivery-verification.js';

export function registerParallelWorkflowRoutes(app: FastifyInstance, options: {
  workspace: string; root: string; executor?: WorkflowRunDeps['executeNode'];
  authorize: (req: FastifyRequest, reply: FastifyReply) => boolean | Promise<boolean>;
}) {
  const store = new WorkflowStore(options.root);
  const checksFile = (id: string) => `${store.filePath(id)}.checks`;
  async function authorize(req: FastifyRequest, reply: FastifyReply) {
    if (await options.authorize(req, reply)) return true;
    if (!reply.sent) reply.code(403).send({ error: '並列作業の管理権限が必要です。' });
    return false;
  }
  app.get('/api/workbench/workflows', async (req, reply) => {
    if (!await authorize(req, reply)) return reply;
    return { workflows: (await store.list()).flatMap(item => item.state ? [publicWorkflowView(item.state)] : []) };
  });
  app.post('/api/workbench/workflows', async (req, reply) => {
    if (!await authorize(req, reply)) return reply;
    try {
      const body = req.body as Record<string, unknown>;
      if (!body || Object.keys(body).some(key => !['nodes', 'acceptanceChecks', 'maxConcurrency'].includes(key))) throw new Error('指定できる項目はnodes・acceptanceChecks・maxConcurrencyです。');
      const checks = validateAcceptance(body.acceptanceChecks);
      if (!checks.length) throw new Error('統合後の固定受入条件が必要です。');
      const concurrency = body.maxConcurrency ?? 2;
      if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('並列数は1～8です。');
      const state = await createWorkflow(store, validateWorkflowPlan(body.nodes), concurrency);
      // 作成後に条件を上書きするAPIは設けず、再試行でも初回の条件を使う。
      await writeFile(checksFile(state.id), JSON.stringify(checks), { flag: 'wx', mode: 0o600 });
      return reply.code(201).send(publicWorkflowView(state));
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '計画が不正です。' }); }
  });
  for (const action of ['run', 'retry'] as const) app.post(`/api/workbench/workflows/:id/${action}`, async (req, reply) => {
    if (!await authorize(req, reply)) return reply;
    if (!options.executor) return reply.code(503).send({ error: '管理済み実行関数が未設定です。' });
    try {
      if (req.body && Object.keys(req.body).length) throw new Error('実行要求にコマンドや上書き条件は指定できません。');
      const id = String((req.params as { id: string }).id);
      const checks = validateAcceptance(JSON.parse(await readFile(checksFile(id), 'utf8')));
      if (!checks.length) throw new Error('固定受入条件がありません。');
      const deps: WorkflowRunDeps = { workspace: options.workspace, executeNode: options.executor,
        verifyIntegration: async context => {
          const result = await verifyDelivery(context.directory, checks);
          if (result.status !== 'passed') throw new Error(result.summary);
        } };
      return publicWorkflowView(await (action === 'run' ? runWorkflow(store, id, deps) : retryWorkflow(store, id, deps)));
    } catch (error) { return reply.code(error instanceof WorkflowBusyError ? 409 : 400).send({ error: error instanceof Error ? error.message : '実行できません。' }); }
  });
  return store;
}
