import assert from 'node:assert/strict';
import {openClawResponseText} from './external-orchestrator.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { ExecutionDenied } from './execution-governance.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { validateAgentPlan } from './agent-planner.js';

/** 分類はこの試験の責務ではないため、LLMから受け取る外部レビュー計画を明示します。 */
function fallbackAgentPlan(input: string, requestedAgents: string[] = [], parallel = true) {
  return validateAgentPlan({ intent: 'delegate_external', operation: 'read', required_capabilities: ['review'], delegation: { enabled: true, parallel, requested_agents: requestedAgents } }, input);
}
import { automaticRunnerAgents, buildExternalAgentCommand, canSalvageBuilderFailure, classifyExternalAgentFailure, createOrchestrationTask, detectsForbiddenExternalOperation, formatAgentHandoff, formatExternalAgentHeartbeat, formatTaskOrchestration, isMeaningfulExternalProgress, isRepairableExternalFailure, isSuccessfulExternalOutput, orchestrateExternalTask, selectExternalAgents, selectStagedExternalAgents, terminateProcessTree, validateRoleCompletion } from './external-orchestrator.js';
import { createSequentialExternalFallbackPlan } from './llm-fallback.js';

test('会話履歴の設定ファイルPathをfallbackの作業先にしない', () => {
  const plan = createSequentialExternalFallbackPlan(fallbackAgentPlan('現在のディレクトリを教えて'), '現在のディレクトリを教えて', [
    { role: 'assistant', content: 'C:\\Users\\example\\.kube\\config-dev\\.wentian\\orchestration\\runs\\old' },
  ]);
  const task = createOrchestrationTask(plan, 'C:\\work');
  assert.equal(task.workspace, 'C:\\work');
  assert.equal(task.reportPath.startsWith('C:\\work\\.wentian\\orchestration\\runs\\'), true);
});
import type { ExternalAgentStatus } from './external-agents.js';
import { withVerifiedWork } from './work-test-fixture.js';

const status = (id: string, state: ExternalAgentStatus['state'] = 'available', latencyMs?: number): ExternalAgentStatus => ({ id, name: id, state, stateLabel: state, note: '', freshWithin24Hours: true, liveState: state === 'available' ? 'healthy' : 'probe_failed', latencyMs });

// 外部Agent選択テストが、開発環境に蓄積された実績ファイルの内容へ依存しないようにします。
// テストプロセス専用の一時ファイルを指定し、終了時には環境変数と一時ディレクトリーを復元・削除します。
const previousPerformanceFile = process.env.WENTIAN_AGENT_PERFORMANCE_FILE;
const performanceDirectory = await mkdtemp(path.join(tmpdir(), 'wentian-orchestrator-performance-'));
const testPerformanceFile = path.join(performanceDirectory, 'performance.json');
process.env.WENTIAN_AGENT_PERFORMANCE_FILE = testPerformanceFile;
after(async () => {
  if (previousPerformanceFile === undefined) delete process.env.WENTIAN_AGENT_PERFORMANCE_FILE;
  else process.env.WENTIAN_AGENT_PERFORMANCE_FILE = previousPerformanceFile;
  await rm(performanceDirectory, { recursive: true, force: true });
});

test('Service Unavailableを回答成功として誤採用しない', () => {
  assert.equal(isSuccessfulExternalOutput('ERROR  Service Unavailable\n\n利用可能なLLMモデルがありません。'), false);
  assert.equal(isSuccessfulExternalOutput('No available LLM models'), false);
  assert.equal(isSuccessfulExternalOutput('你好！有什么可以帮你？'), true);
  assert.equal(isSuccessfulExternalOutput('<Bash(command="ls")</Bash>'), false);
  assert.equal(isSuccessfulExternalOutput('Which engine would you like? Awaiting your choice.'), false);
});

