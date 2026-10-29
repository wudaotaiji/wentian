export type RepairFailureKind = 'permission' | 'provider' | 'model' | 'rate_limit' | 'timeout' | 'stalled' | 'forbidden_operation' | 'authentication' | 'tool_not_applied' | 'not_installed' | 'runtime_dependency' | 'unknown';
export type RepairAction = 'retry_same' | 'enable_workspace_auto_approval' | 'switch_model' | 'use_internal_resource' | 'handoff';
import { loadAgentSelectionConfig } from './agent-selection.js';

export interface RepairPlannerInput {
  agent: string;
  role: 'builder' | 'tester' | 'verifier' | 'reviewer';
  failureKind: RepairFailureKind;
  failureSummary: string;
  attempt: number;
  isolatedWorkspace: boolean;
  allowedModels: string[];
  /** Wentian内で既にロード済みかつ、同じ役割を引き継げる資源だけを渡します。 */
  allowedInternalResources?: string[];
}

export interface RepairPlan {
  version: '1.0';
  source: 'ai' | 'fallback';
  action: RepairAction;
  model?: string;
  resource?: string;
  rationale: string;
}

const actions = new Set<RepairAction>(['retry_same', 'enable_workspace_auto_approval', 'switch_model', 'use_internal_resource', 'handoff']);

/** AI出力から最初のJSONオブジェクトだけを取り出し、説明文やコードフェンスを実行対象へ混入させません。 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

/** AIの提案を固定Policyで検証し、許可されない変更は必ずhandoffへ縮退させます。 */
export function validateRepairPlan(value: unknown, input: RepairPlannerInput, source: RepairPlan['source'] = 'ai'): RepairPlan {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const proposed = actions.has(row.action as RepairAction) ? row.action as RepairAction : 'handoff';
  const rationale = typeof row.rationale === 'string' ? row.rationale.trim().slice(0, 500) : '安全Policyにより修復方法を決定しました。';
  // Runtime依存欠落はダウンロードせず、Wentianが提示したロード済み内部資源だけで代替します。
  if (input.failureKind === 'runtime_dependency') {
    const proposedResource = typeof row.resource === 'string' ? row.resource.trim() : '';
    const resource = input.allowedInternalResources?.includes(proposedResource) ? proposedResource : input.allowedInternalResources?.[0];
    // AI提案より内部資源優先Policyを上位に置き、許可済み資源があれば必ずそちらへ正規化します。
    return resource
      ? { version: '1.0', source, action: 'use_internal_resource', resource, rationale: proposed === 'use_internal_resource' ? rationale : '内部資源優先Policyにより、ダウンロードせずWentian内部Runnerへ切り替えます。' }
      : { version: '1.0', source, action: 'handoff', rationale: '互換性を確認済みのWentian内部資源がないため次Agentへ引き継ぎます。' };
  }
  // 資格情報、インストール、Tool未適用、不明障害は、AIが再試行を提案しても自動変更しません。
  if (['authentication', 'not_installed', 'tool_not_applied', 'forbidden_operation', 'unknown'].includes(input.failureKind)) return { version: '1.0', source, action: 'handoff', rationale: '自動変更が禁止された失敗種別のため次Agentへ引き継ぎます。' };
  if (proposed === 'enable_workspace_auto_approval') {
    const permitted = input.failureKind === 'permission' && input.isolatedWorkspace && ['kilo', 'opencode'].includes(input.agent);
    return permitted
      ? { version: '1.0', source, action: proposed, rationale }
      : { version: '1.0', source, action: 'handoff', rationale: '自動承認は隔離Workspace上のKilo/OpenCode権限障害だけに許可されます。' };
  }
  if (proposed === 'switch_model') {
    const model = typeof row.model === 'string' ? row.model.trim() : '';
    const permitted = input.agent === 'opencode' && ['provider', 'model', 'rate_limit', 'timeout'].includes(input.failureKind) && input.allowedModels.includes(model);
    return permitted
      ? { version: '1.0', source, action: proposed, model, rationale }
      : { version: '1.0', source, action: 'handoff', rationale: 'モデル変更が許可一覧または対象障害の条件を満たしません。' };
  }
  // 初回の一時障害をAIの根拠薄弱なhandoffで即終了させず、許可済みの最小修復を1回保証します。
  if (proposed === 'handoff' && input.attempt === 1 && ['provider', 'model', 'rate_limit', 'timeout'].includes(input.failureKind)) {
    if (input.agent === 'opencode' && input.allowedModels.length) return { version: '1.0', source, action: 'switch_model', model: input.allowedModels[0], rationale: '初回一時障害のため、内部Policyにより許可済みModelへ切り替えます。' };
    return { version: '1.0', source, action: 'retry_same', rationale: '初回一時障害のため、内部Policyにより同じ安全設定で1回再試行します。' };
  }
  if (proposed === 'retry_same' && ['provider', 'rate_limit', 'timeout'].includes(input.failureKind)) return { version: '1.0', source, action: proposed, rationale };
  return { version: '1.0', source, action: 'handoff', rationale: proposed === 'handoff' ? rationale : '同一設定の再試行が許可されない障害です。' };
}

