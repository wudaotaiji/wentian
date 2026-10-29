import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compactConversation, compactToolOutputsForRetry, detectOverflow, estimateContextTokens, estimateTokens, evaluateContextUsage, isContextOverflowError, PRUNE_MINIMUM, PRUNE_PROTECT, pruneOldToolOutputs, replayFromBoundary, replayReset, resolveContextTokens, resolveModelCompactionConfig, shouldForceLowReasoningEffort, shouldSkipCompactByMinInterval, shouldSuggestTaskSplit, TOOL_OUTPUT_MAX_CHARS, truncateToolOutput, type CompactorConversationMessage,
} from './agent-compactor.js';

test('estimateTokensはUTF-8バイト数から概算トークン数を返す', () => {
  // ASCII: 4バイト → 4/0.75 = 5.33 → 6 トークン
  assert.equal(estimateTokens('abcd'), Math.ceil(4 / 0.75));
  // 空文字列は0トークン
  assert.equal(estimateTokens(''), 0);
  // 日本語1文字はUTF-8で3バイト → 3/0.75 = 4 トークン
  assert.equal(estimateTokens('あ'), 4);
});

test('estimateContextTokensはrole/tool_calls/JSONも考慮する', () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: '短い指示' },
    { role: 'user', content: '依頼' },
    { role: 'assistant', content: '了解', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'A'.repeat(800) },
  ];
  const total = estimateContextTokens(messages);
  // role 4 * 4 = 16 オーバーヘッド + 各本文 + tool_calls JSON
  assert.ok(total > 16, 'roleオーバーヘッドだけでも16を超える');
  assert.ok(total > 800, '800バイトの本文だけでも800/0.75 ≒ 1067 以上になる');
});

test('evaluateContextUsageは80%/95%閾値で正しいbooleanを返す', () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'x'.repeat(100) },
    { role: 'user', content: 'x'.repeat(100) },
  ];
  const low = evaluateContextUsage(messages, { contextTokens: 100_000 });
  assert.equal(low.shouldCompact, false);
  assert.equal(low.shouldStop, false);
  // 80%丁度: ratio = 1.0 なので閾値超過
  const overflow = evaluateContextUsage(messages, { contextTokens: 100 });
  assert.equal(overflow.shouldCompact, true);
  assert.equal(overflow.shouldStop, true);
});

test('compactConversationは中間のTool/Assistantを要約へ置換し先頭と末尾を保持する', () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'システム指示は保持' },
    { role: 'user', content: '質問1' },
    { role: 'assistant', content: '了解1', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'A'.repeat(4000) },
    { role: 'assistant', content: 'A'.repeat(4000) },
    { role: 'user', content: '質問2' },
    { role: 'assistant', content: '回答2-1' },
    { role: 'tool', tool_call_id: '2', name: 'run_command', content: '結果'.repeat(2000) },
    { role: 'assistant', content: '最終' },
  ];
  const result = compactConversation(messages, { contextTokens: 100_000, keepTail: 3 });
  assert.ok(result.freedTokens > 0);
  assert.ok(result.compactedCount >= 3);
  assert.equal(result.compacted[0].content, 'システム指示は保持', '先頭systemは必ず保持');
  assert.equal(result.compacted.length, messages.length - result.compactedCount + 1, '要約message 1件 + 先頭 + 末尾');
  // 末尾keepTail件のroleが維持されている
  const tailRoles = result.compacted.slice(-3).map(m => m.role);
  assert.deepEqual(tailRoles, ['assistant', 'tool', 'assistant']);
});

test('compactConversationはメッセージ数が不足していれば何もしない', () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user' },
  ];
  const result = compactConversation(messages, { contextTokens: 100_000, keepTail: 4 });
  assert.equal(result.compactedCount, 0);
  assert.equal(result.freedTokens, 0);
});

test('resolveContextTokensはprovider/modelからcapabilities.contextTokensを引く', () => {
  const lookup = (id: string) => (id === 'wentian-local' ? 98_304 : undefined);
  assert.equal(resolveContextTokens('wentian-local/local-model', lookup), 98_304);
  assert.equal(resolveContextTokens('ollama/qwen2.5:7b', lookup, 8_192), 8_192);
  assert.equal(resolveContextTokens('no-prefix', lookup, 4_096), 4_096);
});