test('OpenClawは単発の実作業場所を指定し、JSON封筒の回答本文を検証する',()=>{
  const command=buildExternalAgentCommand('openclaw','確認','C:/work','reviewer',{attempt:0},null)!;
  const agentIndex=command.args.indexOf('agent');assert.deepEqual(command.args.slice(agentIndex,agentIndex+2),['agent','--local']);assert.match(command.args[command.args.indexOf('--message')+1],/役割: reviewer。目的: 確認/);
  assert.ok(command.args.includes('--session-id'));assert.ok(command.args.includes('--json'));assert.ok(!command.args.includes('--cwd'));
  assert.equal(openClawResponseText(JSON.stringify({ok:true,payloads:[{text:'確認応答'}]})),'確認応答');
  assert.equal(openClawResponseText('ログ\n'+JSON.stringify({ok:true,final:'確認応答',payloads:[]})),'確認応答');
  const failure=JSON.stringify({ok:false,status:'error',text:'偽の成功',error:{message:'失敗'}});assert.equal(openClawResponseText(failure),failure);
});

test('制作役割は完了MarkerとBuilder実差分の両方を検証する', () => {
  assert.equal(validateRoleCompletion('builder', '実装しました。\nWENTIAN_ROLE_RESULT: PASS', 2).success, true);
  assert.equal(validateRoleCompletion('builder', '実装しました。\nWENTIAN_ROLE_RESULT: PASS', 0).success, false);
  assert.equal(validateRoleCompletion('tester', '<Bash(command="npm test")</Bash>\nWENTIAN_ROLE_RESULT: PASS').success, false);
  assert.equal(validateRoleCompletion('verifier', 'FPSは存在しません。\nWENTIAN_ROLE_RESULT: FAIL').success, false);
});

test('停止確認済みBuilderの実差分だけを暫定回収する', () => {
  const stopped = { pid: 1, platform: process.platform, requestedAt: '', completedAt: '', attempts: 1, verifiedStopped: true, detail: '' };
  assert.equal(canSalvageBuilderFailure('builder', 'stalled', 1, stopped), true);
  assert.equal(canSalvageBuilderFailure('builder', 'stalled', 0, stopped), false);
  assert.equal(canSalvageBuilderFailure('tester', 'stalled', 1, stopped), false);
  assert.equal(canSalvageBuilderFailure('builder', 'unknown', 1, stopped), false);
  assert.equal(canSalvageBuilderFailure('builder', 'stalled', 1, { ...stopped, verifiedStopped: false }), false);
});

test('外部Agent失敗を修復可能性別に分類する', () => {
  assert.equal(classifyExternalAgentFailure('permission requested: external_directory; auto-rejecting'), 'permission');
  assert.equal(classifyExternalAgentFailure('Unexpected server error'), 'provider');
  assert.equal(classifyExternalAgentFailure('Model not found'), 'model');
  assert.equal(classifyExternalAgentFailure('HTTP 429 rate limit'), 'rate_limit');
  assert.equal(classifyExternalAgentFailure('invalid API key: 401 Unauthorized'), 'authentication');
  assert.equal(classifyExternalAgentFailure('<tool_call>read_file</tool_call>'), 'tool_not_applied');
  assert.equal(classifyExternalAgentFailure('Command failed --message 権限不足\nerror: Cannot find module ./dist/a.js'), 'runtime_dependency');
  assert.equal(classifyExternalAgentFailure('60秒間、意味のある出力を返さず無活動Timeout'), 'stalled');
  assert.equal(isRepairableExternalFailure('provider'), true);
  assert.equal(isRepairableExternalFailure('runtime_dependency'), true);
  assert.equal(isRepairableExternalFailure('authentication'), false);
});

test('標準入力待ち警告を意味のある作業進捗として扱わない', () => {
  assert.equal(isMeaningfulExternalProgress('Warning: no stdin data received in 3s, proceeding without it.'), false);
  assert.equal(isMeaningfulExternalProgress('Wrote file successfully.'), true);
});

test('Package導入とGit状態変更をStreaming段階で禁止操作として検出する', () => {
  assert.equal(detectsForbiddenExternalOperation('⚙ python -m pip install pygame'), true);
  assert.equal(detectsForbiddenExternalOperation('Successfully installed pygame-2.6.1'), true);
  assert.equal(detectsForbiddenExternalOperation('$ git commit -m done'), true);
  assert.equal(detectsForbiddenExternalOperation('Wrote file successfully.'), false);
});

