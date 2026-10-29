/**
 * Wentian Agent Context Compactor — opencode/kilo 準拠の多層防御。
 *
 * 主な機能:
 * - 概算Token推定（UTF-8バイト数 × 0.75）
 * - 古いTool出力の削除 (Prune, opencode PRUNE_MINIMUM/PRUNE_PROTECT 相当)
 * - 連続コンパクト防止 (min_messages)
 * - overflow時の replay（巻き戻し）
 * - Tool出力の事前カットオフ (TOOL_OUTPUT_MAX_CHARS 相当)
 * - モデル別 context_threshold / token_threshold
 */

export interface CompactorConversationMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  /**
   * 任意メタデータ。Memory Layer (L2) が `immovable: true` を付けて compact/prune の
   * 対象外として識別します。設計参照: docs/ARCHITECTURE.md
   */
  metadata?: { immovable?: boolean; source?: 'memory-layer' | 'goal-context' | 'runtime' | string };
}

export interface CompactorOptions {
  /** モデルのContext Window（トークン / Token）数。 */
  contextTokens: number;
  /** 自動コンパクトを開始する閾値（既定0.8=80%）。 */
  compactThresholdRatio?: number;
  /** 95%を超えたら停止する最終安全弁（既定0.95）。 */
  hardStopRatio?: number;
  /** 1メッセージあたりの概算バイト→トークン換算係数（既定0.75）。 */
  bytesPerToken?: number;
  /** 圧縮時に残す最新メッセージ数。先頭systemと最新user/tool/assistantは必ず保持します。 */
  keepTail?: number;
  /** 連続コンパクト防止の最小メッセージ間隔（既定5）。 */
  minMessagesBetweenCompacts?: number;
}

export interface CompactorEvaluation {
  estimatedTokens: number;
  ratio: number;
  /** 80%閾値を超えていて、コンパクトすべきかどうか。 */
  shouldCompact: boolean;
  /** 95%閾値を超えていて、安全停止すべきかどうか。 */
  shouldStop: boolean;
  /** 残りの余白トークン。 */
  remainingTokens: number;
}

/** opencode/kilo 相当の定数。 */
export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
/** モデル送信前にTool出力をカットオフする文字数。opencode の `TOOL_OUTPUT_MAX_CHARS` 相当。 */
export const TOOL_OUTPUT_MAX_CHARS = 30_000;

/** 文字列を概算トークン数へ変換します。Tokenizerに依存しない安全側の近似です。 */
export function estimateTokens(text: string, bytesPerToken = 0.75): number {
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, 'utf8');
  return Math.ceil(bytes / bytesPerToken);
}

/** メッセージ配列全体の概算トークン数を計算します。 */
export function estimateContextTokens(messages: ReadonlyArray<CompactorConversationMessage>, bytesPerToken = 0.75): number {
  let total = 0;
  for (const message of messages) {
    total += 4;
    if (typeof message.content === 'string') total += estimateTokens(message.content, bytesPerToken);
    else if (message.content !== undefined && message.content !== null) total += estimateTokens(JSON.stringify(message.content), bytesPerToken);
    if (Array.isArray(message.tool_calls)) for (const call of message.tool_calls) total += estimateTokens(JSON.stringify(call), bytesPerToken);
    if (typeof message.name === 'string') total += estimateTokens(message.name, bytesPerToken);
  }
  return total;
}

/** 現在の使用量と閾値から、次に取るべきアクションを判定します。 */
export function evaluateContextUsage(messages: ReadonlyArray<CompactorConversationMessage>, options: CompactorOptions): CompactorEvaluation {
  const compactThresholdRatio = options.compactThresholdRatio ?? 0.8;
  const hardStopRatio = options.hardStopRatio ?? 0.95;
  const estimatedTokens = estimateContextTokens(messages, options.bytesPerToken);
  const ratio = options.contextTokens > 0 ? estimatedTokens / options.contextTokens : 0;
  return {
    estimatedTokens,
    ratio,
    shouldCompact: ratio >= compactThresholdRatio,
    shouldStop: ratio >= hardStopRatio,
    remainingTokens: Math.max(0, options.contextTokens - estimatedTokens),
  };
}

/** Memory Layer (L2) が compact/prune の対象外として識別するメッセージを判定します。 */
export function isImmovableMessage(message: CompactorConversationMessage): boolean {
  return Boolean(message.metadata && message.metadata.immovable === true);
}

