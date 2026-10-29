import { MaintenanceResourcePause } from './maintenance-resources.js';
import {tmpdir} from 'node:os';
import {hasWorkReadReceipt,hasHostedWorkReadReceipt} from './agent-work-maintenance.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyAgentWork } from './agent-work-maintenance.js';
import { WORK_ATTENTION_RETRY_MS, WORK_RETRY_BASE_MS, classifyWorkFailure, readWorkEvidence, workAllowsExecution, workCachePath, workEvidenceState, workFailureRetryAt, type AgentWorkEvidence } from './agent-work-policy.js';
import { buildReadySnapshot } from './external-agent-readiness.js';
import type { ExternalAgentStatus } from './external-agents.js';

function candidate(): ExternalAgentStatus {
  return { id: 'opencode', name: 'OpenCode', state: 'available', stateLabel: '', note: '', liveState: 'healthy', freshWithin24Hours: true, version: 'test-cli',
    connection: { mode: 'free', model: 'opencode/example-free', fingerprint: 'test-config', policyHash: 'test-policy', cliVersion: 'test-cli', status: 'verified', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() } };
}
async function reset() { await mkdir(path.dirname(workCachePath()), { recursive: true }); await writeFile(workCachePath(), JSON.stringify({ agents: {} })); }

test('接続だけ成功したAgentを実装・試験・検証の候補へ昇格させない', async () => {
  await reset();
  const agent = candidate();
  const ready = buildReadySnapshot({ source: 'test', agents: [agent], cacheFreshWithin24Hours: true, summary: { total: 1, available: 1, candidate: 0, needs_recheck: 0, unavailable: 0 } }, 300_000);
  assert.deepEqual(ready.pools.text, ['opencode']);
  assert.deepEqual(ready.pools.reading, []);
  assert.deepEqual(ready.pools.coding, []);
  assert.deepEqual(ready.pools.testing, []);
  assert.deepEqual(ready.pools.verification, []);
});