test('LLM fallback候補はHealth確認済みのGooseを優先する', () => {
  const plan = createSequentialExternalFallbackPlan(fallbackAgentPlan('你好！'), '你好！');
  const task = createOrchestrationTask(plan, 'C:\\work');
  assert.deepEqual(selectExternalAgents(task, [status('crush', 'available', 4_000), status('opencode', 'needs_recheck'), status('goose', 'available', 500), status('kilo', 'needs_recheck')]).map(agent => agent.id), ['goose', 'crush']);
});

test('sequential execution retains up to three handoff candidates', () => {
  const plan = fallbackAgentPlan('external agent にレビューを依頼して', [], false);
  const task = createOrchestrationTask(plan, 'C:\\work');
  assert.equal(task.parallel, false);
  assert.deepEqual(selectExternalAgents(task, [status('crush'), status('kilo'), status('opencode')]).map(agent => agent.id), ['crush', 'kilo', 'opencode']);
});

test('explicit Kilo request selects only Kilo', () => {
  const plan = fallbackAgentPlan('Kilo external agent に依頼して', ['kilo'], false);
  const task = createOrchestrationTask(plan, 'C:\\work');
  assert.deepEqual(selectExternalAgents(task, [status('crush'), status('kilo'), status('opencode')]).map(agent => agent.id), ['kilo']);
});

test('外部委譲Task Schemaは書込みを既定許可せず禁止操作を持つ', () => {
  const task = createOrchestrationTask(fallbackAgentPlan('複数外部エージェントに並列レビューを依頼して'), 'C:\\work');
  assert.deepEqual(task.allowedWritePaths, []);
  assert.equal(task.parallel, true);
  assert.ok(task.forbiddenOperations.includes('delete'));
});

test('利用可能かつ必要能力を満たす外部Agentだけを選択する', () => {
  const plan = fallbackAgentPlan('複数外部エージェントに並列レビューを依頼して');
  const task = createOrchestrationTask(plan, 'C:\\work');
  // このテストの責務は適格性の判定であり、動的な性能順位ではないため、順不同の集合として比較します。
  assert.deepEqual(selectExternalAgents(task, [status('goose'), status('cline', 'unavailable'), status('kilo')]).map(agent => agent.id).sort(), ['goose', 'kilo']);
});

test('自動選択では実績スコアが高い外部Agentを優先する', async () => {
  // Healthなどの条件を同一にしたうえで、Kiloのレビュー実績だけを高く設定し、動的順位を検証します。
  const performance = {
    version: '1.0',
    agents: {
      goose: { attempts: 2, successes: 2, consecutiveFailures: 0, averageLatencyMs: 4_000, averageQuality: 0.8, estimatedTokens: 100, estimatedCostUsd: 0, byTask: { review: { attempts: 2, successes: 2, averageLatencyMs: 4_000 } }, updatedAt: new Date(0).toISOString() },
      kilo: { attempts: 2, successes: 2, consecutiveFailures: 0, averageLatencyMs: 500, averageQuality: 0.9, estimatedTokens: 100, estimatedCostUsd: 0, byTask: { review: { attempts: 2, successes: 2, averageLatencyMs: 500 } }, updatedAt: new Date(0).toISOString() },
    },
  };
  await writeFile(testPerformanceFile, `${JSON.stringify(performance, null, 2)}\n`, 'utf8');
  try {
    const task = createOrchestrationTask(fallbackAgentPlan('複数外部エージェントに並列レビューを依頼して'), 'C:\\work');
    assert.deepEqual(selectExternalAgents(task, [status('goose'), status('kilo')]).map(agent => agent.id), ['kilo', 'goose']);
  } finally {
    // 後続テストがこの順位データに影響されないよう、隔離ファイルを空の実績へ戻します。
    await writeFile(testPerformanceFile, `${JSON.stringify({ version: '1.0', agents: {} }, null, 2)}\n`, 'utf8');
  }
});

