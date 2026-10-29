import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { TeamAccessService } from './team-access.js';
import { registerTeamGateway } from './team-gateway.js';

test('仮想キーの実要求はモデル許可と利用枠を通り、計量の自己確定は拒否する', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-team-gateway-'));
  const service = new TeamAccessService({ root });
  await service.createUser({ id: 'admin', displayName: '管理者', platformAdmin: true }, { kind: 'system' });
  const admin = { kind: 'user' as const, userId: 'admin' };
  await service.createProject({ id: 'project-a', name: '試験', ownerId: 'admin' }, admin);
  await service.updateProject('project-a', { allowedModels: ['example/model'], requestLimit: { maxRequests: 1, windowMs: 60000 }, pricing: { 'example/model': { inputUsdPerMTok: 1, outputUsdPerMTok: 1 } } }, admin);
  const key = await service.issueKey('project-a', '試験キー', admin);
  const app = Fastify(); registerTeamGateway(app, service);
  let upstreamCalls = 0;
  app.post('/v1/chat/completions', async () => { upstreamCalls++; return { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }; });
  app.get('/v1/models', async () => ({ data: [{ id: 'example/model' }, { id: 'secret/model' }] }));
  app.post('/api/team-access/usage/commit', async () => ({ bypassed: true }));
  const headers = { 'x-team-virtual-key': key.key };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { model: 'secret/model' } })).statusCode, 403);
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { model: 'example/model', messages: [] } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['x-wentian-usage-source'], 'upstream');
    assert.equal((await service.projectUsage('project-a', admin)).project.spendUsd, 0.00003);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { model: 'example/model' } })).statusCode, 429);
    assert.equal(upstreamCalls, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/api/team-access/usage/commit', headers, payload: {} })).statusCode, 403);
    assert.deepEqual((await app.inject({ url: '/v1/models', headers })).json().data, [{ id: 'example/model' }]);
  } finally { await app.close(); }
});
