import { readFile } from 'node:fs/promises';

export interface McpCommandOptions { fetch?: typeof fetch; server?: string; apiKey?: string }

/** CLI は稼働中の管理 API を使います。ローカル設定を直接変更せず、認証・承認を必ず通します。 */
export async function mcpCommand(args: string[], options: McpCommandOptions = {}): Promise<string> {
  const value = (flag: string) => { const index = args.indexOf(flag); if (index < 0) return undefined; const val = args[index + 1]; if (!val || val.startsWith('--')) throw new Error(`${flag} の値が必要です。`); return val; };
  const positional: string[] = [];
  const flags = new Set(['--server', '--config', '--json', '--approval-token']);
  for (let i = 0; i < args.length; i++) { if (flags.has(args[i])) { value(args[i]); i++; } else if (args[i].startsWith('--')) throw new Error(`未対応のオプションです: ${args[i]}`); else positional.push(args[i]); }
  const [action = 'list', id, target] = positional;
  const count = ['list', 'add'].includes(action) ? 1 : ['request', 'approve', 'call'].includes(action) ? 3 : 2;
  if (positional.length > count) throw new Error('余分な引数があります。JSON は --json に指定してください。');
  const base = new URL(value('--server') ?? options.server ?? process.env.WENTIAN_SERVER ?? 'http://127.0.0.1:8787');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('接続先 URL が不正です。');
  const invoke = options.fetch ?? fetch;
  const key = options.apiKey ?? process.env.WENTIAN_API_KEY;
  let method = 'GET', path = '/api/mcp/servers', payload: unknown;
  if (action !== 'list' && action !== 'add' && !id) throw new Error('接続 ID が必要です。');
  const root = `${path}/${encodeURIComponent(id ?? '')}`;
  const json = () => JSON.parse(value('--json') ?? '{}');
  switch (action) {
    case 'list': break;
    case 'add': case 'update': {
      const file = value('--config'); if (!file) throw new Error('--config に設定 JSON ファイルを指定してください。');
      payload = JSON.parse(await readFile(file, 'utf8')); method = action === 'add' ? 'POST' : 'PUT'; path = action === 'add' ? path : root; break;
    }
    case 'remove': method = 'DELETE'; path = root; break;
    case 'enable': case 'disable': case 'connect': case 'disconnect': case 'reconnect': method = 'POST'; path = `${root}/${action}`; payload = {}; break;
    case 'notifications': path = `${root}/notifications`; break;
    case 'tools': case 'resources': case 'templates': case 'prompts': case 'ping': method = 'POST'; path = `${root}/request`; payload = { operation: ({ tools: 'tools/list', resources: 'resources/list', templates: 'resources/templates/list', prompts: 'prompts/list', ping: 'ping' })[action], params: json() }; break;
    case 'request': if (!target) throw new Error('操作名が必要です。'); method = 'POST'; path = `${root}/request`; payload = { operation: target, params: json() }; break;
    case 'approve': case 'call': if (!target) throw new Error('ツール名が必要です。'); method = 'POST'; path = `${root}/${action}`; payload = { name: target, arguments: json(), approvalToken: value('--approval-token') }; break;
    default: throw new Error('MCP 操作: list | add | update | remove | enable | disable | connect | disconnect | reconnect | tools | resources | templates | prompts | ping | request | approve | call | notifications');
  }
  const response = await invoke(new URL(path, base), { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(310_000) });
  if (!response.ok) throw new Error(`MCP 管理 API が拒否しました (HTTP ${response.status})。認証・権限・入力・接続状態を確認してください。`);
  return JSON.stringify(await response.json(), null, 2);
}
