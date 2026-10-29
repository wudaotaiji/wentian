import assert from 'node:assert/strict';
import test from 'node:test';
import { mcpCommand } from './mcp-command.js';

test('MCP CLI は認証キーをヘッダーにだけ渡し、引数と承認を保持する', async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const fake = (async (url: any, init: any) => { captured = { url: String(url), init }; return new Response(JSON.stringify({ content: [{ type: 'text', text: '成功' }] }), { status: 200 }); }) as typeof fetch;
  const result = await mcpCommand(['call', 'server-one', 'write', '--json', '{"name":"例"}', '--approval-token', 'single-use'], { fetch: fake, apiKey: 'secret', server: 'http://127.0.0.1:9999' });
  assert.equal(captured?.url, 'http://127.0.0.1:9999/api/mcp/servers/server-one/call');
  assert.equal((captured!.init!.headers as Record<string,string>).Authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(captured!.init!.body as string), { name: 'write', arguments: { name: '例' }, approvalToken: 'single-use' });
  assert.match(result, /成功/); assert.doesNotMatch(result, /secret/);
});
test('認証エラーや存在しない API を成功扱いしない', async () => {
  for (const status of [401,403,404,500]) await assert.rejects(mcpCommand(['list'], { fetch: (async () => new Response('秘密の内部エラー', { status })) as typeof fetch }), new RegExp(`HTTP ${status}`));
  await assert.rejects(mcpCommand(['list', '--unknown']), /未対応/);
  await assert.rejects(mcpCommand(['call', 'one']), /ツール名/);
});