/** AIが利用できない場合にも安全に継続できる、最小権限の決定論的修復計画を返します。 */
export function fallbackRepairPlan(input: RepairPlannerInput): RepairPlan {
  if (input.failureKind === 'runtime_dependency' && input.allowedInternalResources?.length) {
    return validateRepairPlan({ action: 'use_internal_resource', resource: input.allowedInternalResources[0], rationale: '欠落Moduleをダウンロードせず、ロード済みのWentian内部Runnerで役割を引き継ぎます。' }, input, 'fallback');
  }
  if (input.failureKind === 'permission' && input.isolatedWorkspace && ['kilo', 'opencode'].includes(input.agent)) {
    return validateRepairPlan({ action: 'enable_workspace_auto_approval', rationale: '隔離Workspace内だけで権限を再承認します。' }, input, 'fallback');
  }
  if (input.agent === 'opencode' && ['provider', 'model', 'rate_limit', 'timeout'].includes(input.failureKind) && input.allowedModels.length) {
    const index = Math.min(Math.max(0, input.attempt - 1), input.allowedModels.length - 1);
    return validateRepairPlan({ action: 'switch_model', model: input.allowedModels[index], rationale: '許可済みFallbackモデルへ切り替えます。' }, input, 'fallback');
  }
  if (['provider', 'rate_limit', 'timeout'].includes(input.failureKind)) return validateRepairPlan({ action: 'retry_same', rationale: '一時障害として同じ安全設定で再試行します。' }, input, 'fallback');
  return validateRepairPlan({ action: 'handoff', rationale: '安全に自動修復できないため次Agentへ引き継ぎます。' }, input, 'fallback');
}

/** Wentian Plannerモデルへ原因と許可範囲を渡し、Policy検証済みのRepair Planだけを返します。 */
export async function createAIRepairPlan(input: RepairPlannerInput, server: string, signal?: AbortSignal): Promise<RepairPlan> {
  const system = `You are a repair planner. Return exactly one JSON object and no prose. Never execute commands. Shape: {"version":"1.0","action":"handoff","model":"","resource":"","rationale":""}. Allowed actions: retry_same, enable_workspace_auto_approval, switch_model, use_internal_resource, handoff. For runtime_dependency, prefer use_internal_resource from allowed_internal_resources. Never propose credential changes, package installation, download, deletion, Git changes, external state changes, arbitrary commands, or a value outside the supplied allowlists.`;
  // Planner自身の無応答で外部Agentの引継ぎが停止しないよう、利用者の中断とは独立した短いTimeoutを設けます。
  const config = loadAgentSelectionConfig();
  const configuredTimeout = Number(process.env.WENTIAN_REPAIR_PLANNER_TIMEOUT_MS || config.repairPlanner.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(300_000, Math.max(1_000, configuredTimeout)) : config.repairPlanner.timeoutMs;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error(`Repair Plannerが${timeoutMs}ミリ秒でTimeoutしました。`)), timeoutMs);
  timer.unref();
  const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  try {
    const model = process.env.WENTIAN_REPAIR_PLANNER_MODEL?.trim() || process.env.WENTIAN_PLANNER_MODEL?.trim() || config.repairPlanner.model;
    const response = await fetch(`${server.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wentian-repair-planner': '1' }, signal: requestSignal,
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ ...input, failureSummary: input.failureSummary.slice(0, 2000) }) }] }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as any;
    return validateRepairPlan(extractJson(String(payload?.choices?.[0]?.message?.content || '')), input, 'ai');
  } catch (error) {
    if (signal?.aborted) throw error;
    return fallbackRepairPlan(input);
  } finally {
    clearTimeout(timer);
  }
}