test('組み込み11外部AgentをHealth確認後の自動選択対象として扱う', () => {
  const expected = ['claude', 'cline', 'codex', 'crush', 'goose', 'hermes', 'kilo', 'lmstudio', 'ollama', 'openclaw', 'opencode'];
  assert.deepEqual([...automaticRunnerAgents].sort(), expected);
  const task = createOrchestrationTask(fallbackAgentPlan('複数外部エージェントに並列レビューを依頼して'), 'C:\\work');
  for (const agent of expected) {
    task.requestedAgents = [agent];
    assert.deepEqual(selectExternalAgents(task, [withVerifiedWork(status(agent))]).map(item => item.id), [agent], `${agent}が選択対象になっていません。`);
  }
});

test('組み込み11外部Agentの非対話ランナーを生成する', () => {
  for (const agent of automaticRunnerAgents) {
    const connection = agent === 'ollama' || agent === 'lmstudio' ? {mode:'native' as const,model:'fixture',status:'verified' as const,checkedAt:'',expiresAt:'',fingerprint:'fixture',policyHash:'fixture'} : undefined;
    const command = buildExternalAgentCommand(agent, '読み取り専用レビュー', 'C:\\work', 'reviewer', {attempt:0}, connection);
    assert.ok(command?.executable, `${agent}の実行ファイルが生成されていません。`);
    assert.ok(command.args.length > 0, `${agent}の引数が生成されていません。`);
  }
  assert.equal(buildExternalAgentCommand('cline', '実装', 'C:\\work', 'builder'), undefined);
});

test('Gooseの制作検証には読取り・Terminal用Developer Extensionを明示する', () => {
  const command = buildExternalAgentCommand('goose', 'ゲームを作る', 'C:\\work', 'tester')!;
  assert.deepEqual(command.args.slice(command.args.indexOf('--with-builtin'), command.args.indexOf('--with-builtin') + 2), ['--with-builtin', 'developer']);
  assert.equal(command.args[command.args.indexOf('--max-turns') + 1], '20');
  assert.match(command.args.at(-1) || '', /成果物は既にBuilder/);
});

test('OpenClawの既定モデルは新ローカルLLMを使用し、明示指定を維持する', () => {
  const previous = process.env.WENTIAN_OPENCLAW_MODEL;
  try {
    delete process.env.WENTIAN_OPENCLAW_MODEL;
    const defaultCommand = buildExternalAgentCommand('openclaw', '読取り専用の接続検証', 'C:\\work', 'reviewer')!;
    assert.equal(defaultCommand.args[defaultCommand.args.indexOf('--model') + 1], 'local-model');
    process.env.WENTIAN_OPENCLAW_MODEL = 'wentian-local/local-model';
    const explicitCommand = buildExternalAgentCommand('openclaw', '読取り専用の接続検証', 'C:\\work', 'reviewer')!;
    assert.equal(explicitCommand.args[explicitCommand.args.indexOf('--model') + 1], 'wentian-local/local-model');
  } finally {
    if (previous === undefined) delete process.env.WENTIAN_OPENCLAW_MODEL;
    else process.env.WENTIAN_OPENCLAW_MODEL = previous;
  }
});

test('Kiloの権限修復ではWorkspaceと自動承認を明示する', () => {
  const initial = buildExternalAgentCommand('kilo', 'レビュー', 'C:\\work', 'reviewer')!;
  const repaired = buildExternalAgentCommand('kilo', 'レビュー', 'C:\\work', 'reviewer', { attempt: 1, failureKind: 'permission', action: 'enable_workspace_auto_approval' })!;
  assert.ok(initial.args.includes('--dir'));
  assert.ok(initial.args.includes('C:\\work'));
  assert.ok(!initial.args.includes('--auto'));
  assert.ok(repaired.args.includes('--auto'));
});

