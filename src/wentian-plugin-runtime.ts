import { studyJupyterPlugin } from './study/plugin.js';
import { meetingsPlugin } from './meetings/plugin.js';
import { cloudFederationPlugins } from './cloud-federation/plugin.js';
import { skillRegistry } from './skills.js';
import * as planner from './agent-planner.js';
import * as selector from './agent-selection.js';
import * as tools from './agent-tools.js';
import * as sessions from './agent-session.js';
import * as sandbox from './task-workspace.js';
import * as verifier from './acceptance-verification.js';
import * as memory from './memory-layer.js';
import * as loop from './goal-loop.js';
import * as scheduler from './external-agent-readiness.js';
import * as modelCatalog from './config.js';
import { managerDashboardHtml } from './dashboard.js';
import { JsonlEventStore } from './storage.js';
import { createAIRepairPlan } from './agent-repair-planner.js';
import { WentianPluginKernel, type WentianPluginDefinition, type WentianServiceKey } from './plugin-kernel.js';
import { importManifestPlugins, loadPluginManifest, resolvePluginManifest } from './plugin-config.js';
import { getActivePluginKernel, setActivePluginKernel } from './plugin-runtime.js';
import { LOOP_SERVICE, MEMORY_SERVICE, MODEL_SERVICE, PLANNER_SERVICE, REPAIR_PLANNER_SERVICE, RUNNER_SERVICE, SANDBOX_SERVICE, SCHEDULER_SERVICE, SELECTOR_SERVICE, SESSION_SERVICE, SKILL_SERVICE, STORAGE_SERVICE, TOOL_SERVICE, UI_SERVICE, VERIFIER_SERVICE } from './plugin-services.js';

function plugin(id: string, kind: WentianPluginDefinition['kind'], key: WentianServiceKey, value: unknown): WentianPluginDefinition {
  return { id, kind, version: '1.0.0', provides: [key], setup: context => { context.provide(key, value); } };
}

/** 現行Wentian機能を共通Contractへ載せる標準Plugin群です。外部Pluginは同じServiceをOverlayできます。 */
export function builtinWentianPlugins(): WentianPluginDefinition[] {
  return [
    ...cloudFederationPlugins(),
    studyJupyterPlugin,
    meetingsPlugin,
    plugin('core.model', 'model', MODEL_SERVICE, modelCatalog),
    plugin('core.tools', 'tool', TOOL_SERVICE, tools),
    plugin('core.skills', 'skill', SKILL_SERVICE, skillRegistry),
    plugin('core.session', 'session', SESSION_SERVICE, sessions),
    plugin('core.sandbox', 'sandbox', SANDBOX_SERVICE, sandbox),
    plugin('core.storage', 'storage', STORAGE_SERVICE, { create: (file: string) => new JsonlEventStore({ path: file }) }),
    plugin('core.loop', 'loop', LOOP_SERVICE, loop),
    plugin('core.scheduler', 'scheduler', SCHEDULER_SERVICE, scheduler),
    plugin('core.ui', 'ui', UI_SERVICE, { render: managerDashboardHtml }),
    plugin('core.planner', 'planner', PLANNER_SERVICE, planner.createAgentPlan),
    plugin('core.selector', 'selector', SELECTOR_SERVICE, selector),
    plugin('core.runner', 'runner', RUNNER_SERVICE, { mode: 'external-orchestrator' }),
    plugin('core.repair', 'repair', REPAIR_PLANNER_SERVICE, createAIRepairPlan),
    plugin('core.verifier', 'verifier', VERIFIER_SERVICE, verifier),
    plugin('core.memory', 'memory', MEMORY_SERVICE, memory),
  ];
}

/** ManifestだけでProfile・外部Module・Overlayを組み立て、Active Runtimeとして切り替えます。 */
export async function initializeWentianPluginRuntime(manifestFile = resolvePluginManifest()): Promise<WentianPluginKernel> {
  const previous = getActivePluginKernel();
  if (previous) return previous;
  return reloadWentianPluginRuntime(manifestFile);
}

/** 新構成を先に完全ロードし、成功した場合だけActive Runtimeを原子的に交換します。 */
export async function reloadWentianPluginRuntime(manifestFile = resolvePluginManifest()): Promise<WentianPluginKernel> {
  const previous = getActivePluginKernel();
  const { manifest, specs, file } = await loadPluginManifest(manifestFile);
  const kernel = new WentianPluginKernel();
  for (const definition of builtinWentianPlugins()) kernel.register(definition);
  for (const definition of await importManifestPlugins(manifest, file)) kernel.register(definition);
  await kernel.load(specs);
  setActivePluginKernel(kernel);
  await previous?.dispose();
  return kernel;
}

export async function shutdownWentianPluginRuntime(): Promise<void> {
  const kernel = getActivePluginKernel();
  setActivePluginKernel(undefined);
  await kernel?.dispose();
}