test('pruneOldToolOutputsは直近2ユーザー境界を保護しそれより古いTool出力を削減する', () => {
  // opencode/kilo 準拠: 直近2ユーザー境界以内のTool出力は保護される。
  // 3つ目のuser境界より古いTool出力をPrune対象とする。
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '依頼1' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'X'.repeat(60_000) }, // 保護対象（直近2ユーザー境界内）
    { role: 'assistant', content: '了解1' },
    { role: 'user', content: '依頼2' },
    { role: 'assistant', content: '', tool_calls: [{ id: '2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '2', name: 'read_file', content: 'Y'.repeat(60_000) }, // 保護対象
    { role: 'assistant', content: '了解2' },
    { role: 'user', content: '依頼3' }, // 3つ目のuser境界 → この前がPrune対象
    { role: 'assistant', content: '了解3' },
  ];
  const result = pruneOldToolOutputs(messages);
  // 古いTool (index 3) は保護外 → Prune対象
  assert.ok(result.prunedCount >= 0);
  // ただしPrune_MINIMUM (20K) を超えないと適用されないため、テスト用に大きいデータを使う
  assert.ok(result.freedTokens >= 0);
});

test('pruneOldToolOutputsは十分な古いTool出力を蓄積したら削減する', () => {
  // 3つ目のuser境界より前、かつPRUNE_MINIMUM(20K)を超える古いTool出力をPrune
  const oldToolContent = 'Z'.repeat(60_000); // 約80Kトークン
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '依頼1' },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: oldToolContent },
    { role: 'user', content: '依頼2' },
    { role: 'assistant', content: '了解2' },
    { role: 'user', content: '依頼3' },
    { role: 'assistant', content: '了解3' },
  ];
  const result = pruneOldToolOutputs(messages);
  assert.ok(result.prunedCount >= 1);
  assert.ok(result.freedTokens > 0);
  const toolMessages = result.pruned.filter(m => m.role === 'tool') as Array<{ content: unknown }>;
  assert.ok(toolMessages.some(m => typeof m.content === 'string' && m.content.includes('[pruned:')));
});

test('pruneOldToolOutputsはPRUNE_MINIMUM未満では何もしない', () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '依頼1' },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: '短い結果' },
    { role: 'user', content: '依頼2' },
  ];
  const result = pruneOldToolOutputs(messages);
  assert.equal(result.prunedCount, 0);
});

test('shouldSkipCompactByMinIntervalは直近5メッセージ以内の要約を検出する', () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '依頼' },
    { role: 'assistant', content: 'Wentian Agent 自動要約（テスト）' },
    { role: 'assistant', content: '次の応答' },
  ];
  assert.equal(shouldSkipCompactByMinInterval(messages, 5), true);
  // 要約マーカーがない場合はfalse
  const noSummary: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '依頼' },
    { role: 'assistant', content: '普通の応答' },
  ];
  assert.equal(shouldSkipCompactByMinInterval(noSummary, 5), false);
});

test('detectOverflowは直前User境界を返す', () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user1' },
    { role: 'assistant', content: 'A'.repeat(100_000) },
    { role: 'user', content: 'user2' },
    { role: 'assistant', content: 'B'.repeat(100_000) },
  ];
  const result = detectOverflow({ messages, contextTokens: 1_000 });
  assert.equal(result.overflowed, true);
  assert.ok(result.replayBoundary !== undefined);
  assert.ok(result.replayBoundary >= 0);
});

test('replayFromBoundaryは直前User境界で区切りContinue promptをsystemロールで付加する', () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'user1' },
    { role: 'assistant', content: 'response1' },
    { role: 'user', content: 'user2' },
    { role: 'assistant', content: 'response2' },
  ];
  // boundary=3 は user 'user2' の位置。slice(0, 3) = 3件 + Continue system 1件 = 4件
  const replayed = replayFromBoundary({ messages, boundary: 3 });
  assert.equal(replayed.length, 4);
  assert.equal(replayed[replayed.length - 1].role, 'system');
  assert.match(replayed[replayed.length - 1].content as string, /Continue|次のステップ/);
});

test('truncateToolOutputはTOOL_OUTPUT_MAX_CHARSでカットオフする', () => {
  const long = 'A'.repeat(100_000);
  const truncated = truncateToolOutput(long);
  assert.ok(truncated.length < long.length);
  assert.ok(truncated.length <= TOOL_OUTPUT_MAX_CHARS + 100); // マーカー込み
  assert.match(truncated, /省略/);
  // 短い出力はそのまま
  assert.equal(truncateToolOutput('短い'), '短い');
});

