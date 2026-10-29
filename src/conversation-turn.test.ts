import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setForcedAgent, readAgentManagement } from './agent-management.js';
import { selectGroupAgents } from './group-agent-responder.js';
import { classifyWithExternalAgent } from './planner-fallback.js';
import { requestConversationTurn, parseConversationDecision, formatConversationExecution, conversationEntryModel } from './conversation-turn.js';
import { buildReadySnapshot } from './external-agent-readiness.js';
import { ExecutionDenied } from './execution-governance.js';

const answer = { kind: 'answer', language: 'zh', answer: '你好！有什么可以帮你？' };

test('CLIの会話入口はローカル限定指定を全経路の自動選択へ切り替える',()=>{
 assert.equal(conversationEntryModel('wentian-auto/local'),'wentian-auto/all');
 for(const model of ['wentian-auto/all','wentian-auto/remote','provider/model'])assert.equal(conversationEntryModel(model),model);
});

test('実行許可不足はAgent障害として記録せず、承認先を診断する',async t=>{
 const previousFallback=process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK;process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK='true';
 t.after(()=>{if(previousFallback===undefined)delete process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK;else process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK=previousFallback;});
 let recorded=0;const called:string[]=[];
 const deps={snapshot:async()=>snapshot(),fetch:(async()=>Response.json({error:{message:'unavailable'}},{status:503})) as typeof fetch,score:()=>0,record:async()=>{recorded++;},command:(id:string)=>({executable:id,args:[]}),run:(async(_command:unknown,options:{agent:string})=>{called.push(options.agent);throw new ExecutionDenied();}) as typeof import('./external-orchestrator.js').runExternalCommand};
 await assert.rejects(requestConversationTurn('你好！',[],'http://fixture','fixture',undefined,undefined,deps),/kilo: 実行範囲の設定が必要（Agent画面でプロジェクト範囲・取消状態を確認）.*opencode: 実行範囲の設定が必要（Agent画面でプロジェクト範囲・取消状態を確認）/);
 assert.deepEqual(called,['kilo','opencode']);
 assert.equal(recorded,0,'許可不足を性能台帳の失敗として扱いません');
});

test('ホストの既定パスの再掲だけを正規化し、履歴由来の別パスは拒否する',()=>{
 const plan={intent:'local_tool',operation:'read',evidence_source:'workspace',tools:['read_file'],required_capabilities:['file_read'],target_path:'C:\\workspace'};
 const value=parseConversationDecision(JSON.stringify({kind:'task',plan}),'仕組みを説明して','C:\\workspace');assert.equal(value.kind,'task');if(value.kind==='task')assert.equal(value.plan.targetPath,undefined);
 assert.throws(()=>parseConversationDecision(JSON.stringify({kind:'task',plan:{...plan,target_path:'C:\\old-history'}}),'仕組みを説明して','C:\\workspace'));
});

test('wrapper省略の分類計画を受理し、明示された作業先を作成範囲として検証する',()=>{
 const input='做一个网页版的射击小游戏 C:\\temp';
 const plan={version:'1.0',intent:'local_tool',operation:'write',evidence_source:'none',execution_mode:'auto',target_path:'C:\\temp',language:'zh',required_capabilities:['text','file_write'],tools:['write_file'],attachments:[],delegation:{enabled:false,parallel:false,requested_agents:[]}};
 const value=parseConversationDecision(JSON.stringify(plan),input,'C:\\mywork\\wentian-gateway');
 assert.equal(value.kind,'task');
 if(value.kind==='task'){assert.equal(value.plan.targetPath,'C:\\temp');assert.deepEqual(value.plan.allowedWritePaths,['.']);}
 assert.throws(()=>parseConversationDecision(JSON.stringify({...(plan as any),target_path:'C:\\other'}),input,'C:\\mywork\\wentian-gateway'));
});
const responding = (value: unknown) => (async () => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }], usage: { total_tokens: 7 } })) as typeof fetch;
const snapshot = () => buildReadySnapshot({ source: '試験', agents: ['kilo', 'opencode'].map(id => ({ id, name: id, state: 'available' as const, stateLabel: '正常', note: '', freshWithin24Hours: true, liveState: 'healthy' as const })), cacheFreshWithin24Hours: true, summary: { total: 2, available: 2, candidate: 0, unavailable: 0, needs_recheck: 0 } }, 300000);

