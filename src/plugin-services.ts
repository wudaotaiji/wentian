import { serviceKey } from './plugin-kernel.js';
import type { createAIRepairPlan } from './agent-repair-planner.js';
import type { createAgentPlan } from './agent-planner.js';

/** CoreとPlugin間で共有する、型付きService Seam名です。 */
export const REPAIR_PLANNER_SERVICE = serviceKey<typeof createAIRepairPlan>('wentian.repair.planner');
export const PLANNER_SERVICE = serviceKey<typeof createAgentPlan>('wentian.planner');
export const SELECTOR_SERVICE = serviceKey<unknown>('wentian.selector');
export const RUNNER_SERVICE = serviceKey<unknown>('wentian.runner');
export const MODEL_SERVICE = serviceKey<unknown>('wentian.model.catalog');
export const TOOL_SERVICE = serviceKey<unknown>('wentian.tool.registry');
export const SKILL_SERVICE = serviceKey<unknown>('wentian.skill.registry');
export const SESSION_SERVICE = serviceKey<unknown>('wentian.session.store');
export const SANDBOX_SERVICE = serviceKey<unknown>('wentian.sandbox');
export const STORAGE_SERVICE = serviceKey<unknown>('wentian.storage');
export const LOOP_SERVICE = serviceKey<unknown>('wentian.loop');
export const SCHEDULER_SERVICE = serviceKey<unknown>('wentian.scheduler');
export const UI_SERVICE = serviceKey<unknown>('wentian.ui');
export const VERIFIER_SERVICE = serviceKey<unknown>('wentian.verifier');
export const MEMORY_SERVICE = serviceKey<unknown>('wentian.memory');