/** Tool実行結果（role: tool）を要約形式へ圧縮し、過去の重いメッセージを要約へ置換します。 */
export function compactConversation(
  messages: ReadonlyArray<CompactorConversationMessage>,
  options: CompactorOptions,
  now = new Date(),
): { compacted: CompactorConversationMessage[]; compactedCount: number; freedTokens: number } {
  const keepTail = Math.max(2, options.keepTail ?? 4);
  if (messages.length <= keepTail + 1) return { compacted: [...messages], compactedCount: 0, freedTokens: 0 };
  const head = messages.slice(0, 1);
  const tail = messages.slice(-keepTail);
  const middle = messages.slice(1, -keepTail);
  if (!middle.length) return { compacted: [...messages], compactedCount: 0, freedTokens: 0 };

  const beforeTokens = estimateContextTokens(messages, options.bytesPerToken);
  const toolSummaries: string[] = [];
  let toolCount = 0;
  let fileCount = 0;
  let commandCount = 0;
  let errorCount = 0;
  // Memory Layer (L2) の immovable メッセージは要約せずそのまま保持します。
  const preservedFromMiddle: CompactorConversationMessage[] = [];
  for (const message of middle) {
    if (isImmovableMessage(message)) { preservedFromMiddle.push(message); continue; }
    if (message.role === 'tool') {
      toolCount += 1;
      const name = typeof message.name === 'string' ? message.name : 'tool';
      const content = typeof message.content === 'string' ? message.content : '';
      const success = !/Tool実行エラー/.test(content);
      if (!success) errorCount += 1;
      if (name === 'read_file') fileCount += 1;
      else if (name === 'run_command') commandCount += 1;
      const preview = content.length > 240 ? `${content.slice(0, 240)}...` : content;
      toolSummaries.push(`- [${name}] ${success ? '成功' : '失敗'} :: ${preview.replace(/\n+/g, ' ')}`);
    } else if (message.role === 'assistant') {
      const content = typeof message.content === 'string' ? message.content : '';
      if (content) toolSummaries.push(`- [assistant] ${content.slice(0, 240).replace(/\n+/g, ' ')}${content.length > 240 ? '...' : ''}`);
    }
  }
  const summaryText = [
    `Wentian Agent 自動要約（${now.toISOString()}）`,
    `Context 80%閾値到達により中間メッセージを圧縮しました。`,
    `内訳: tool実行=${toolCount}件(read_file=${fileCount}, run_command=${commandCount}, 失敗=${errorCount})、assistant=${middle.filter(m => m.role === 'assistant').length}件`,
    '',
    '--- 中間履歴の要約 ---',
    ...toolSummaries,
  ].join('\n');
  const summaryMessage: CompactorConversationMessage = { role: 'assistant', content: summaryText };
  const compacted: CompactorConversationMessage[] = [...head, ...preservedFromMiddle, summaryMessage, ...tail];
  const afterTokens = estimateContextTokens(compacted, options.bytesPerToken);
  return { compacted, compactedCount: middle.length - preservedFromMiddle.length, freedTokens: Math.max(0, beforeTokens - afterTokens) };
}

/** opencode/kilo の `prune` 相当: 直近2ユーザー境界以内のTool出力を保護し、それより古いTool出力を削除してContextを節約します。 */
export function pruneOldToolOutputs(
  messages: ReadonlyArray<CompactorConversationMessage>,
  options: { bytesPerToken?: number; protectedTools?: ReadonlySet<string> } = {},
): { pruned: CompactorConversationMessage[]; prunedCount: number; freedTokens: number } {
  const protectedTools = options.protectedTools ?? new Set(['skill']);
  const messagesCopy = [...messages];
  let total = 0;
  let pruned = 0;
  let prunedCount = 0;
  const toPruneIndices: number[] = [];
  // 直近2つのuser境界を末尾から探し、それより古い位置を決定
  const userIndices: number[] = [];
  for (let i = messagesCopy.length - 1; i >= 0; i--) {
    if (messagesCopy[i].role === 'user') userIndices.push(i);
    if (userIndices.length === 2) break;
  }
  const protectionBoundary = userIndices.length >= 2 ? userIndices[1] : (userIndices[0] ?? 0);
  // protectionBoundary より古いTool出力をPrune対象に
  for (let msgIndex = protectionBoundary - 1; msgIndex >= 0; msgIndex--) {
    const msg = messagesCopy[msgIndex];
    if (msg.role !== 'tool') continue;
    if (isImmovableMessage(msg)) continue;
    const toolName = typeof msg.name === 'string' ? msg.name : '';
    if (protectedTools.has(toolName)) continue;
    if (typeof msg.content !== 'string') continue;
    const estimate = estimateTokens(msg.content, options.bytesPerToken);
    total += estimate;
    if (total > PRUNE_PROTECT) {
      pruned += estimate;
      toPruneIndices.push(msgIndex);
    }
  }
  if (pruned > PRUNE_MINIMUM) {
    for (const index of toPruneIndices) {
      const original = messagesCopy[index];
      if (original && original.role === 'tool' && typeof original.content === 'string') {
        const newContent = `[pruned: ${original.content.length}文字 / 約${estimateTokens(original.content, options.bytesPerToken)}トークンをContext節約のため削除]`;
        messagesCopy[index] = { ...original, content: newContent };
        prunedCount += 1;
      }
    }
  }
  const beforeTokens = estimateContextTokens(messages, options.bytesPerToken);
  const afterTokens = estimateContextTokens(messagesCopy, options.bytesPerToken);
  return { pruned: messagesCopy, prunedCount, freedTokens: Math.max(0, beforeTokens - afterTokens) };
}