test('実作業失敗の強制Codexを旧プールの欠落に関係なく会話へ使う',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-conversation-readiness-'));
 const previous=process.env.WENTIAN_AGENT_MANAGEMENT_FILE,previousFallback=process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK;process.env.WENTIAN_AGENT_MANAGEMENT_FILE=path.join(root,'management.json');process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK='true';
 t.after(async()=>{if(previous===undefined)delete process.env.WENTIAN_AGENT_MANAGEMENT_FILE;else process.env.WENTIAN_AGENT_MANAGEMENT_FILE=previous;if(previousFallback===undefined)delete process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK;else process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK=previousFallback;await rm(root,{recursive:true,force:true});});
 await setForcedAgent('codex',true);
 const ready=snapshot();ready.pools.text=[];
 ready.agents=[{id:'codex',name:'codex',state:'needs_recheck',stateLabel:'実作業失敗',note:'',freshWithin24Hours:true,liveState:'healthy',connection:{mode:'native',model:'fixture',status:'verified',checkedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),fingerprint:'fixture',policyHash:'fixture'}}];
 let calls=0;
 const deps={snapshot:async()=>ready,fetch:(async()=>{throw Error('Gatewayを呼びません');}) as typeof fetch,score:()=>0,record:async()=>{},command:(id:string)=>({executable:id,args:[]}),run:async()=>{calls++;return JSON.stringify(answer);}};
 assert.deepEqual(await requestConversationTurn('你好！',[],'http://fixture','fixture',undefined,undefined,deps),answer);assert.equal(calls,1);
 ready.agents[0].connection!.status='failed';
 await assert.rejects(requestConversationTurn('你好！',[],'http://fixture','fixture',undefined,undefined,{...deps,fetch:async()=>Response.json({error:{message:'unavailable'}},{status:503})}),/Gateway: HTTP 503.*codex: 接続未確認・期限切れ/);
 assert.equal(calls,1,'接続検証失敗を強制指定で迂回しません');
 ready.agents[0].connection!.status='verified';
 await assert.rejects(requestConversationTurn('你好！',[],'http://fixture','fixture',undefined,undefined,{...deps,run:async()=>'{"kind":"invalid"}'}),/codex: 会話応答の形式検証に失敗/);
 await assert.rejects(requestConversationTurn('你好！',[],'http://fixture','fixture',undefined,undefined,{...deps,run:async()=>{throw Error('secret-token-do-not-print');}}),error=>error instanceof Error&&error.message.includes('会話プロセスの実行に失敗')&&!error.message.includes('secret-token'));
});