test('単体とWentian経由の同一小修正をホスト検収し、証拠と能力を保存する', { timeout: 30_000 }, async () => {
  await reset();
  const agent = candidate();
  const calls: string[] = [];
  const result = await verifyAgentWork(agent, undefined, async (command, options) => {
    calls.push(options.role!);
    assert.ok(command.args.includes('opencode/example-free'));
    const nonce = await readFile(path.join(options.cwd, 'input.txt'), 'utf8');
    if (options.role === 'work-standalone' || options.role === 'builder') await writeFile(path.join(options.cwd, 'output.json'), JSON.stringify({ value: nonce, enabled: false, custom: 'keep' }));
    if (options.role === 'tester' || options.role === 'verifier') await promisify(execFile)(process.execPath, ['verify.cjs', options.role], { cwd: options.cwd });
    return `WENTIAN_WORK_READ:${nonce}\nWENTIAN_ROLE_RESULT: PASS`;
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(calls, ['work-standalone', 'builder', 'tester', 'verifier']);
  assert.equal(workAllowsExecution(agent, 'coding'), true);
  assert.equal(workAllowsExecution({ ...agent, version: 'changed-cli' }, 'coding'), false);
  assert.equal(workAllowsExecution({ ...agent, connection: { ...agent.connection!, model: 'opencode/changed-free' } }, 'coding'), false);
  assert.equal(workAllowsExecution(agent, 'coding', Date.now() + 2 * 86_400_000), false);
  const comparison = JSON.parse(await readFile(path.join(result.evidenceDirectory, 'comparison.json'), 'utf8'));
  assert.equal(comparison.legs.standalone.passed, true);
  assert.equal(comparison.legs.wentian.passed, true);
  const cached = await verifyAgentWork(agent, undefined, async () => { throw new Error('有効な能力記録を再利用せず実行しています。'); });
  assert.equal(cached.evidenceDirectory, result.evidenceDirectory);
  await writeFile(workCachePath(),JSON.stringify({agents:{[agent.id]:{...result,capabilities:{reading:true}}}}));
  let rechecked=false;
  const incomplete=await verifyAgentWork(agent,undefined,async()=>{rechecked=true;throw Error('不足している能力を新規確認します');});
  assert.equal(rechecked,true,'読取だけの合格は編集・試験・検収の再確認を省略しません');assert.equal(incomplete.status,'failed');
});

test('応答に成功文字列があっても実ファイルが未修正なら能力を付与しない', async () => {
  await reset();
  const agent = candidate();
  const result = await verifyAgentWork(agent, undefined, async (_command, options) => `WENTIAN_WORK_READ:${await readFile(path.join(options.cwd, 'input.txt'), 'utf8')}\nWENTIAN_ROLE_RESULT: PASS`);
  assert.equal(result.status, 'failed');
  assert.equal(workAllowsExecution(agent, 'coding'), false);
});

test('単体成功でもWentian経由で失敗したAgentを実装候補へ入れない', async () => {
  await reset();
  const agent = candidate();
  const result = await verifyAgentWork(agent, undefined, async (_command, options) => {
    const nonce = await readFile(path.join(options.cwd, 'input.txt'), 'utf8');
    if (options.role === 'work-standalone') await writeFile(path.join(options.cwd, 'output.json'), JSON.stringify({ value: nonce, enabled: false, custom: 'keep' }));
    return `WENTIAN_WORK_READ:${nonce}\nWENTIAN_ROLE_RESULT: PASS`;
  });
  assert.equal(result.status, 'failed');
  assert.equal(workAllowsExecution(agent, 'coding'), false);
});

/** 再試行待ちの能力検証を強制的に再投入できるようにし、連続失敗の台帳だけを検査します。 */
async function expireRetryWait(): Promise<void> {
  const target = workCachePath();
  const store = JSON.parse(await readFile(target, 'utf8'));
  for (const item of Object.values(store.agents) as Array<{ retryAt: string }>) item.retryAt = new Date(Date.now() - 1_000).toISOString();
  await writeFile(target, JSON.stringify(store));
}

test('上流利用制限の失敗は種別・連続回数・次回再試行を記録し、待機中は再検証しない', { timeout: 60_000 }, async () => {
  await reset();
  const agent = candidate();
  let calls = 0;
  const limited: Parameters<typeof verifyAgentWork>[2] = async () => {
    calls++;
    throw Object.assign(new Error('上流プロバイダーが利用制限で応答しませんでした。'), { name: 'GatewayRequestError', failure: { gatewayStatus: 503, upstreamStatus: 429, provider: 'lmstudio', retryAfter: '30' } });
  };
  const first = await verifyAgentWork(agent, undefined, limited);
  assert.equal(first.status, 'failed');
  assert.equal(first.failureKind, 'upstream_limit', '上流の利用制限をWentian側の未完了と区別します。');
  assert.equal(first.failures, 1);
  assert.equal(first.attentionRequired, false);
  assert.equal(workAllowsExecution(agent, 'coding'), false);
  // 失敗直後は再試行待ちとし、同じ設定の実作業を連続投入しません。
  assert.ok(Date.parse(first.retryAt) > Date.now());
  const held = await verifyAgentWork(agent, undefined, async () => { throw new Error('再試行待ちの能力検証を再実行しています。'); });
  assert.equal(held.evidenceDirectory, first.evidenceDirectory);
  assert.equal(calls, 1);
  // 上流の情報（Retry-After）は失敗資料へ残し、作業者が原因を確定できるようにします。
  const failure = JSON.parse(await readFile(path.join(first.evidenceDirectory, 'failure.json'), 'utf8'));
  assert.equal(failure.failureKind, 'upstream_limit');
  assert.equal(failure.upstream.retryAfter, '30');
  // 同一設定の連続失敗として数え、再試行間隔を伸ばします。
  await expireRetryWait();
  const second = await verifyAgentWork(agent, undefined, limited);
  assert.equal(second.failures, 2);
  assert.ok(Date.parse(second.retryAt) - Date.parse(second.checkedAt) >= WORK_RETRY_BASE_MS * 2 - 60_000);
  // 上限到達で自動再試行を止め、人へ引き渡します（24時間ぶんの間隔を空けます）。
  await expireRetryWait();
  const third = await verifyAgentWork(agent, undefined, limited);
  assert.equal(third.failures, 3);
  assert.equal(third.attentionRequired, true);
  assert.match(third.manualCheckCommand || '', /^Set-Location -LiteralPath /, '3回失敗時に実際のCLI作業検証を再実行するコマンドを保存します。');
  assert.match(third.reason, /利用者対応待ち/);
  assert.ok(Date.parse(third.retryAt) - Date.parse(third.checkedAt) >= WORK_ATTENTION_RETRY_MS - 60_000);
  assert.deepEqual(readWorkEvidence()[agent.id], third);
});

test('失敗要因の分類・再試行間隔・状態名称を台帳と同じ規則で決める', () => {
  const withFailure = (failure: unknown) => Object.assign(new Error('確認中の失敗です。'), { failure });
  assert.equal(classifyWorkFailure(withFailure({ upstreamStatus: 402 })), 'upstream_limit');
  assert.equal(classifyWorkFailure(withFailure({ upstreamStatus: 429 })), 'upstream_limit');
  assert.equal(classifyWorkFailure(withFailure({ upstreamStatus: 503 })), 'upstream_error');
  assert.equal(classifyWorkFailure(Object.assign(new Error('確認中です。'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(classifyWorkFailure(Object.assign(new Error('確認中です。'), { name: 'AbortError' })), 'cancelled');
  assert.equal(classifyWorkFailure(Object.assign(new Error('確認中です。'), { termination: { verifiedStopped: false } })), 'unsafe_process');
  assert.equal(classifyWorkFailure(new Error('HTTP 503 で接続できませんでした。')), 'upstream_error');
  // どの上流要因にも当たらない不一致は、実作業が条件を満たさなかった扱いにします。
  assert.equal(classifyWorkFailure(new Error('実ファイル読取りの結果が一致しません。')), 'work_incomplete');
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  assert.equal(workFailureRetryAt(1, now), now + WORK_RETRY_BASE_MS);
  assert.equal(workFailureRetryAt(2, now), now + WORK_RETRY_BASE_MS * 2);
  assert.equal(workFailureRetryAt(3, now), now + WORK_ATTENTION_RETRY_MS);
  const evidence = (over: Partial<AgentWorkEvidence>): AgentWorkEvidence => ({ revision: 1, identity: 'test', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(), retryAt: new Date(now + 900_000).toISOString(), status: 'failed', capabilities: {}, evidenceDirectory: 'test', reason: '', ...over });
  assert.equal(workEvidenceState(undefined, now), 'unverified');
  assert.equal(workEvidenceState(evidence({ status: 'passed' }), now), 'passed');
  assert.equal(workEvidenceState(evidence({ status: 'passed', expiresAt: new Date(now - 1).toISOString() }), now), 'expired');
  assert.equal(workEvidenceState(evidence({ attentionRequired: true }), now), 'attention_required');
  assert.equal(workEvidenceState(evidence({}), now), 'retry_pending');
  assert.equal(workEvidenceState(evidence({ retryAt: new Date(now - 1).toISOString() }), now), 'unverified');
});

test('読取りマーカーの区切り空白を許容し、値の相違と引用エコーを拒否する',()=>{
 assert.equal(hasWorkReadReceipt('WENTIAN_WORK_READ: nonce','nonce'),true);
 assert.equal(hasWorkReadReceipt('WENTIAN_WORK_READ:nonce','nonce'),true);
 assert.equal(hasWorkReadReceipt('WENTIAN_WORK_READ:other','nonce'),false);
 assert.equal(hasWorkReadReceipt('prompt: WENTIAN_WORK_READ:nonce','nonce'),false);
});


test('Wentianツールの読取は実行記録で検収し、回答だけ・別役割・別ファイルを採用しない',async()=>{
 const workspace=await mkdtemp(path.join(tmpdir(),'wentian-hosted-receipt-'));
 const directory=path.join(workspace,'.wentian/hosted-agent');await mkdir(directory,{recursive:true});
 const file=path.join(directory,'1-builder.json');
 const value={agent:'lmstudio',role:'builder',history:[{decision:{kind:'tool',name:'read_file',arguments:{path:'input.txt'}},result:'nonce'}]};
 await writeFile(file,JSON.stringify(value));
 assert.equal(await hasHostedWorkReadReceipt(workspace,'lmstudio','builder','nonce'),true);
 assert.equal(await hasHostedWorkReadReceipt(workspace,'ollama','builder','nonce'),false);
 assert.equal(await hasHostedWorkReadReceipt(workspace,'lmstudio','tester','nonce'),false);
 assert.equal(await hasHostedWorkReadReceipt(workspace,'lmstudio','builder','other'),false);
 value.history[0].decision.arguments.path='different.txt';await writeFile(file,JSON.stringify(value));
 assert.equal(await hasHostedWorkReadReceipt(workspace,'lmstudio','builder','nonce'),false);
 await writeFile(file,JSON.stringify({agent:'lmstudio',role:'builder',answer:'WENTIAN_WORK_READ:nonce',history:[]}));
 assert.equal(await hasHostedWorkReadReceipt(workspace,'lmstudio','builder','nonce'),false);
});


test('資源停止はAgentの失敗回数と再試行待ちへ加算しない',async()=>{
  await reset();const agent=candidate(),controller=new AbortController();
  await assert.rejects(verifyAgentWork(agent,controller.signal,async()=>{
    const error=new MaintenanceResourcePause('paused',{cpu:95,memory:30,disk:10,network:0});controller.abort(error);throw error;
  }),MaintenanceResourcePause);
  assert.equal(readWorkEvidence()[agent.id],undefined);
});
