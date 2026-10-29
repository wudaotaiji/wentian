import type { AgentConnection } from './agent-connection-policy.js';
import { connectionPolicy } from './agent-connection-policy.js';
import type { ProviderConfig } from './config.js';

/** 事後の負荷監視とは別に、保守によるローカルモデルのコールドロードを開始前に防ぎます。 */
export class MaintenanceModelDeferred extends Error {
  constructor() { super('ローカルモデルのロード済み状態を確認できないため保守の推論を保留しました。保守からモデルを自動起動・ロードしません。'); }
}

/** 一覧取得だけを使用します。モデル一覧に存在することをロード済みとは扱いません。 */
export async function assertMaintenanceModelReady(agent: string, connection: Pick<AgentConnection,'mode'|'model'|'baseUrl'|'source'>,
  signal?: AbortSignal, request: typeof fetch = fetch, providers?: () => ProviderConfig[]): Promise<void> {
  signal?.throwIfAborted();
  // Gateway自身の待受アドレスではなく、明示されたモデルの実プロバイダーを確認します。
  // 未登録・無効・自動選択モデルは遠隔と推測せず、従来どおり保留します。
  if (connection.source === 'wentian') {
    const separator = connection.model.indexOf('/');
    let configured: ProviderConfig[];
    try {
      // 管理画面から追加・削除された設定も含む、稼働中Gatewayの一覧だけを取得します。
      if (providers) configured = providers();
      else {
        const endpoint = new URL(connection.baseUrl || '');
        if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new MaintenanceModelDeferred();
        endpoint.pathname = endpoint.pathname.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1/providers';
        const timeout = AbortSignal.timeout(3000);
        const response = await request(endpoint, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!response.ok) throw new MaintenanceModelDeferred();
        const payload = await response.json() as { providers?: ProviderConfig[] };
        if (!Array.isArray(payload.providers)) throw new MaintenanceModelDeferred();
        configured = payload.providers;
      }
    } catch { signal?.throwIfAborted(); throw new MaintenanceModelDeferred(); }
    const provider = configured.find(value => value.enabled && value.kind === 'llm' && value.id === connection.model.slice(0, separator));
    if (separator <= 0 || !provider || !connection.model.slice(separator + 1)) throw new MaintenanceModelDeferred();
    return assertMaintenanceModelReady(agent, { mode: 'local', model: connection.model.slice(separator + 1), baseUrl: provider.baseUrl }, signal, request, providers);
  }
  const hosted = agent === 'lmstudio' || agent === 'ollama';
  if (!hosted && connection.mode !== 'local' && !connection.baseUrl) return;
  const base = connection.baseUrl || (agent === 'ollama' ? process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434' : connectionPolicy().localBaseUrl);
  let endpoint: URL;
  try { endpoint = new URL(base); } catch { throw new MaintenanceModelDeferred(); }
  if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new MaintenanceModelDeferred();
  // 利用者が指定した遠隔サーバーは、このマシンのモデル起動制御とは分けます。
  if (!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)) return;
  const paths = agent === 'ollama' ? ['/api/ps'] : agent === 'lmstudio' ? ['/api/v1/models'] : ['/api/v1/models','/api/ps'];
  for (const path of paths) {
    signal?.throwIfAborted();
    try {
      const headers: Record<string,string> = {};
      const key = path === '/api/ps' ? process.env.OLLAMA_API_KEY : process.env.LMSTUDIO_API_KEY;
      if (key) headers.authorization = `Bearer ${key}`;
      const timeout = AbortSignal.timeout(3000);
      const response = await request(new URL(path,endpoint), {headers,signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
      if (!response.ok) continue;
      const payload = await response.json() as { models?: Array<{key?:unknown;name?:unknown;model?:unknown;type?:unknown;loaded_instances?:Array<{id?:unknown}>}> };
      if (!Array.isArray(payload.models)) continue;
      const ready = payload.models.some(model => path === '/api/ps'
        ? model.name === connection.model || model.model === connection.model
        : (model.type === undefined || model.type === 'llm') && Array.isArray(model.loaded_instances) && model.loaded_instances.length > 0
          && (model.key === connection.model || model.loaded_instances.some(instance=>instance.id === connection.model)));
      if (ready) return;
      if (path === '/api/ps') {
        // Ollamaの一覧に明示された遠隔ホストを根拠にし、モデル名のcloud文字列では判定しません。
        // ローカルモデルの一覧に存在するだけでは、コールドロードを許可しません。
        const tags = await request(new URL('/api/tags', endpoint), { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
        if (!tags.ok) continue;
        const catalog = await tags.json() as { models?: Array<{ name?: unknown; model?: unknown; remote_host?: unknown; remote_model?: unknown }> };
        const remote = catalog.models?.find(model => (model.name === connection.model || model.model === connection.model) && typeof model.remote_model === 'string' && model.remote_model.length > 0);
        if (typeof remote?.remote_host === 'string') {
          const host = new URL(remote.remote_host);
          if (host.protocol === 'https:' && !host.username && !host.password && !host.search && !host.hash && !['127.0.0.1','localhost','[::1]'].includes(host.hostname)) return;
        }
      }
    } catch { signal?.throwIfAborted(); }
  }
  throw new MaintenanceModelDeferred();
}
