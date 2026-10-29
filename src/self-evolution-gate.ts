import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './atomic-file.js';
import type { GoalQualityGate } from './goal-loop.js';

export interface EvolutionCommand {
  id: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  /** benchmark指定時は標準出力の最後の行を数値として比較します。 */
  kind: 'check' | 'benchmark';
  /** benchmarkで許容する低下量。0ならベースライン未満を拒否します。 */
  maxRegression?: number;
}

export interface EvolutionGateConfig {
  version: 1;
  commands: EvolutionCommand[];
  maxEvaluationMs: number;
}

interface CommandObservation {
  id: string; kind: EvolutionCommand['kind']; exitCode: number | null; durationMs: number;
  score?: number; stdout: string; stderr: string; timedOut: boolean;
}

export interface EvolutionBaseline { capturedAt: string; observations: CommandObservation[]; }
export interface EvolutionReport { passed: boolean; summary: string; startedAt: string; finishedAt: string; baseline: EvolutionBaseline; candidate: CommandObservation[]; }

/**
 * `.wentian/evolution.json` に固定された検査・ベンチマークを変更前後で実行します。
 * シェルを介さず絶対パスの実行ファイルだけを許可し、設定ファイル自体をAgentの出力から再読込みしません。
 */
export class SelfEvolutionGate implements GoalQualityGate {
  private constructor(private readonly root: string, private readonly config: EvolutionGateConfig) {}

  static async load(root: string): Promise<SelfEvolutionGate> {
    const resolved = path.resolve(root);
    const raw = await readFile(path.join(resolved, '.wentian', 'evolution.json'), 'utf8');
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('自己進化設定は64KiB以下にしてください。');
    return new SelfEvolutionGate(resolved, validateConfig(JSON.parse(raw)));
  }

  /** 設定が無い通常プロジェクトでは従来動作を保ち、設定がある場合だけ品質ゲートを有効化します。 */
  static async loadIfConfigured(root: string): Promise<SelfEvolutionGate | undefined> {
    try { return await SelfEvolutionGate.load(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }

  async captureBaseline(cwd: string, signal?: AbortSignal): Promise<EvolutionBaseline> {
    this.ensureRoot(cwd);
    return { capturedAt: new Date().toISOString(), observations: await this.runAll(signal) };
  }

  async evaluate(cwd: string, value: unknown, signal?: AbortSignal): Promise<{ passed: boolean; summary: string; reportPath: string }> {
    this.ensureRoot(cwd);
    const baseline = value as EvolutionBaseline;
    if (!baseline || !Array.isArray(baseline.observations)) throw new Error('有効なベースラインがありません。');
    const startedAt = new Date().toISOString();
    const candidate = await this.runAll(signal);
    const failures: string[] = [];
    for (const command of this.config.commands) {
      const before = baseline.observations.find(item => item.id === command.id);
      const after = candidate.find(item => item.id === command.id)!;
      if (after.exitCode !== 0 || after.timedOut) failures.push(`${command.id}: 終了コード=${after.exitCode ?? 'none'}${after.timedOut ? '、Timeout' : ''}`);
      if (command.kind === 'benchmark') {
        if (before?.score === undefined || after.score === undefined) failures.push(`${command.id}: 数値スコアを取得できません。`);
        else if (after.score < before.score - (command.maxRegression ?? 0)) failures.push(`${command.id}: ${before.score}から${after.score}へ低下しました。`);
      }
    }
    const report: EvolutionReport = { passed: failures.length === 0, summary: failures.length ? failures.join(' / ') : `${candidate.length}件の固定評価に合格しました。`, startedAt, finishedAt: new Date().toISOString(), baseline, candidate };
    const reportPath = await this.saveReport(report);
    return { passed: report.passed, summary: report.summary, reportPath };
  }

  private async runAll(signal?: AbortSignal): Promise<CommandObservation[]> {
    const deadline = Date.now() + this.config.maxEvaluationMs;
    const results: CommandObservation[] = [];
    for (const command of this.config.commands) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('品質評価の合計時間上限に到達しました。');
      results.push(await runCommand(command, Math.min(command.timeoutMs, remaining), this.root, signal));
    }
    return results;
  }

  private ensureRoot(cwd: string): void { if (path.resolve(cwd) !== this.root) throw new Error('品質ゲートの作業場所が設定読込み時と一致しません。'); }
  private async saveReport(report: EvolutionReport): Promise<string> {
    const directory = path.join(this.root, '.wentian', 'evolution', 'runs'); await mkdir(directory, { recursive: true });
    const target = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
    const temporary = `${target}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); await renameWithRetry(temporary, target); return target;
  }
}

function validateConfig(value: unknown): EvolutionGateConfig {
  const row = value as EvolutionGateConfig;
  if (!row || row.version !== 1 || !Array.isArray(row.commands) || !row.commands.length || row.commands.length > 12
    || !Number.isInteger(row.maxEvaluationMs) || row.maxEvaluationMs < 100 || row.maxEvaluationMs > 1_800_000) throw new Error('自己進化設定の形式が不正です。');
  const ids = new Set<string>();
  for (const command of row.commands) {
    if (!command || !/^[a-zA-Z0-9_-]{1,64}$/.test(command.id) || ids.has(command.id) || !path.isAbsolute(command.executable)
      || /[\r\n\0]/.test(command.executable) || !Array.isArray(command.args) || command.args.length > 64
      || !command.args.every(arg => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0'))
      || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 300_000
      || !['check', 'benchmark'].includes(command.kind) || (command.maxRegression !== undefined && (!Number.isFinite(command.maxRegression) || command.maxRegression < 0))) throw new Error('自己進化コマンドの形式が不正です。');
    ids.add(command.id);
  }
  return structuredClone(row);
}

function runCommand(command: EvolutionCommand, timeoutMs: number, cwd: string, signal?: AbortSignal): Promise<CommandObservation> {
  return new Promise(resolve => {
    const started = Date.now(); let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
    const child = spawn(command.executable, command.args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (exitCode: number | null) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); const scoreText = stdout.trim().split(/\r?\n/).at(-1); const score = command.kind === 'benchmark' && scoreText !== undefined && Number.isFinite(Number(scoreText)) ? Number(scoreText) : undefined; resolve({ id: command.id, kind: command.kind, exitCode, durationMs: Date.now() - started, ...(score !== undefined ? { score } : {}), stdout: stdout.slice(-20_000), stderr: stderr.slice(-20_000), timedOut }); };
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { stderr += error.message; finish(null); }); child.on('close', code => finish(code));
    const abort = () => { child.kill(); finish(null); }; signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); finish(null); }, timeoutMs);
    if (signal?.aborted) abort();
  });
}