/** 連続コンパクト防止: 直近minMessages件以内に既にコンパクト要約があればtrueを返します。 */
export function shouldSkipCompactByMinInterval(
  messages: ReadonlyArray<CompactorConversationMessage>,
  minMessages: number,
): boolean {
  if (minMessages <= 0) return false;
  // 末尾からminMessages件を遡り、summary markerを含むassistant messageがあればスキップ
  let checkedCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg.content !== 'string') continue;
    checkedCount += 1;
    if (msg.content.includes('Wentian Agent 自動要約')) return true;
    if (checkedCount >= minMessages) break;
  }
  return false;
}

/** overflow検出: 直前Userまで遡り、巻き戻し後の messages と overflow原因を返します。 */
export function detectOverflow(input: {
  messages: ReadonlyArray<CompactorConversationMessage>;
  contextTokens: number;
  bytesPerToken?: number;
}): { overflowed: boolean; replayBoundary?: number; estimatedTokens: number } {
  const estimated = estimateContextTokens(input.messages, input.bytesPerToken);
  if (estimated <= input.contextTokens) return { overflowed: false, estimatedTokens: estimated };
  // 末尾から遡り、最後のuser境界を返す
  for (let i = input.messages.length - 1; i >= 0; i--) {
    if (input.messages[i].role === 'user') return { overflowed: true, replayBoundary: i, estimatedTokens: estimated };
  }
  return { overflowed: true, replayBoundary: 0, estimatedTokens: estimated };
}

/** replay: 履歴をリセットしてsystem + 最新User依頼 + 最後のTool結果だけを残し、LLMが最終回答を生成できる状態にします。 */
export function replayReset(input: {
  systemPrompt: CompactorConversationMessage;
  originalUserRequest: string;
  lastToolResult?: { name: string; content: string };
  finalAnswerHint?: string;
}): CompactorConversationMessage[] {
  const messages: CompactorConversationMessage[] = [input.systemPrompt];
  messages.push({ role: 'user', content: input.originalUserRequest });
  if (input.lastToolResult) {
    // 最後のTool実行結果を要約形式で残し、モデルに最終回答生成を促します。
    const preview = input.lastToolResult.content.length > 2_000
      ? `${input.lastToolResult.content.slice(0, 1_500)}...[省略]...${input.lastToolResult.content.slice(-500)}`
      : input.lastToolResult.content;
    messages.push({
      role: 'tool',
      name: input.lastToolResult.name,
      content: `[履歴リセット後の最初のTool結果]\n${preview}`,
    });
  }
  const hint = input.finalAnswerHint || '上記Tool結果を踏まえ、最終回答を生成してください。次のTool Callは不要です。';
  messages.push({ role: 'system', content: hint });
  return messages;
}

/** replay: 従来の直前User境界巻き戻し版。下位互換のために残します。 */
export function replayFromBoundary(input: {
  messages: ReadonlyArray<CompactorConversationMessage>;
  boundary: number;
}): CompactorConversationMessage[] {
  const head = input.messages.slice(0, input.boundary);
  const continuePrompt: CompactorConversationMessage = {
    role: 'system',
    content: '（Context overflow 回復用）上記履歴を踏まえ、次のステップがあれば実行してください。なければ最終回答を返してください。',
  };
  return [...head, continuePrompt];
}

/** reasoning effort を強制すべきモデルか判定します。gpt-oss-* のようなreasoning系は low を強制。 */
export function shouldForceLowReasoningEffort(modelId: string): boolean {
  return /^.*\/gpt-oss(?:-(?:low|medium|high))?$/i.test(modelId);
}

