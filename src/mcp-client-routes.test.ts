import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerMcpClientRoutes } from './mcp-client-routes.js';
import type { McpClientManager } from './mcp-client.js';
import { request } from 'node:http';

// 通信管理者を置き換え、外部接続なしで認証境界と本文の扱いを検証します。
function fixture(admin = true, identity = true) {
  const calls: any[] = [];
  const manager = {
    list: () => [{ id: 'one', transport: 'http', url: 'http://example.test/mcp', allowedTools: ['read','write'], readOnlyTools: ['read'], connected: false, pending: 0 }],
    request: async (...args: any[]) => { calls.push(args); return { tools: [{ name: 'read', inputSchema: {} },{ name: 'write', inputSchema: {} }] }; },
    callTool: async (...args: any[]) => { calls.push(args); return { content: [] }; },
    approve: (...args: any[]) => { calls.push(args); return 'token'; },
    register: async (...args: any[]) => { calls.push(args); },
  } as unknown as McpClientManager;
  const app = Fastify(); registerMcpClientRoutes(app, { manager, authorizeAdmin: () => admin, identity: () => identity ? { id: 'authenticated-user' } : undefined });
  return { app, calls };
}
test('MCP 管理 API は管理者と認証主体を必要とする', async () => {
  for (const [admin,identity,status] of [[false,true,403],[true,false,401]] as const) {
    const { app,calls } = fixture(admin,identity); try { const response = await app.inject({ method: 'POST', url: '/api/mcp/servers/one/approve', payload: { name: 'write', subject: 'forged' } }); assert.equal(response.statusCode,status); assert.equal(calls.length,0); } finally { await app.close(); }
  }
});
test('クロスオリジン変更を拒否し、承認主体の偽装を無視する', async () => {
  const { app,calls } = fixture(); try {
    const denied = await app.inject({ method: 'POST', url: '/api/mcp/servers/one/approve', headers: { origin: 'http://evil.test' }, payload: { name: 'write' } }); assert.equal(denied.statusCode,403); assert.equal(calls.length,0);
    const ok = await app.inject({ method: 'POST', url: '/api/mcp/servers/one/approve', payload: { name: 'write', arguments: { path: 'one' }, subject: 'forged' } }); assert.equal(ok.statusCode,200); assert.equal(calls[0][3].subject,'authenticated-user'); assert.equal(ok.json().approvalToken,'token');
  } finally { await app.close(); }
});
test('Agent は明示的な読み取りツールだけを発見・実行する', async () => {
  const { app,calls } = fixture(); try {
    const list = await app.inject('/api/mcp/agent-tools'); assert.deepEqual(list.json().tools.map((t: any) => t.name),['read']);
    const denied = await app.inject({ method: 'POST', url: '/api/mcp/agent-call', payload: { serverId: 'one', name: 'write', approvalToken: 'token' } }); assert.equal(denied.statusCode,403);
    const ok = await app.inject({ method: 'POST', url: '/api/mcp/agent-call', payload: { serverId: 'one', name: 'read' } }); assert.equal(ok.statusCode,200); assert.equal(calls.at(-1)[3].subject,'authenticated-user');
  } finally { await app.close(); }
});

test('一部の接続失敗を明示して、正常な Agent ツールを残す', async () => {
  const app = Fastify();
  const config = { transport: 'http', allowedTools: ['read'], readOnlyTools: ['read'] };
  const manager = { list: () => [{ ...config,id:'bad' },{ ...config,id:'good' }], request: async (id: string) => { if (id === 'bad') throw Error('secret'); return { tools:[{name:'read'}] }; } } as unknown as McpClientManager;
  registerMcpClientRoutes(app,{ manager, authorizeAdmin:()=>true, identity:()=>({id:'admin'}) });
  try { const response = await app.inject('/api/mcp/agent-tools'); assert.equal(response.statusCode,200); assert.equal(response.json().tools[0].serverId,'good'); assert.equal(response.json().errors[0].serverId,'bad'); assert.doesNotMatch(response.body,/secret/); }
  finally { await app.close(); }
});

test('HTTP 切断は管理操作の AbortSignal を中断する', async () => {
  const app = Fastify(); let client: ReturnType<typeof request>;
  let done!: () => void; const cancelled = new Promise<void>(resolve => { done=resolve; });
  const manager = { request: async (_id: string,_op: string,_params: unknown,context: {signal:AbortSignal}) => {
    queueMicrotask(()=>client.destroy());
    await new Promise((_resolve,reject)=>context.signal.addEventListener('abort',()=>{ done();reject(Error('中断')); },{once:true}));
  } } as unknown as McpClientManager;
  registerMcpClientRoutes(app,{manager,authorizeAdmin:()=>true,identity:()=>({id:'admin'})});
  try {
    const address = await app.listen({host:'127.0.0.1',port:0});
    client=request(address+'/api/mcp/servers/one/request',{method:'POST',headers:{'Content-Type':'application/json'} }); client.on('error',()=>{});client.end(JSON.stringify({operation:'ping'}));
    await Promise.race([cancelled,new Promise((_resolve,reject)=>{ const timer=setTimeout(()=>reject(Error('中断通知が届きません。')),3000);timer.unref(); })]);
  } finally { await app.close(); }
});