test('OpenCodeはNemotronを主モデルとしProvider障害時に代替モデルへ切り替える', () => {
  const initial = buildExternalAgentCommand('opencode', 'レビュー', 'C:\\work', 'reviewer')!;
  const repaired = buildExternalAgentCommand('opencode', 'レビュー', 'C:\\work', 'reviewer', { attempt: 1, failureKind: 'provider', action: 'switch_model', model: 'opencode/nemotron-3.5-lightning-free' })!;
  assert.equal(initial.args[initial.args.indexOf('--model') + 1], 'opencode/nemotron-3-ultra-free');
  assert.equal(repaired.args[repaired.args.indexOf('--model') + 1], 'opencode/nemotron-3.5-lightning-free');
});

test('LLM fallbackのOpenCode指示は作業報告に必要なワークスペース調査を許し読取り専用に制限する', () => {
  const command = buildExternalAgentCommand('opencode', '[Wentian LLM fallback]\nUser: 今日の作業内容を報告して', 'C:\\work', 'reviewer')!;
  const prompt = command.args.at(-1) || '';
  assert.match(prompt, /作業実績・変更内容/);
  assert.match(prompt, /読み取り専用/);
  assert.match(prompt, /未確認範囲/);
  assert.match(prompt, /秘密情報取得は禁止/);
  assert.doesNotMatch(prompt, /依頼文で明示されない限り行わない/);
});