/** モデル送信前にTool結果をカットオフする。opencodeの `toolOutputMaxChars` 相当。 */
export function truncateToolOutput(content: string, maxChars = TOOL_OUTPUT_MAX_CHARS): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  const omitted = content.length - head - tail;
  return `${content.slice(0, head)}\n...[${omitted.toLocaleString('en-US')}文字を省略。strip後のTool出力]...\n${content.slice(-tail)}`;
}

/** Providerごとの表現差を吸収し、入力Context超過のエラーだけを回復対象として識別します。 */
export function isContextOverflowError(message: string): boolean {
  return /(?:input length|maximum context length|context length|context window|too many tokens|context[_ ]length[_ ]exceeded)/i.test(message)
    && /(?:exceed|maximum|too many|overflow|long)/i.test(message);
}

/** 再試行時にToolメッセージの対応関係を保ったまま、出力本文だけをさらに圧縮します。 */
export function compactToolOutputsForRetry<T extends { role: string; content?: unknown }>(messages: ReadonlyArray<T>, maxChars = 8_000): T[] {
  return messages.map(message => message.role === 'tool' && typeof message.content === 'string'
    ? { ...message, content: truncateToolOutput(message.content, maxChars) }
    : { ...message });
}

/** モデル別のcompact threshold設定を解決します。 */
export interface ModelCompactionConfig {
  contextTokens?: number;
  compactThresholdRatio?: number;
  hardStopRatio?: number;
  minMessagesBetweenCompacts?: number;
  tokenThreshold?: number;
}

export function resolveModelCompactionConfig(
  modelId: string,
  globalConfig: ModelCompactionConfig,
  modelSpecific: Record<string, ModelCompactionConfig> = {},
): Required<ModelCompactionConfig> {
  const specific = modelSpecific[modelId] || {};
  return {
    contextTokens: specific.contextTokens ?? globalConfig.contextTokens ?? 8_192,
    compactThresholdRatio: specific.compactThresholdRatio ?? globalConfig.compactThresholdRatio ?? 0.8,
    hardStopRatio: specific.hardStopRatio ?? globalConfig.hardStopRatio ?? 0.95,
    minMessagesBetweenCompacts: specific.minMessagesBetweenCompacts ?? globalConfig.minMessagesBetweenCompacts ?? 5,
    tokenThreshold: specific.tokenThreshold ?? globalConfig.tokenThreshold ?? 0,
  };
}

/** モデルの `provider/model` ID から、Provider capabilities の contextTokens を引きます。 */
export function resolveContextTokens(modelId: string, lookup: (providerId: string) => number | undefined, fallback = 8_192): number {
  const slash = modelId.indexOf('/');
  if (slash < 0) return fallback;
  const providerId = modelId.slice(0, slash);
  const value = lookup(providerId);
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** モデル+依頼内容から、Task分割が必要かどうか判定します。 */
export function shouldSuggestTaskSplit(input: {
  estimatedRequestTokens: number;
  contextTokens: number;
  requestType: 'local_tool' | 'chat' | 'web_research' | 'analyze_image' | 'delegate_external';
}): boolean {
  // 8K未満のモデルで local_tool 依頼、かつ推定依頼トークンが 2K を超える場合は分割を推奨
  if (input.contextTokens < 16_000 && input.requestType === 'local_tool' && input.estimatedRequestTokens > 2_000) return true;
  // 8K未満のモデルで推定依頼トークンが 4K を超える場合も分割を推奨
  if (input.contextTokens < 16_000 && input.estimatedRequestTokens > 4_000) return true;
  return false;
}

/** Context不足時にユーザーへ提示する分割ガイダンスを返します。 */
export function buildTaskSplitGuidance(input: {
  contextTokens: number;
  estimatedTokens: number;
  requestedModel: string;
}): string {
  return [
    'Context予算を超えるため依頼を分割することをお勧めします。',
    `- 現在のモデル: ${input.requestedModel}（Context上限 ${input.contextTokens.toLocaleString('en-US')}トークン）`,
    `- 推定使用量: ${input.estimatedTokens.toLocaleString('en-US')}トークン`,
    '- 推奨対応:',
    '  1. 依頼を「特定ファイル単位」に分解する（例: `package.json を読んで要約`）',
    '  2. 大型Context対応モデル（lmstudio: 131,072トークンを保守的な共通上限として設定）へ切り替える',
    '  3. 範囲を限定した質問にする（例: `src/agent-tools.ts の概要`）',
  ].join('\n');
}
