import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface AgentSelectionConfig {
  selection: 'dynamic';
  maxCandidates: number;
  probeTimeoutMs: number;
  cooldownMs: number;
  repairIntervalMs: number;
  maxRepairAttempts: number;
  costPerMillionTokens: Record<string, number>;
  planner: { model: string; timeoutMs: number };
  /** API不通時に外部Agent（Kilo/OpenCode）へ分類を代替させる際の実行時間と再分類回数です。 */
  plannerFallback: { timeoutMs: number; maxAttempts: number };
  repairPlanner: { model: string; timeoutMs: number };
  roleTimeoutMs: Record<'builder' | 'tester' | 'verifier' | 'reviewer', number>;
  apiFallbackExcludedAgents: string[];
  agentCapabilities: Record<string, Array<'text' | 'vision' | 'web' | 'file_read' | 'file_write' | 'terminal' | 'review'>>;
  modelFamilies?: Record<string, string>;
}

const defaults: AgentSelectionConfig = {
  selection: 'dynamic', maxCandidates: 3, probeTimeoutMs: 15_000, cooldownMs: 30 * 60_000,
  repairIntervalMs: 30_000, maxRepairAttempts: 2, costPerMillionTokens: {},
  planner: { model: 'wentian-auto/all', timeoutMs: 120_000 },
  plannerFallback: { timeoutMs: 90_000, maxAttempts: 2 },
  repairPlanner: { model: 'wentian-auto/all', timeoutMs: 30_000 },
  roleTimeoutMs: { builder: 600_000, tester: 180_000, verifier: 180_000, reviewer: 180_000 },
  apiFallbackExcludedAgents: ['crush'],
  agentCapabilities: {
    ollama: ['text','file_read','file_write','terminal','review'],
    lmstudio: ['text','file_read','file_write','terminal','review'],
    codex: ['text','file_read','file_write','terminal','review'],
    goose: ['text', 'file_read', 'file_write', 'terminal', 'review'], crush: ['text', 'file_read', 'file_write', 'terminal', 'review'],
    kilo: ['text', 'file_read', 'file_write', 'terminal', 'review'], opencode: ['text', 'file_read', 'file_write', 'terminal', 'review'],
    hermes: ['text', 'file_read', 'file_write', 'terminal', 'web', 'review'], claude: ['text', 'file_read', 'file_write', 'terminal', 'review'],
    cline: ['text', 'file_read', 'review'], openclaw: ['text', 'file_read', 'file_write', 'terminal', 'web', 'review'],
  },
};

/** 外部Agent選択設定を読み、欠損値や不正値を安全な既定値へ補正します。 */
export function loadAgentSelectionConfig(configPath = process.env.WENTIAN_AGENT_SELECTION_CONFIG || path.join(process.cwd(), 'agent-selection.json')): AgentSelectionConfig {
  try {
    if (!existsSync(configPath)) return { ...defaults };
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { fallback?: Partial<AgentSelectionConfig> };
    const value = raw.fallback || {};
    return {
      selection: 'dynamic',
      modelFamilies: Object.fromEntries(Object.entries(value.modelFamilies ?? {}).filter(([model, family]) => model.length > 0 && typeof family === 'string' && family.trim().length > 0)),
      maxCandidates: boundedInteger(value.maxCandidates, defaults.maxCandidates, 1, 10),
      probeTimeoutMs: boundedInteger(value.probeTimeoutMs, defaults.probeTimeoutMs, 5_000, 120_000),
      cooldownMs: boundedInteger(value.cooldownMs, defaults.cooldownMs, 10_000, 24 * 60 * 60_000),
      repairIntervalMs: boundedInteger(value.repairIntervalMs, defaults.repairIntervalMs, 10_000, 60 * 60_000),
      maxRepairAttempts: boundedInteger(value.maxRepairAttempts, defaults.maxRepairAttempts, 0, 3),
      costPerMillionTokens: Object.fromEntries(Object.entries(value.costPerMillionTokens || {}).filter(([, cost]) => Number.isFinite(cost) && Number(cost) >= 0).map(([agent, cost]) => [agent, Number(cost)])),
      planner: decisionConfig(value.planner, defaults.planner),
      plannerFallback: {
        timeoutMs: boundedInteger(value.plannerFallback?.timeoutMs, defaults.plannerFallback.timeoutMs, 5_000, 300_000),
        maxAttempts: boundedInteger(value.plannerFallback?.maxAttempts, defaults.plannerFallback.maxAttempts, 1, 3),
      },
      repairPlanner: decisionConfig(value.repairPlanner, defaults.repairPlanner),
      roleTimeoutMs: {
        builder: boundedInteger(value.roleTimeoutMs?.builder, defaults.roleTimeoutMs.builder, 30_000, 3_600_000),
        tester: boundedInteger(value.roleTimeoutMs?.tester, defaults.roleTimeoutMs.tester, 10_000, 900_000),
        verifier: boundedInteger(value.roleTimeoutMs?.verifier, defaults.roleTimeoutMs.verifier, 10_000, 900_000),
        reviewer: boundedInteger(value.roleTimeoutMs?.reviewer, defaults.roleTimeoutMs.reviewer, 10_000, 900_000),
      },
      apiFallbackExcludedAgents: Array.isArray(value.apiFallbackExcludedAgents)
        ? [...new Set(value.apiFallbackExcludedAgents.map(String).map(item => item.trim().toLowerCase()).filter(item => /^[a-z0-9][a-z0-9_-]{1,39}$/.test(item)))]
        : [...defaults.apiFallbackExcludedAgents],
      agentCapabilities: capabilityConfig(value.agentCapabilities, defaults.agentCapabilities),
    };
  } catch {
    // 設定破損で会話機能全体を停止させず、安全な既定値で動作を継続します。
    return { ...defaults };
  }
}

/** Agent能力宣言を設定から読み、安全なCapability語彙だけへ限定します。 */
function capabilityConfig(value: unknown, fallback: AgentSelectionConfig['agentCapabilities']): AgentSelectionConfig['agentCapabilities'] {
  if (!value || typeof value !== 'object') return structuredClone(fallback);
  const allowed = new Set(['text', 'vision', 'web', 'file_read', 'file_write', 'terminal', 'review']);
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([agent, capabilities]) => {
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(agent) || !Array.isArray(capabilities)) return [];
    const normalized = [...new Set(capabilities.map(String).filter(item => allowed.has(item)))] as AgentSelectionConfig['agentCapabilities'][string];
    return normalized.length ? [[agent, normalized] as const] : [];
  });
  return entries.length ? { ...(fallback.codex ? {codex: structuredClone(fallback.codex)} : {}), ...Object.fromEntries(entries) } : structuredClone(fallback);
}

/** AI判断サービスのモデルとTimeoutを、設定可能かつ安全な範囲へ正規化します。 */
function decisionConfig(value: unknown, fallback: { model: string; timeoutMs: number }): { model: string; timeoutMs: number } {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const model = typeof row.model === 'string' && row.model.trim() ? row.model.trim().slice(0, 200) : fallback.model;
  return { model, timeoutMs: boundedInteger(row.timeoutMs, fallback.timeoutMs, 1_000, 300_000) };
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}
