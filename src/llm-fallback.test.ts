import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackAgentPlan } from './agent-planner.js';
import { buildExternalConversationContext, createSequentialExternalFallbackPlan, isAgentFallbackEligibleError, isNoAvailableLlmError,canUseExternalAnswerFallback } from './llm-fallback.js';

test('Web取得結果と出典・取得時刻を外部fallbackへ引き継ぐ',()=>{
 const research={context:'時間別予報: 2026-10-24T15:00 気温22度、降水確率10%',sources:['https://example.test/forecast'],retrievedAt:'2026-10-24T01:00:00Z'};
 const plan=createSequentialExternalFallbackPlan({...fallbackAgentPlan('午後の天気'),evidenceSource:'web'},'午後の天気',[],research);
 assert.deepEqual(plan.answerResearch,research);assert.match(plan.delegation.objective!,/2026-10-24T15:00/);assert.match(plan.delegation.objective!,/https:\/\/example.test\/forecast/);assert.match(plan.delegation.objective!,/webEvidence/);assert.match(plan.delegation.objective!,/Workspace調査やファイル引用は不要/);
});

test('外部fallbackへ同じSessionのファイル文脈を引き継ぐ', () => {
  const context = buildExternalConversationContext([
    { role: 'user', content: 'C:\\mywork\\tempのsnake_game.htmlを作って' },
    { role: 'assistant', content: '作成しました。' },
    { role: 'user', content: '調速機能を追加して' },
  ], '調速機能を追加して');
  assert.match(context, /C:\\mywork\\temp/);
  assert.match(context, /snake_game\.html/);
  assert.match(context, /User: 調速機能を追加して/);
});

test('構造化AI判断ではSystem指示も外部Agentへ引き継ぐ', () => {
  const context = buildExternalConversationContext([
    { role: 'system', content: 'JSONだけを返してください。' },
    { role: 'user', content: 'この依頼を分類してください。' },
  ], 'この依頼を分類してください。');
  assert.match(context, /System: JSONだけを返してください。/);
});

test('利用可能なLLMモデルなしのエラーだけをfallback対象にする', () => {
  assert.equal(isNoAvailableLlmError(new Error('利用可能なLLMモデルがありません。')), true);
  assert.equal(isNoAvailableLlmError(new Error('No available LLM models')), true);
  assert.equal(isNoAvailableLlmError(new Error('HTTP 401')), false);
});

test('Gateway接続失敗は外部Agent fallback対象とし認証エラーは対象外にする', () => {
  assert.equal(isAgentFallbackEligibleError(new Error('GatewayまたはProviderとの接続が途中で切断されました。詳細: Unable to connect')), true);
  assert.equal(isAgentFallbackEligibleError(new Error('connect ECONNREFUSED 127.0.0.1:8787')), true);
  assert.equal(isAgentFallbackEligibleError(new Error('HTTP 401')), false);
});

test('ローカルLLM不在時は外部Agentの直列計画へ変換する', () => {
  const plan = createSequentialExternalFallbackPlan(fallbackAgentPlan('你好！'), '你好！');
  assert.equal(plan.intent, 'delegate_external');
  assert.equal(plan.delegation.enabled, true);
  assert.equal(plan.delegation.parallel, false);
  assert.deepEqual(plan.delegation.requestedAgents, []);
  assert.deepEqual(plan.requiredCapabilities, ['review']);
  assert.match(plan.delegation.objective || '', /^\[Wentian LLM fallback\]/);
  const chinese = createSequentialExternalFallbackPlan({ ...fallbackAgentPlan('你好！'), language: 'zh' }, '你好！');
  assert.match(chinese.delegation.objective || '', /必须使用中文回答/);
  const investigation=createSequentialExternalFallbackPlan({...fallbackAgentPlan('仕組みを説明して'),evidenceSource:'workspace',operation:'read'},'仕組みを説明して');
  assert.ok(investigation.requiredCapabilities.includes('file_read'));assert.equal(investigation.responseContract,'grounded_answer');
});

test('AIが内部読取を選んでも不通時は代替でき、利用者の明示した内部限定や権限制約は維持する',()=>{
 const plan={...fallbackAgentPlan('実装を調べて'),executionMode:'direct' as const,evidenceSource:'workspace' as const},error=Error('利用可能なLLMモデルがありません。');
 assert.equal(canUseExternalAnswerFallback(plan,{},error),true);
 for(const mode of ['direct','propose'] as const)assert.equal(canUseExternalAnswerFallback(plan,{mode},error),false);
 assert.equal(canUseExternalAnswerFallback(plan,{},error,false,true),false);
 assert.equal(canUseExternalAnswerFallback({...plan,requiredCapabilities:['file_write']},{},error),false);
 assert.equal(canUseExternalAnswerFallback(plan,{},Error('HTTP 401')),false);
});
