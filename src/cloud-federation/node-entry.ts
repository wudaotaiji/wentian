import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { NodeSupervisor, createMaintenanceDecider, type ManagedPlugin } from './node-supervisor.js';
import { FederationError, record, text } from './contracts.js';
import { endpoint } from './transport.js';
import type { FastifyInstance } from 'fastify';
import { serviceKey } from '../plugin-kernel.js';
import { loadManagedPlugins } from './node-catalog.js';

interface NodeConfig {
  directory: string; objective: string; maintenanceIntervalMs: number;
  groupWorkspace: string;
  reserveMemoryBytes: number; reserveDiskBytes: number;
  ai: { endpoint: string; model: string; apiKeyEnv?: string };
  cloud: { host: string; port: number; adminTokenEnv: string };
}
const NODE_CLOUD = serviceKey<{ app: FastifyInstance }>('wentian.node.cloud-http');

/** 重い管理画面・モデル一覧・外部Agent群を読み込まない最小内核専用の入口です。 */
export async function runNodeCore(args: string[]): Promise<void> {
  const at = args.indexOf('--config');
  if (at < 0 || !args[at + 1]) throw new FederationError('wentian node-core --config 設定JSON [--once] を指定してください。');
  const configFile = path.resolve(args[at + 1]), raw = record(JSON.parse(await readFile(configFile, 'utf8')));
  const ai = record(raw.ai), cloud = record(raw.cloud);
  const config: NodeConfig = {
    directory: path.resolve(path.dirname(configFile), text(raw.directory, 2048)), objective: text(raw.objective, 4000),
    groupWorkspace: path.resolve(path.dirname(configFile), typeof raw.groupWorkspace === 'string' ? text(raw.groupWorkspace, 2048) : text(raw.directory, 2048)),
    maintenanceIntervalMs: Number(raw.maintenanceIntervalMs), reserveMemoryBytes: Number(raw.reserveMemoryBytes), reserveDiskBytes: Number(raw.reserveDiskBytes),
    ai: { endpoint: endpoint(text(ai.endpoint, 2048)), model: text(ai.model, 200), ...(ai.apiKeyEnv ? { apiKeyEnv: text(ai.apiKeyEnv, 100) } : {}) },
    cloud: { host: text(cloud.host, 200), port: Number(cloud.port), adminTokenEnv: text(cloud.adminTokenEnv, 100) },
  };
  if (!Number.isSafeInteger(config.maintenanceIntervalMs) || config.maintenanceIntervalMs < 30000 || config.maintenanceIntervalMs > 86400000 || !Number.isSafeInteger(config.reserveMemoryBytes) || config.reserveMemoryBytes < 256 * 1024 ** 2 || !Number.isSafeInteger(config.reserveDiskBytes) || config.reserveDiskBytes < 256 * 1024 ** 2 || !Number.isSafeInteger(config.cloud.port) || config.cloud.port < 0 || config.cloud.port > 65535 || !['127.0.0.1', '::1'].includes(config.cloud.host)) throw new FederationError('保守間隔・資源余裕・ローカル待受の設定が不正です。遠隔公開はTLSプロキシで構成してください。');
  const complete = async (body: unknown): Promise<unknown> => {
    const token = config.ai.apiKeyEnv ? process.env[config.ai.apiKeyEnv] : undefined;
    if (config.ai.apiKeyEnv && !token) throw new FederationError('AI接続の認証用環境変数が未設定です。');
    const response = await fetch(config.ai.endpoint + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-wentian-decision-kind': 'node-maintenance' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new FederationError('保守用AIへ接続できません。');
    const reader = response.body?.getReader(); if (!reader) throw new FederationError('保守用AIの応答がありません。');
    let size = 0; const chunks: Uint8Array[] = [];
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 128 * 1024) throw new FederationError('AI応答が上限を超えました。'); chunks.push(next.value); } } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  const catalog: ManagedPlugin[] = [{
    definition: {
      id: 'node.cloud-federation', kind: 'tool', version: '0.1.0', provides: [NODE_CLOUD],
      async setup(context) {
        // AIがこのプラグインを選択した時点で初めてHTTPと分散Cloudを読み込みます。
        const [{ default: Fastify }, { registerCloudFederation }, { FederationService }, { digestAdapter }, { createAIReviewer }] = await Promise.all([
          import('fastify'), import('./routes.js'), import('./service.js'), import('./adapters.js'), import('./ai-review.js'),
        ]);
        const token = process.env[config.cloud.adminTokenEnv];
        if (!token || token.length < 24) throw new FederationError('ローカル管理用の24文字以上の認証値を環境変数へ設定してください。');
        const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
        const routes = registerCloudFederation(app, {
          factory: { open: async () => { const { createA2ADecider } = await import('./ai-review.js'); return FederationService.open({ directory: path.join(config.directory, 'cloud'), groupWorkspace: config.groupWorkspace, adapters: [digestAdapter()], reviewer: createAIReviewer({ model: config.ai.model, complete }), a2aDecide: createA2ADecider({ model: config.ai.model, complete }) }); } },
          authorize(req, reply) { if (req.headers.authorization === `Bearer ${token}`) return 'local-owner'; reply.code(401).send({ error: { message: 'ローカル所有者の認証が必要です。' } }); return undefined; },
        });
        app.get('/health', async () => { (await routes.service()).snapshot(); return { status: 'ok', plugin: 'node.cloud-federation' }; });
        try {
          // 受付は既定で無効のまま、鍵と台帳を起動時に確認します。
          await routes.service();
          await app.listen({ host: config.cloud.host, port: config.cloud.port });
          context.provide(NODE_CLOUD, { app });
          console.log('分散Cloudプラグインのローカル待受を開始しました。', app.server.address());
          return () => app.close();
        } catch (error) { await app.close(); throw error; }
      },
    },
    description: '独立Cloudの署名通信・直接注文・ローカル管理API。ノード間でサービスを提供・利用する場合に選択する。私用の一般処理だけなら不要。受付は利用者の明示設定まで無効。',
    memoryBudgetBytes: 256 * 1024 ** 2, diskBudgetBytes: 256 * 1024 ** 2,
    async health(kernel) { const result = await kernel.resolve(NODE_CLOUD).app.inject({ method: 'GET', url: '/health' }); return { healthy: result.statusCode === 200, detail: 'ローカルHTTPヘルス応答を確認しました。' }; },
  }];
  catalog.push(...await loadManagedPlugins(raw.plugins, path.dirname(configFile)));
  let restart = false, stopping = false;
  const supervisor = new NodeSupervisor({ directory: config.directory, catalog, decide: createMaintenanceDecider(complete, config.ai.model, config.objective), reserveMemoryBytes: config.reserveMemoryBytes, reserveDiskBytes: config.reserveDiskBytes, requestRestart: () => { restart = true; stopping = true; } });
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await supervisor.initialize();
    do {
      await supervisor.tick();
      console.log('AI最小内核の保守状態', JSON.stringify(supervisor.snapshot()));
      if (args.includes('--once') || stopping) break;
      // 終了要求を速やかに反映しつつ、AI保守を重複実行しません。
      const until = Date.now() + config.maintenanceIntervalMs;
      while (!stopping && Date.now() < until) await new Promise(resolve => setTimeout(resolve, Math.min(500, until - Date.now())));
    } while (!stopping);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await supervisor.close(); }
  if (restart) process.exitCode = 75;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNodeCore(process.argv.slice(2)).catch(() => { console.error('最小内核を起動できませんでした。設定、権限、保存先を確認してください。'); process.exitCode = 1; });
}
