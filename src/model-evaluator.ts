/** 応答評価（Response Evaluation）は取得した本文の構造だけを検証し、自己申告の正しさを採用しません。 */
export function evaluateModelResponse(result: Record<string, unknown>, jsonRequired = false): { passed: boolean; reason?: string } {
  const choices = result.choices as Array<{ message?: { content?: unknown; tool_calls?: unknown[] }; finish_reason?: string }> | undefined;
  if (!Array.isArray(choices) || !choices.length) return { passed: false, reason: '応答候補がありません。' };
  for (const choice of choices) {
    const message = choice.message;
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) continue;
    if (typeof message?.content !== 'string' || !message.content.trim()) return { passed: false, reason: '回答が空です。' };
    if (jsonRequired) {
      try { JSON.parse(message.content); } catch { return { passed: false, reason: '要求されたJSONの構文が不正です。' }; }
    }
    if (choice.finish_reason === 'length') return { passed: false, reason: '出力長の上限で回答が打ち切られました。' };
  }
  return { passed: true };
}
