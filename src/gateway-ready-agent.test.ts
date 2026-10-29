import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGatewayReadyAgents } from './gateway-ready-agent.js';
import { buildReadySnapshot } from './external-agent-readiness.js';
import { withVerifiedWork } from './work-test-fixture.js';

function ready() {
  const agents = ['claude', 'hermes', 'cline'].map(id => ({ id, name: id, state: 'available' as const, stateLabel: '正常', note: 'テスト用', freshWithin24Hours: true, liveState: 'healthy' as const, latencyMs: id === 'claude' ? 1 : 10 }));
  return buildReadySnapshot({ source: 'テスト', agents: agents.map(withVerifiedWork), cacheFreshWithin24Hours: true, summary: { total: 3, available: 3, candidate: 0, needs_recheck: 0, unavailable: 0 } }, 300000);
}

test('Actionは正常確認済みの制作可能なAgentを自動選択し、指定リポジトリで実行する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-ready-action-'));
  const calls: any[] = [];
  try {
    await writeFile(path.join(root, 'app.txt'), 'old'); await writeFile(path.join(root, 'criteria.txt'), '固定検証条件');
    await mkdir(path.join(root, '.wentian'));
    await writeFile(path.join(root, '.wentian/acceptance.json'), JSON.stringify({ version: 1, protectedFiles: ['criteria.txt'], commands: [{ id: 'content', criterion: 'app.txtがnew', executable: process.execPath, args: ['-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('app.txt','utf8'),'new')"], timeoutMs: 5000 }] }));
    const service = createGatewayReadyAgents({ snapshot: async () => ready(), run: async (command, options) => { calls.push({ command, options }); await writeFile(path.join(options.cwd, 'app.txt'), 'new'); return 'ファイルを読み、修正してテストしました。\nWENTIAN_ROLE_RESULT: PASS'; } });
    const reply = await service.action({ name: '実装担当', role: '開発', model: 'unused/model' }, [{ role: 'user', content: '対象を修正してください。' }], { mode: 'action', repository: root, model: 'ignored/model' });
    assert.notEqual(calls[0].options.cwd, root);
    assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'new');
    assert.ok(['claude', 'hermes'].includes(calls[0].options.agent));
    assert.ok(calls[0].command.args.some((arg: string) => arg.includes('ファイル作成・編集を許可')));
    assert.equal(reply.execution.source, 'managed-agent');
    assert.equal(reply.execution.attempts[0].success, true);
    assert.ok(reply.content.includes('実行エージェント: ' + calls[0].options.agent));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Action失敗では別Agentへ重複投入せず、正常確認なしでは実行しない', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-ready-failure-'));
  let count = 0;
  const member = { name: '担当', role: '開発', model: 'unused' };
  try {
    const failed = createGatewayReadyAgents({ snapshot: async () => ready(), run: async () => { count++; throw new Error('途中失敗'); } });
    const reply = await failed.action(member, [], { mode: 'action', repository: root });
    assert.equal(count, 1); assert.equal(reply.execution.attempts[0].success, false);
    const stale = ready(); stale.refreshedAt = '2000-01-01T00:00:00Z';
    const service = createGatewayReadyAgents({ snapshot: async () => stale, run: async () => { throw new Error('実行禁止'); } });
    await assert.rejects(service.action(member, [], { mode: 'action', repository: root }), /確認完了/);
    const unhealthy = ready(); for (const agent of unhealthy.agents) agent.liveState = 'probe_failed';
    await assert.rejects(createGatewayReadyAgents({ snapshot: async () => unhealthy }).action(member, [], { mode: 'action', repository: root }), /正常確認済み/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('トップ相談も正常確認済みAgentを自動選択し、操作ツールなしでJSON案を返す', async () => {
  const calls: any[] = [];
  const service = createGatewayReadyAgents({ snapshot: async () => ready(), run: async (command, options) => {
    calls.push({ command, options });
    return JSON.stringify({ message: '相談結果', site: { headline: '提案' } });
  } });
  const output = await service.design('ignored/model', [{ role: 'system', content: 'JSONで案を返してください。' }, { role: 'user', content: '青いページ' }]);
  assert.equal(JSON.parse(output).message, '相談結果');
  assert.equal(calls[0].options.agent, 'claude');
  assert.equal(calls[0].options.role, 'site-design');
  assert.ok(calls[0].command.args.includes('--tools'));
  assert.equal(calls[0].command.args[calls[0].command.args.indexOf('--tools') + 1], '');
  assert.notEqual(calls[0].options.cwd, process.cwd());
});
