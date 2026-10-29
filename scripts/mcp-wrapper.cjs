#!/usr/bin/env node
/**
 * 公式SDKの標準入出力（stdio）とStreamable HTTPを橋渡しします。
 * 標準出力はMCP専用、診断は標準エラーです。認証キーは環境変数のみから読みます。
 */
async function main() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { ResultSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const base = (process.env.WENTIAN_MCP_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
  const url = new URL(base.endsWith('/mcp') ? base : `${base}/mcp`);
  const headers = {};
  const key = process.env.WENTIAN_MCP_API_KEY || process.env.WENTIAN_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  // 上流の能力を初期化後に広告し、対応していない機能を宣言しません。
  const client = new Client({ name: 'wentian-stdio-bridge', version: '0.6.0' });
  const http = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  await client.connect(http);
  const server = new Server({ name: 'wentian-gateway', version: '0.6.0' }, { capabilities: client.getServerCapabilities() || {} });
  server.fallbackRequestHandler = async (request, extra) => client.request(
    { method: request.method, params: request.params }, ResultSchema, { signal: extra.signal });
  // 初期化通知は各SDKが処理します。その他の通知は転送します。
  server.fallbackNotificationHandler = async notification => {
    if (notification.method !== 'notifications/initialized') await client.notification(notification);
  };
  client.fallbackNotificationHandler = async notification => server.notification(notification);
  await server.connect(new StdioServerTransport());
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    await http.terminateSession().catch(() => {});
    await client.close(); await server.close();
  };
  process.stdin.on('end', () => { void close(); });
  process.on('SIGINT', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
}
main().catch(error => {
  process.stderr.write(`MCP接続に失敗しました: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