test('強制使用は性能とGatewayより優先し、単一選択・解除・不健康時の安全制約を保持する', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(),'wentian-force-'));
  const keys=['WENTIAN_AGENT_MANAGEMENT_FILE','WENTIAN_PLANNER_EXTERNAL_FALLBACK'];
  const previous=keys.map(key=>process.env[key]);
  process.env.WENTIAN_AGENT_MANAGEMENT_FILE=path.join(root,'management.json'); process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK='true';
  t.after(async()=>{keys.forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});await rm(root,{recursive:true,force:true});});
  await setForcedAgent('opencode',true);await setForcedAgent('kilo',true);
  assert.equal(readAgentManagement().forcedAgent,'kilo');
  await setForcedAgent('opencode',false);assert.equal(readAgentManagement().forcedAgent,'kilo');
  const called:string[]=[];let gateway=0;
  const deps={snapshot:async()=>snapshot(),fetch:(async()=>{gateway++;return responding(answer)('http://fixture');}) as typeof fetch,score:(id:string)=>id==='kilo'?0:100000,record:async()=>{},command:(id:string)=>({executable:id,args:[]}),run:(async(_command:unknown,options:{agent:string})=>{called.push(options.agent);return JSON.stringify(answer);}) as typeof import('./external-orchestrator.js').runExternalCommand};
  await requestConversationTurn('你好！',[],'http://fixture','fixture/model',undefined,undefined,deps);
  assert.deepEqual(called,['kilo']);assert.equal(gateway,0);
  const member={name:'試験',role:'会話',model:'wentian-auto/all'};
  assert.equal(selectGroupAgents(snapshot(),member,undefined,deps.score)[0],'kilo');
  assert.deepEqual(selectGroupAgents(snapshot(),{...member,model:'external/opencode'},undefined,deps.score),['opencode']);
  await requestConversationTurn('你好！',[],'http://fixture','fixture/model',undefined,undefined,{...deps,score:id=>id==='kilo'?-Infinity:100000});
  assert.equal(gateway,1);
  const unhealthy=snapshot();unhealthy.agents[0].liveState='probe_failed';
  await requestConversationTurn('你好！',[],'http://fixture','fixture/model',undefined,undefined,{...deps,snapshot:async()=>unhealthy});
  assert.equal(gateway,2);assert.equal(called.length,1);
  await setForcedAgent('kilo',false);assert.equal(readAgentManagement().forcedAgent,undefined);
  await requestConversationTurn('你好！',[],'http://fixture','fixture/model',undefined,undefined,deps);assert.equal(gateway,3);
  await setForcedAgent('opencode',true);
  const plannerAgent=await classifyWithExternalAgent('分類','試験',(_raw,agent)=>agent,undefined,{snapshot:async()=>snapshot(),command:id=>({executable:id,args:[]}),run:async()=>'{"intent":"chat"}'});
  assert.equal(plannerAgent,'opencode','分類代替も強制指定を先頭にします');
});

test('挨拶語・言語に関係なくAIの構造化判断を使い、一回で回答と履歴を渡す', async () => {
  for (const input of ['你好！', 'こんにちは', 'Hello', 'Explain recursion', '削除という言葉の意味を説明して']) {
    let calls = 0;
    const result = await requestConversationTurn(input, [{ role: 'user', content: '私の名前は試験です。' }], 'http://fixture', 'fixture/model', undefined, undefined, {
      fetch: (async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init!.body));
        assert.equal(body.model, 'fixture/model'); assert.equal(body.tools, undefined);
        assert.match(body.messages[1].content, /私の名前は試験/); assert.ok(body.messages[1].content.includes(input));
        return responding(answer)('http://fixture');
      }) as typeof fetch,
      snapshot: async () => { throw Error('会話で外部Agentを探索しません。'); },
    });
    assert.deepEqual(result, answer); assert.equal(calls, 1);
  }
});

test('同じ短い入力でもAIのtask判断を採用し、書込み計画を既存検証へ渡す', async () => {
  const value = { kind: 'task', plan: { intent: 'local_tool', operation: 'write', language: 'zh', required_capabilities: ['file_write'], tools: ['write_file'], delegation: { enabled: false } } };
  const result = await requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', undefined, undefined, { fetch: responding(value) });
  assert.equal(result.kind, 'task');
  if (result.kind === 'task') { assert.equal(result.plan.operation, 'write'); assert.deepEqual(result.plan.allowedWritePaths, []); assert.equal(result.plan.language, 'zh'); }
  assert.throws(() => parseConversationDecision(JSON.stringify({ kind: 'task', plan: { ...value.plan, tools: [] } }), '你好！'), /書き込み/);
  for (const invalid of ['{}', 'not json', JSON.stringify({ ...answer, plan: value.plan }), JSON.stringify({ ...answer, answer: '' })]) assert.throws(() => parseConversationDecision(invalid, '依頼'));
});

