import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import { WentianPluginKernel, type WentianPluginDefinition } from '../plugin-kernel.js';
import { FederationError, record, text } from './contracts.js';

export interface MachineObservation {
  platform: string; arch: string; cpuCores: number; totalMemoryBytes: number; freeMemoryBytes: number;
  freeDiskBytes: number; processMemoryBytes: number;
}
export interface ManagedPlugin {
  definition: WentianPluginDefinition;
  description: string; memoryBudgetBytes: number; diskBudgetBytes: number;
  health: (kernel: WentianPluginKernel) => Promise<{ healthy: boolean; detail: string }>;
}
export interface MaintenancePlan {
  status: 'ready' | 'unknown'; plugins: string[]; restartPlugins: string[];
  kernelAction: 'keep' | 'restart'; reason: string;
}
export interface SupervisorOptions {
  directory: string; catalog: ManagedPlugin[];
  decide: (input: unknown) => Promise<unknown>;
  reserveMemoryBytes: number; reserveDiskBytes: number;
  observe?: () => MachineObservation; requestRestart?: () => void;
}

/** 最小内核は観測・契約検証・ライフサイクルだけを持ち、機器に応じた構成判断はAIが行います。 */
export class NodeSupervisor {
  readonly kernel = new WentianPluginKernel();
  private readonly catalog: Map<string, ManagedPlugin>;
  private busy = false;
  private closed = false;
  private last = { state: 'initial' as string, reason: 'AIによる初回構成判断を待っています。', at: '' };
  private readonly file: string;
  constructor(private readonly options: SupervisorOptions) {
    if (![options.reserveMemoryBytes, options.reserveDiskBytes].every(value => Number.isSafeInteger(value) && value >= 0) || options.catalog.some(item => ![item.memoryBudgetBytes, item.diskBudgetBytes].every(value => Number.isSafeInteger(value) && value >= 0))) throw new FederationError('プラグインの資源予算が不正です。');
    this.catalog = new Map(options.catalog.map(plugin => [plugin.definition.id, plugin]));
    if (this.catalog.size !== options.catalog.length) throw new FederationError('保守対象プラグインが重複しています。');
    for (const item of options.catalog) this.kernel.register(item.definition);
    this.file = path.join(options.directory, 'node-maintenance.json');
  }
  observation(): MachineObservation {
    if (this.options.observe) return this.options.observe();
    const disk = statfsSync(this.options.directory);
    return { platform: process.platform, arch: process.arch, cpuCores: os.availableParallelism(), totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), freeDiskBytes: disk.bavail * disk.bsize, processMemoryBytes: process.memoryUsage.rss() };
  }
  snapshot() { return { ...this.last, machine: this.observation(), plugins: this.kernel.snapshot().plugins }; }
  private validate(value: unknown): MaintenancePlan {
    const row = record(value);
    if (row.status !== 'ready' || !Array.isArray(row.plugins) || !Array.isArray(row.restartPlugins) || !['keep', 'restart'].includes(String(row.kernelAction))) throw new FederationError('AIの保守計画が未確認または不正です。');
    const plugins = row.plugins.map(id => text(id, 100)), restarts = row.restartPlugins.map(id => text(id, 100));
    if (new Set(plugins).size !== plugins.length || new Set(restarts).size !== restarts.length || plugins.some(id => !this.catalog.has(id)) || restarts.some(id => !plugins.includes(id))) throw new FederationError('AIが未許可のプラグインまたは再起動を指定しました。');
    for (const id of plugins) if (this.catalog.get(id)!.definition.requires?.some(dependency => !plugins.includes(dependency))) throw new FederationError('AI構成の依存関係が不足しています。');
    const machine = this.observation();
    // 予算値は実測保証ではありません。AIが機器条件を無視した場合の入場制約として使用します。
    const memory = plugins.reduce((sum, id) => sum + this.catalog.get(id)!.memoryBudgetBytes, 0);
    const disk = plugins.reduce((sum, id) => sum + this.catalog.get(id)!.diskBudgetBytes, 0);
    const starting = plugins.filter(id => !this.kernel.has(id) || restarts.includes(id));
    const additional = starting.reduce((sum, id) => sum + this.catalog.get(id)!.memoryBudgetBytes, 0);
    if (memory + this.options.reserveMemoryBytes > machine.totalMemoryBytes || (starting.length > 0 && (additional + this.options.reserveMemoryBytes > machine.freeMemoryBytes || disk + this.options.reserveDiskBytes > machine.freeDiskBytes))) throw new FederationError('AI構成がホストの資源安全余裕を超えています。');
    return { status: 'ready', plugins, restartPlugins: restarts, kernelAction: row.kernelAction as 'keep' | 'restart', reason: text(row.reason, 2000) };
  }
  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8'));
      const plan = this.validate(stored.plan);
      await this.apply({ ...plan, restartPlugins: [], kernelAction: 'keep' });
      this.last = { state: 'restored', reason: '直前に検証済みのプラグイン構成を復元しました。', at: new Date().toISOString() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.last = { state: 'unknown', reason: '保存構成を復元できません。最小内核を維持します。', at: new Date().toISOString() };
    }
  }
  private async apply(plan: MaintenancePlan) {
    const previous = this.kernel.snapshot().plugins.map(plugin => plugin.id);
    try {
      for (const id of plan.restartPlugins) if (this.kernel.has(id)) await this.kernel.unload(id, true);
      await this.kernel.load(plan.plugins.map(id => ({ id })));
      for (const id of plan.plugins) if (!(await this.catalog.get(id)!.health(this.kernel)).healthy) throw new FederationError('新構成の実稼働確認に失敗しました。');
      for (const id of previous.filter(id => !plan.plugins.includes(id)).reverse()) await this.kernel.unload(id, true);
    } catch (error) {
      for (const id of this.kernel.snapshot().plugins.map(plugin => plugin.id).filter(id => !previous.includes(id)).reverse()) await this.kernel.unload(id, true);
      await this.kernel.load(previous.map(id => ({ id })));
      throw error;
    }
  }
  async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const health = [];
      for (const plugin of this.catalog.values()) if (this.kernel.has(plugin.definition.id)) {
        try { health.push({ id: plugin.definition.id, ...await plugin.health(this.kernel) }); }
        catch { health.push({ id: plugin.definition.id, healthy: false, detail: 'ヘルス確認に失敗しました。' }); }
      }
      const plan = this.validate(await this.options.decide({ machine: this.observation(), current: this.kernel.snapshot().plugins, health, catalog: [...this.catalog.values()].map(item => ({ id: item.definition.id, description: item.description, requires: item.definition.requires || [], memoryBudgetBytes: item.memoryBudgetBytes, diskBudgetBytes: item.diskBudgetBytes })), reserves: { memoryBytes: this.options.reserveMemoryBytes, diskBytes: this.options.reserveDiskBytes } }));
      if (this.closed) return;
      await this.apply(plan);
      const temporary = this.file + '.' + process.pid + '.tmp';
      // 最後に稼働確認した構成だけを保存し、再起動時にAI応答がなくても復元可能にします。
      await writeFile(temporary, JSON.stringify({ version: 1, plan: { ...plan, restartPlugins: [], kernelAction: 'keep' }, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
      await rename(temporary, this.file);
      this.last = { state: 'healthy', reason: plan.reason, at: new Date().toISOString() };
      if (plan.kernelAction === 'restart') this.options.requestRestart?.();
    } catch (error) {
      this.last = { state: 'unknown', reason: error instanceof FederationError ? error.message : 'AI保守を確認できません。直前の構成を維持します。', at: new Date().toISOString() };
    } finally { this.busy = false; }
  }
  async close(): Promise<void> {
    this.closed = true;
    // 終了中にAI判断の結果を適用させません。既存の実行は各Pluginの終了処理で照合します。
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 10));
    await this.kernel.dispose();
  }
}

/** 人の意図と機器情報から構成を決める責任をAIへ渡し、固定RAM閾値でプラグインを選びません。 */
export function createMaintenanceDecider(complete: (body: unknown) => Promise<unknown>, model: string, objective: string) {
  return async (observation: unknown) => {
    const response = await complete({ model, stream: false, temperature: 0, max_tokens: 1000, messages: [
      { role: 'system', content: 'あなたは各マシンのWentian最小内核をバックグラウンドで保守するAIです。機器資源、ユーザーの目的、許可済みプラグイン、現在のヘルスから必要な最小構成を選びます。未許可のコード・プラグインは追加できません。依存を含め、不要な機能を常駐させず、ヘルス不良なら必要なプラグインの再起動を提案してください。正常な内核はkeepとし、必要な場合だけkernelActionをrestartにします。自己申告を実測と混同しないでください。判断不能ならstatusはunknownです。JSONだけを返す: {"status":"ready|unknown","plugins":["許可ID"],"restartPlugins":[],"kernelAction":"keep|restart","reason":"日本語の根拠"}' },
      { role: 'user', content: JSON.stringify({ objective, observation }) },
    ] }) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new FederationError('AI保守計画がありません。');
    return JSON.parse(content);
  };
}