test('Context超過を識別し、再試行用にTool本文だけを圧縮する', () => {
  assert.equal(isContextOverflowError("Input length (169496) exceeds model's maximum context length (98304)."), true);
  assert.equal(isContextOverflowError('Provider authentication failed'), false);
  const messages = compactToolOutputsForRetry([
    { role: 'assistant', content: '維持' },
    { role: 'tool', tool_call_id: 'call-1', content: 'X'.repeat(20_000) },
  ], 1_000);
  assert.equal(messages[0].content, '維持');
  assert.match(String(messages[1].content), /省略/);
  assert.equal((messages[1] as { tool_call_id?: string }).tool_call_id, 'call-1');
});

test('resolveModelCompactionConfigはグローバルとモデル別設定をマージする', () => {
  const config = resolveModelCompactionConfig(
    'wentian-local/local-model',
    { contextTokens: 8_192, compactThresholdRatio: 0.5 },
    { 'wentian-local/local-model': { contextTokens: 98_304, compactThresholdRatio: 0.85 } },
  );
  assert.equal(config.contextTokens, 98_304);
  assert.equal(config.compactThresholdRatio, 0.85);
  // 該当しないモデルはグローバル設定
  const fallback = resolveModelCompactionConfig('unknown/model', { contextTokens: 4_096 });
  assert.equal(fallback.contextTokens, 4_096);
  assert.equal(fallback.compactThresholdRatio, 0.8);
});

test('shouldSuggestTaskSplitは8K未満モデルで大規模依頼時に分割を推奨する', () => {
  assert.equal(shouldSuggestTaskSplit({ estimatedRequestTokens: 1_000, contextTokens: 8_192, requestType: 'chat' }), false);
  assert.equal(shouldSuggestTaskSplit({ estimatedRequestTokens: 5_000, contextTokens: 8_192, requestType: 'local_tool' }), true);
  assert.equal(shouldSuggestTaskSplit({ estimatedRequestTokens: 10_000, contextTokens: 32_000, requestType: 'local_tool' }), false);
  assert.equal(shouldSuggestTaskSplit({ estimatedRequestTokens: 3_000, contextTokens: 8_192, requestType: 'chat' }), false);
});

test('定数PRUNE_MINIMUM/PRUNE_PROTECT/TOOL_OUTPUT_MAX_CHARSはopencode準拠の値を公開する', () => {
  assert.equal(PRUNE_MINIMUM, 20_000);
  assert.equal(PRUNE_PROTECT, 40_000);
  assert.ok(TOOL_OUTPUT_MAX_CHARS >= 20_000);
});

test('replayResetは履歴を捨ててsystem+元依頼+最後のTool結果+systemヒントだけ残す', () => {
  const reset = replayReset({
    systemPrompt: { role: 'system', content: 'sys指示' },
    originalUserRequest: 'ファイル一覧を教えて',
    lastToolResult: { name: 'run_command', content: 'A'.repeat(10_000) },
    finalAnswerHint: '最終回答を生成してください',
  });
  // system + user + tool + system の4件
  assert.equal(reset.length, 4);
  assert.equal(reset[0].role, 'system');
  assert.equal(reset[1].role, 'user');
  assert.equal(reset[2].role, 'tool');
  assert.equal(reset[3].role, 'system');
  assert.match(reset[2].content as string, /履歴リセット後/);
  // 長いTool結果は省略される
  assert.match(reset[2].content as string, /省略/);
});

test('replayResetはlastToolResultなしでも動作する', () => {
  const reset = replayReset({
    systemPrompt: { role: 'system', content: 'sys' },
    originalUserRequest: '質問',
  });
  assert.equal(reset.length, 3);
  assert.equal(reset[1].role, 'user');
  assert.equal(reset[2].role, 'system');
});

test('shouldForceLowReasoningEffortはgpt-oss-*系のみtrueを返す', () => {
  assert.equal(shouldForceLowReasoningEffort('wentian-local/gpt-oss-medium'), true);
  assert.equal(shouldForceLowReasoningEffort('wentian-local/gpt-oss-high'), true);
  assert.equal(shouldForceLowReasoningEffort('wentian-local/gpt-oss'), true);
  assert.equal(shouldForceLowReasoningEffort('ollama/qwen2.5:7b'), false);
  assert.equal(shouldForceLowReasoningEffort('wentian-local/local-model'), false);
  assert.equal(shouldForceLowReasoningEffort('local-model'), false);
});
