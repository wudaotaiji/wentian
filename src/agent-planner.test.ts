import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentPlan, fallbackAgentPlan, plannerSystemPrompt, validateAgentPlan } from './agent-planner.js';

test('分類APIの404はモデル名と構造化エラー理由を表示する', async () => {
  const oldFetch = globalThis.fetch;
  const previous = process.env.WENTIAN_PLANNER_MODEL;
  process.env.WENTIAN_PLANNER_MODEL = 'ollama/missing';
  globalThis.fetch = (async () => Response.json({ error: { message: 'モデルが見つかりません: ollama/missing' } }, { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(createAgentPlan('你好！', 'http://fixture'), /HTTP 404 分類モデル=ollama\/missing: モデルが見つかりません/);
    globalThis.fetch = (async () => new Response('<html>内部情報</html>', { status: 404 })) as typeof fetch;
    await assert.rejects(createAgentPlan('你好！', 'http://fixture'), error => error instanceof Error && error.message.includes('HTTP 404 分類モデル=ollama/missing') && !error.message.includes('内部情報'));
  } finally {
    globalThis.fetch = oldFetch;
    if (previous === undefined) delete process.env.WENTIAN_PLANNER_MODEL; else process.env.WENTIAN_PLANNER_MODEL = previous;
  }
});

test('プランナー（Planner）はモデルを選択せず難度と必要能力を宣言する', () => {
  const input = { intent: 'chat', routing_requirements: { task: 'coding', difficulty: 0.8, minimum_context_tokens: 32768 } };
  assert.deepEqual(validateAgentPlan(input, '依頼').routingRequirements, { task: 'coding', difficulty: 0.8, minimumContextTokens: 32768 });
  assert.throws(() => validateAgentPlan({ ...input, model: 'specific-model' }, '依頼'), /指定できません/);
  assert.throws(() => validateAgentPlan({ ...input, routing_requirements: { task: 'coding', difficulty: 2 } }, '依頼'), /難度/);
});

test('LLMの読み取り判断を採用し、依頼原文と応答言語を保持する', () => {
  for (const input of ['開発環境の各モジュールのリソース利用率を教えて', '画面を開発してという前の依頼の進捗を教えて', '这个作业已经完成了吗？']) {
    const plan = validateAgentPlan({ intent: 'local_tool', operation: 'read', language: 'ja', text: '別の質問', required_capabilities: ['file_read', 'file_write'], tools: ['read_file', 'write_file'], delegation: { enabled: false } }, input);
    assert.equal(plan.text, input); assert.equal(plan.operation, 'read');
    assert.equal(plan.requiredCapabilities.includes('file_write'), false);
    assert.equal(plan.tools.includes('write_file'), false); assert.equal(plan.delegation.enabled, false);
  }
});

test('新しい言い回しでもLLMの制作判断をコードのキーワードで上書きしない', () => {
  const input = 'このイメージを動く形にして届けて';
  const plan = validateAgentPlan({ intent: 'local_tool', operation: 'write', required_capabilities: ['file_read', 'file_write'], tools: ['read_file', 'write_file'], delegation: { enabled: true } }, input);
  assert.equal(plan.operation, 'write'); assert.ok(plan.requiredCapabilities.includes('file_write'));
  assert.equal(plan.delegation.enabled, true); assert.equal(plan.delegation.objective, input);
});

test('実行方式と外部Agent指定をLLMの構造化判断から採用する', () => {
  const plan = validateAgentPlan({ intent: 'delegate_external', operation: 'read', execution_mode: 'direct', delegation: { enabled: true, requested_agents: ['KILO', '架空Agent'] } }, '他に回さずあなたが調べて');
  assert.equal(plan.executionMode, 'direct'); assert.equal(plan.delegation.enabled, false);
  assert.deepEqual(plan.delegation.requestedAgents, ['kilo']);
});

test('調査の場所と種類はLLMの判断を採用し、形式が不正なら拒否する', () => {
  const plan = validateAgentPlan({ intent: 'web_research', operation: 'read', research: { kind: 'weather', location: 'Tokyo' } }, '今天东京的天气如何啊？');
  assert.deepEqual(plan.research, { kind: 'weather', location: 'Tokyo' });
  assert.throws(() => validateAgentPlan({ operation: 'destroy' }, '質問'), /操作種別/);
  assert.throws(() => validateAgentPlan({ operation: 'write', tools: [] }, '依頼'), /必要なツール/);
  assert.throws(() => validateAgentPlan({ research: { kind: 'exchange', currencies: ['USD', '不正'] } }, '質問'), /通貨コード/);
});

test('作業先はPlannerの構造化判断を使い、原文にないPathを拒否する', () => {
  const input = '在C:\\mywork\\temp下面创建文件';
  assert.equal(validateAgentPlan({ intent: 'local_tool', operation: 'read', target_path: 'C:\\mywork\\temp' }, input).targetPath, 'C:\\mywork\\temp');
  assert.throws(() => validateAgentPlan({ intent: 'local_tool', operation: 'read', target_path: 'C:\\other' }, input), /依頼文に明示/);
});

test('中立計画は原文の単語からツール・権限・委譲を生成しない', () => {
  for (const input of ['開発環境の利用率', 'Kiloに実装を依頼して', '今日は天気がよいです']) {
    const plan = fallbackAgentPlan(input);
    assert.equal(plan.text, input); assert.deepEqual(plan.tools, []);
    assert.equal(plan.delegation.enabled, false); assert.equal(plan.operation, 'answer');
  }
});

test('計画指示は会話履歴とワークスペース作業記録を異なる証拠源へ導く', () => {
  const prompt = plannerSystemPrompt();
  assert.match(prompt, /会話履歴.*list_agent_sessions/);
  assert.match(prompt, /プロジェクトの作業実績.*inspect_workspace_activity,list_files,read_file/);
  assert.match(prompt, /作業レポートの候補を探索して内容・日付を確認/);
});

test('AIがワークスペース証拠を選んだ読み取り計画を保持する', () => {
  const input = '今天做了什么工作，请根据项目记录汇报';
  const plan = validateAgentPlan({ intent: 'local_tool', operation: 'read', evidence_source: 'workspace', required_capabilities: ['file_read'], tools: ['inspect_workspace_activity', 'list_files', 'read_file'] }, input);
  assert.equal(plan.evidenceSource, 'workspace');
  assert.deepEqual(plan.tools, ['inspect_workspace_activity', 'list_files', 'read_file']);
  assert.equal(plan.operation, 'read');
});

test('直接実行と許可範囲を指定した場合も最初にLLMが意図を判断する', async () => {
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (_url, options) => {
    calls++; const body = JSON.parse(String(options?.body));
    assert.equal(body.messages.at(-1).content, '監視画面を形にして');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ intent: 'local_tool', operation: 'write', tools: ['write_file'], required_capabilities: ['file_write'] }) } }] });
  }) as typeof fetch;
  try {
    const plan = await createAgentPlan('監視画面を形にして', 'http://fixture', undefined, { mode: 'direct', allowedWritePaths: ['monitor.html'] });
    assert.equal(calls, 1); assert.equal(plan.operation, 'write'); assert.equal(plan.executionMode, 'direct');
    assert.deepEqual(plan.allowedWritePaths, ['monitor.html']);
  } finally { globalThis.fetch = oldFetch; }
});