test('Gateway不通の会話代替は一回のCLIで回答し、一時作業場所を片付ける', async t => {
  const previous = process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK;
  process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK = 'true';
  t.after(() => { if (previous === undefined) delete process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK; else process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK = previous; });
  let calls = 0, workspace = '';
  let execution: import('./task-outcome.js').TaskExecution | undefined;
  const result = await requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', undefined, undefined, {
    fetch: async () => { throw new TypeError('fetch failed'); }, snapshot: async () => snapshot(),
    onComplete: info => { execution = info; },
    command: (id, prompt, root) => { workspace = root; assert.notEqual(root, process.cwd()); assert.match(prompt, /日本語の依頼を要求しない/); return { executable: id, args: [] }; },
    run: async (_command, options) => { calls++; assert.equal(options.role, 'conversation'); return JSON.stringify(answer); },
  });
  assert.deepEqual(result, answer); assert.equal(calls, 1); await assert.rejects(access(workspace));
  assert.equal(execution!.source, 'external'); assert.ok(['kilo', 'opencode'].includes(execution!.agent!));
  assert.match(formatConversationExecution(execution!), /Agent: (kilo|opencode).*Model: 未確認.*\d+\.\d+s/);
  assert.match(formatConversationExecution({ source: 'external', agent: 'opencode', configuredModel: 'configured/model', elapsedMs: 7610 }), /Agent: opencode · 設定モデル: configured\/model · 7\.6s/);
});

test('認証・利用制限・不正JSON・中断を別Agentで迂回しない', async () => {
  for (const [status, payload] of [[401, {}], [429, {}], [503, { details: { upstream: { status: 429 } } }]] as const) {
    await assert.rejects(requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', undefined, undefined, {
      fetch: (async () => Response.json({ error: payload }, { status })) as typeof fetch,
      snapshot: async () => { assert.fail('制限を迂回しません。'); },
    }));
  }
  await assert.rejects(requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', undefined, undefined, { fetch: responding({}), snapshot: async () => { assert.fail('不正JSONで外部起動しません。'); } }));
  const controller = new AbortController(); controller.abort(new Error('利用者中断'));
  await assert.rejects(requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', controller.signal, undefined, { fetch: async () => { throw controller.signal.reason; }, snapshot: async () => { assert.fail('中断後に起動しません。'); } }), /利用者中断/);
});

test('会話はキャッシュ順でなく性能順を使い、失敗と成功の速度を台帳へ戻す', async t => {
  const previous = process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK;
  process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK = 'true';
  t.after(() => { if (previous === undefined) delete process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK; else process.env.WENTIAN_PLANNER_EXTERNAL_FALLBACK = previous; });
  const called: string[] = [], records: Array<Parameters<typeof import('./agent-performance.js').recordAgentPerformance>[0]> = [];
  const deps = {
    fetch: (async () => Response.json({}, { status: 503 })) as typeof fetch,
    snapshot: async () => snapshot(),
    command: (id: string) => ({ executable: id, args: [] }),
    score: (id: string) => id === 'opencode' ? 100 : 10,
    record: async (value: Parameters<typeof import('./agent-performance.js').recordAgentPerformance>[0]) => { records.push(value); },
    run: (async (_command: unknown, options: { agent: string }) => { called.push(options.agent); return JSON.stringify(answer); }) as typeof import('./external-orchestrator.js').runExternalCommand,
  };
  await requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', undefined, undefined, deps);
  assert.deepEqual(called, ['opencode']); assert.equal(records[0].task, 'conversation'); assert.equal(records[0].success, true); assert.ok(records[0].latencyMs >= 0);
  called.length = 0; records.length = 0;
  await requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', undefined, undefined, { ...deps, run: async (_command, options) => { called.push(options.agent); return options.agent === 'opencode' ? '不正JSON' : JSON.stringify(answer); } });
  assert.deepEqual(called, ['opencode','opencode', 'kilo']); assert.deepEqual(records.map(r => r.success), [false, true]);
  called.length = 0;
  await requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', undefined, undefined, { ...deps, score: id => id === 'opencode' ? -Infinity : 0 });
  assert.deepEqual(called, ['kilo']);
  // 台帳保存失敗だけで、取得済みの正常回答を失敗へ変えません。
  const result = await requestConversationTurn('你好！', [], 'http://fixture', 'fixture/model', undefined, undefined, { ...deps, record: async () => { throw Error('保存失敗'); } });
  assert.deepEqual(result, answer);
});