test('Provider障害を同一Agent内で修復してから次Agentへ進む', async () => {
  const agents = [status('opencode')];
  const commands: string[][] = [];
  const result = await orchestrateExternalTask(fallbackAgentPlan('OpenCode外部エージェントにレビューを依頼して'), { workspace: performanceDirectory, enabled: true }, {
    loadSnapshot: async () => ({ source: 'テスト', cacheFreshWithin24Hours: true, agents, summary: { total: 1, available: 1, candidate: 0, needs_recheck: 0, unavailable: 0 } }),
    readyAgents: async () => agents,
    runCommand: async command => {
      commands.push(command.args);
      return commands.length === 1 ? 'Unexpected server error' : '修復後のレビュー結果';
    },
    repairPlanner: async () => ({ version: '1.0', source: 'ai', action: 'switch_model', model: 'opencode/nemotron-3.5-lightning-free', rationale: 'Provider障害を検出したため許可済みモデルへ切り替えます。' }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.reports[0].success, true);
  assert.equal(result.reports[0].attempts, 2);
  assert.equal(result.reports[0].repairs?.length, 1);
  assert.equal(result.reports[0].repairPlans?.[0]?.source, 'ai');
  assert.equal(commands[0][commands[0].indexOf('--model') + 1], 'opencode/nemotron-3-ultra-free');
  assert.equal(commands[1][commands[1].indexOf('--model') + 1], 'opencode/nemotron-3.5-lightning-free');
});

test('実行許可の拒否はモデル失敗へ計上せず、自動修復で許可を迂回しない',async()=>{
  const agents=[status('opencode')];let calls=0,repairs=0;
  const before=await readFile(testPerformanceFile,'utf8').catch(()=>'');
  const result=await orchestrateExternalTask(fallbackAgentPlan('確認を依頼する'),{workspace:performanceDirectory,enabled:true},{
    loadSnapshot:async()=>({source:'テスト',cacheFreshWithin24Hours:true,agents,summary:{total:1,available:1,candidate:0,needs_recheck:0,unavailable:0}}),readyAgents:async()=>agents,
    runCommand:async()=>{calls++;throw new ExecutionDenied();},repairPlanner:async()=>{repairs++;throw new Error('許可の修復を呼んではいけません。');},
  });
  assert.equal(calls,1);assert.equal(repairs,0);assert.equal(result.reports[0].failureKind,'permission');
  assert.equal(await readFile(testPerformanceFile,'utf8').catch(()=>''),before);
});

test('認証エラーは資格情報を自動変更せず直ちに停止する', async () => {
  const agents = [status('opencode')];
  let calls = 0;
  const result = await orchestrateExternalTask(fallbackAgentPlan('OpenCode外部エージェントにレビューを依頼して'), { workspace: performanceDirectory, enabled: true }, {
    loadSnapshot: async () => ({ source: 'テスト', cacheFreshWithin24Hours: true, agents, summary: { total: 1, available: 1, candidate: 0, needs_recheck: 0, unavailable: 0 } }),
    readyAgents: async () => agents,
    runCommand: async () => { calls += 1; throw new Error('401 Unauthorized: invalid API key'); },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.reports[0].failureKind, 'authentication');
  assert.equal(calls, 1);
});

test('制作タスクでは検収済みGooseもBuilderへ選び、別の読取担当を確保する', () => {
  const task = createOrchestrationTask(fallbackAgentPlan('外部エージェントにファイルを実装して'), 'C:\\work');
  const selected = selectStagedExternalAgents(task, [status('goose'), status('cline'), status('kilo'), status('crush')].map(withVerifiedWork));
  assert.equal(selected[0]?.id, 'goose');
  assert.equal(selected[1]?.id, 'kilo');
  assert.equal(selected.length, 4);
  assert.equal(new Set(selected.map(agent => agent.id)).size, 4);
  assert.ok(selected.slice(2).every(agent => ['crush', 'cline'].includes(agent.id)));
});

test('実装能力検証が未合格の候補はBuilderへ昇格させず、合格記録があれば昇格する', () => {
  const task = createOrchestrationTask(fallbackAgentPlan('外部エージェントにファイルを実装して'), 'C:\\work');
  const agents = [status('kilo'), status('goose'), status('crush')];
  // 接続確認済み・CLI生存確認済みだけでは書込み担当になれません。合否は同一設定の検証履歴だけを見ます。
  assert.deepEqual(selectStagedExternalAgents(task, agents), [], '能力検証の未合格な候補をBuilderへ昇格させています。');
  assert.equal(selectStagedExternalAgents(task, agents.map(withVerifiedWork)).length, 3);
});

test('能力検証が未合格のままなら制作Taskは外部CLIを起動せずに停止理由を残す', async () => {
  const agents = [status('kilo'), status('goose')];
  let calls = 0;
  // 書込みを含む制作Task（staged）は、Builder候補の作業能力検証を必須とします。書き込み範囲は依頼側が repo 全体を明示的に許可しています。
  const plan = { ...validateAgentPlan({ intent: 'delegate_external', required_capabilities: ['file_read', 'file_write', 'terminal'], tools: ['read_file', 'write_file', 'run_command'], delegation: { enabled: true, objective: '外部エージェントにファイルを1つ実装させる' } }, '外部エージェントにファイルを1つ実装させて'), allowedWritePaths: ['.'] };
  const result = await orchestrateExternalTask(plan, { workspace: performanceDirectory, enabled: true }, {
    loadSnapshot: async () => ({ source: 'テスト', cacheFreshWithin24Hours: true, agents, summary: { total: 2, available: 2, candidate: 0, needs_recheck: 0, unavailable: 0 } }),
    readyAgents: async () => agents,
    runCommand: async () => { calls += 1; return '起動されてはなりません'; },
  });
  // 失敗を「候補がいない」と「能力未合格で起動しなかった」で分け、作業者が次動作を判断できるようにします。
  assert.equal(result.status, 'blocked');
  assert.match(result.note || '', /作業能力検証が未合格/);
  assert.match(result.note || '', /wentian agents/);
  assert.equal(result.selectedAgents.length, 0);
  assert.equal(calls, 0, '能力検証の未合格なAgentを起動しています。');
});

test('依頼文で明示したWindows Pathを起動Directoryより優先する', () => {
  const task = createOrchestrationTask(validateAgentPlan({ intent: 'delegate_external', target_path: 'C:\\mywork\\temp', required_capabilities: ['file_read', 'file_write', 'terminal'], tools: ['read_file', 'write_file', 'run_command'], delegation: { enabled: true, objective: '在C:\\mywork\\temp下面做一个游戏' } }, '在C:\\mywork\\temp下面做一个游戏'), 'C:\\mywork\\wentian-gateway');
  assert.equal(task.workspace, 'C:\\mywork\\temp');
});

test('初期編排に目的・Target・担当候補・実行Todosを表示する', () => {
  const task = createOrchestrationTask(validateAgentPlan({ intent: 'delegate_external', target_path: 'C:\\mywork\\temp', required_capabilities: ['file_read', 'file_write', 'terminal'], tools: ['read_file', 'write_file', 'run_command'], delegation: { enabled: true, objective: 'C:\\mywork\\tempでゲームを実装して' } }, 'C:\\mywork\\tempでゲームを実装して'), 'C:\\repo');
  const output = formatTaskOrchestration(task, [status('kilo'), status('goose'), status('crush')]);
  assert.match(output, /Target: C:\\mywork\\temp/);
  assert.match(output, /Builder候補: kilo → goose → crush/);
  assert.match(output, /Tester \/ Verifier候補: kilo → goose → crush/);
  assert.match(output, /Execution Todos/);
});

test('修復後のBuilderにも本作業と同じTimeoutを与える', async () => {
  await writeFile(testPerformanceFile, `${JSON.stringify({ version: '1.0', agents: {} }, null, 2)}\n`, 'utf8');
  const agents = [status('opencode')];
  const timeouts: number[] = [];
  const result = await orchestrateExternalTask(fallbackAgentPlan('OpenCode外部エージェントにレビューを依頼して'), { workspace: performanceDirectory, enabled: true }, {
    loadSnapshot: async () => ({ source: 'テスト', cacheFreshWithin24Hours: true, agents, summary: { total: 1, available: 1, candidate: 0, needs_recheck: 0, unavailable: 0 } }),
    readyAgents: async () => agents,
    runCommand: async (_command, options) => { timeouts.push(options.timeoutMs); return timeouts.length === 1 ? 'Unexpected server error' : '成功'; },
    repairPlanner: async () => ({ version: '1.0', source: 'ai', action: 'retry_same', rationale: '一時障害' }),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(timeouts, [180_000, 180_000]);
});

test('既に終了したPIDのプロセスツリー停止確認を安全に完了できる', async () => {
  const result = await terminateProcessTree(2147483647);
  assert.equal(result.pid, 2147483647);
  assert.equal(result.verifiedStopped, true);
  assert.ok(result.attempts >= 1);
  assert.ok(result.completedAt >= result.requestedAt);
});

test('Windowsでは親子プロセスを停止してから完了を返す', { skip: process.platform !== 'win32' }, async () => {
  // テスト専用のNode.js親プロセスから、待機し続ける子プロセスを1つ起動します。
  const script = "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);console.log(c.pid);setInterval(()=>{},1000)";
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const childPid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('子PIDの取得がTimeoutしました。')), 5_000);
    parent.stdout.once('data', chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
  });
  assert.ok(parent.pid);
  const result = await terminateProcessTree(parent.pid!);
  assert.equal(result.verifiedStopped, true);
  const exists = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(exists(parent.pid!), false);
  assert.equal(exists(childPid), false);
});

test('外部Agent Heartbeatは役割・Agent・PID・出力量を表示する', () => {
  const originalNow = Date.now; Date.now = () => 25_000;
  try {
    const output = formatExternalAgentHeartbeat({ role: 'builder', agent: 'opencode', pid: 1234, startedAt: 5_000, lastOutputAt: 20_000, receivedBytes: 4096 });
    assert.match(output, /Working builder \(20s/);
    assert.match(output, /agent=opencode, pid=1234/);
    assert.match(output, /last-output=5s ago, received=4096 bytes/);
  } finally { Date.now = originalNow; }
});

test('利用制限と一般失敗を区別して次Agentへの引継ぎを表示する', () => {
  assert.match(formatAgentHandoff('codex', 'kilo', 'builder', 'HTTP 429 rate limit'), /codexが利用制限で停止したため、kiloがbuilderを引き継ぎます/);
  assert.match(formatAgentHandoff('goose', 'crush', 'verifier', 'exit code 1'), /gooseが失敗で停止したため、crushがverifierを引き継ぎます/);
});
