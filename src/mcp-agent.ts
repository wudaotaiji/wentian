import { createHash } from 'node:crypto';
import type { AgentToolCall } from './agent-tools.js';

export interface McpAgentTool {
  serverId: string; name: string; description?: string; inputSchema: Record<string, unknown>;
}
export interface McpAgentCatalog {
  definitions: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  targets: Map<string, McpAgentTool>;
  warnings?: string[];
}

/** 許可された読み取りツールだけをGatewayから取得し、ローカルツールと衝突しない名前へ変換します。 */
export async function discoverMcpAgentTools(server: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<McpAgentCatalog> {
  const headers = process.env.WENTIAN_API_KEY ? { authorization: `Bearer ${process.env.WENTIAN_API_KEY}` } : undefined;
  const response = await fetcher(`${server.replace(/\/$/, '')}/api/mcp/agent-tools`, {
    headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  // MCP管理権限がないセッションや旧Gatewayでは、既存Agentの機能を維持します。
  if ([401, 403, 404].includes(response.status)) return { definitions: [], targets: new Map() };
  if (!response.ok) throw new Error(`MCPツール一覧を取得できません: HTTP ${response.status}`);
  const payload = await response.json() as { tools?: McpAgentTool[]; errors?: Array<{ serverId: string }> };
  const targets = new Map<string, McpAgentTool>();
  const definitions: McpAgentCatalog['definitions'] = [];
  for (const tool of payload.tools || []) {
    if (typeof tool.serverId !== 'string' || typeof tool.name !== 'string' || !tool.inputSchema) throw new Error('MCPツール一覧の形式が不正です。');
    // 長い外部名や特殊文字もLLMのfunction名制限へ収め、別サーバーの同名を区別します。
    const name = `mcp_${createHash('sha256').update(JSON.stringify([tool.serverId, tool.name])).digest('hex').slice(0, 32)}`;
    targets.set(name, tool);
    definitions.push({ type: 'function', function: { name,
      description: `外部MCPの許可済み読み取りツール ${tool.serverId}/${tool.name}。${tool.description || ''}`.slice(0, 2000),
      parameters: tool.inputSchema } });
  }
  return { definitions, targets, warnings: payload.errors?.map(error => `MCP接続 ${error.serverId} のツール一覧を取得できません。`) };
}

/** 毎回Gateway側でも読み取り許可を再検証するため、途中の無効化・許可取り消しが反映されます。 */
export async function executeMcpAgentTool(server: string, catalog: McpAgentCatalog, call: AgentToolCall,
  signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const target = catalog.targets.get(call.function.name);
  if (!target) throw new Error('許可されたMCPツールではありません。');
  let args: unknown;
  try { args = JSON.parse(call.function.arguments); } catch { throw new Error('MCP引数がJSONではありません。'); }
  const response = await fetcher(`${server.replace(/\/$/, '')}/api/mcp/agent-call`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(process.env.WENTIAN_API_KEY ? { authorization: `Bearer ${process.env.WENTIAN_API_KEY}` } : {}) },
    body: JSON.stringify({ serverId: target.serverId, name: target.name, arguments: args }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`MCPツールを実行できません: HTTP ${response.status}`);
  return JSON.stringify(await response.json());
}