test('LLMが停止・不正JSON・操作種別欠損の場合はキーワードで実行せず失敗理由を返す', async () => {
  const oldFetch = globalThis.fetch;
  try {
    for (const content of ['不正JSON', '{"intent":"local_tool"}']) {
      globalThis.fetch = (async () => Response.json({ choices: [{ message: { content } }] })) as typeof fetch;
      await assert.rejects(createAgentPlan('ファイルを作成して', 'http://fixture'), /操作は開始していません/);
    }
    globalThis.fetch = (async () => { throw new Error('接続不可'); }) as typeof fetch;
    await assert.rejects(createAgentPlan('ファイルを作成して', 'http://fixture'), /接続不可/);
  } finally { globalThis.fetch = oldFetch; }
});

test('構造の誤りは検証理由をLLMへ返して修正させ、コードで意図を置換しない', async () => {
  const oldFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body)); calls++;
    if (calls === 1) return Response.json({ choices: [{ message: { content: '{"intent":"resource_usage","operation":"read"}' } }] });
    assert.match(body.messages.at(-1).content, /JSON failed validation/);
    return Response.json({ choices: [{ message: { content: '{"intent":"local_tool","operation":"read","language":"ja","required_capabilities":["file_read"],"tools":["read_file"]}' } }] });
  }) as typeof fetch;
  try {
    const plan = await createAgentPlan('開発環境の利用率を教えて', 'http://fixture');
    assert.equal(calls, 2); assert.equal(plan.intent, 'local_tool'); assert.equal(plan.operation, 'read');
  } finally { globalThis.fetch = oldFetch; }
});
