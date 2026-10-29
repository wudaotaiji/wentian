/**
 * External Agent Audit: 5層アーキテクチャ L5。
 * 設計参照: docs/ARCHITECTURE.md
 *
 * - 5TODO完了毎、または consecutiveFailures>=2 で監査を起動
 * - 監査は読み取り専用 (--yolo禁止、人間承認なしの書込禁止)
 * - 監査レポートは .wentian/goals/<id>/audit/<timestamp>.md に保存
 * - 戻り値: proceed / replan / block
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { formatGoalProgress, type GoalStore } from './goal-store.js';

const exec = promisify(execFile);

export type AuditAgent = 'hermes' | 'claude' | 'kilo' | 'mock';
export type AuditVerdict = 'proceed' | 'replan' | 'block';

export interface AuditResult {
  verdict: AuditVerdict;
  reason: string;
  reportPath: string;
  /** 監査にかかった時間 (ms) */
  durationMs: number;
}

export interface AuditOptions {
  cwd: string;
  agent: AuditAgent;
  /** 監査する理由 (例: 'periodic' / 'consecutive-failures' / 'manual') */
  trigger: 'periodic' | 'consecutive-failures' | 'manual';
  /** 監査前のカスタムコンテキスト (省略時は Goal 全体) */
  contextOverride?: string;
  /** mock agent: 検証テストで固定結果を返す */
  mockVerdict?: AuditVerdict;
  /** 監査タイムアウト (ms) */
  timeoutMs?: number;
}

function auditDir(goalId: string): string {
  return path.join(process.env.WENTIAN_GOAL_PATH || path.join(process.cwd(), '.wentian', 'goals'), goalId, 'audit');
}

/** 監査を実行するかを判定します: 5TODO完了毎 or consecutiveFailures>=2。 */
export function shouldAuditGoal(goal: GoalStore, completedSinceLastAudit: number, options: { auditEvery?: number; minConsecutiveFailuresForAudit?: number } = {}): { run: boolean; reason: string } {
  const every = options.auditEvery || 5;
  if (completedSinceLastAudit >= every) return { run: true, reason: `periodic (${completedSinceLastAudit}>=${every})` };
  const threshold = options.minConsecutiveFailuresForAudit || 2;
  if (goal.metrics.consecutiveFailures >= threshold) return { run: true, reason: `consecutive-failures (${goal.metrics.consecutiveFailures}>=${threshold})` };
  return { run: false, reason: 'no trigger' };
}

/** 監査を実行し、verdict と保存先パスを返します。 */
export async function auditGoal(goal: GoalStore, options: AuditOptions): Promise<AuditResult> {
  const startedAt = Date.now();
  const dir = auditDir(goal.id);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const contextText = options.contextOverride || buildAuditContext(goal);
  const prompt = buildAuditPrompt(goal, contextText, options.trigger);

  const verdict = await runAuditAgent(options.agent, prompt, options);
  const reason = extractReason(verdict.rawOutput);
  const finalVerdict: AuditVerdict = verdict.parsed;
  const reportPath = path.join(dir, `${stamp}-${options.agent}-${finalVerdict}.md`);

  const reportBody = [
    `# Goal Audit Report`,
    ``,
    `- goal: \`${goal.id}\``,
    `- title: ${goal.title}`,
    `- agent: ${options.agent}`,
    `- trigger: ${options.trigger}`,
    `- time: ${new Date().toISOString()}`,
    `- verdict: **${finalVerdict}**`,
    `- reason: ${reason}`,
    ``,
    `## Goal Progress`,
    ``,
    '```',
    formatGoalProgress(goal),
    '```',
    ``,
    `## Context`,
    ``,
    contextText,
    ``,
    `## Agent Output (raw)`,
    ``,
    '```',
    verdict.rawOutput.slice(0, 8_000),
    '```',
  ].join('\n');

  await writeFile(reportPath, reportBody, 'utf8');
  return { verdict: finalVerdict, reason, reportPath, durationMs: Date.now() - startedAt };
}

function buildAuditContext(goal: GoalStore): string {
  return [
    `Goal: ${goal.title}`,
    `Description: ${goal.description.slice(0, 2000)}`,
    ``,
    `Progress:`,
    `  completed: ${goal.metrics.completedCount}/${goal.todos.length}`,
    `  blocked: ${goal.metrics.blockedCount}`,
    `  consecutiveFailures: ${goal.metrics.consecutiveFailures}/${goal.stop.maxConsecutiveFailures}`,
    `  totalAttempts: ${goal.metrics.totalAttempts}`,
    ``,
    `TODO一覧:`,
    ...goal.todos.slice(0, 30).map(t => `  - [${t.id}] ${t.status.padEnd(7)} attempts=${t.attempts} ${t.title}${t.lastError ? ` (lastError: ${t.lastError.slice(0, 120)})` : ''}`),
    ...(goal.todos.length > 30 ? [`  ... 他 ${goal.todos.length - 30} 件省略`] : []),
    ``,
    `Blocked:`,
    ...(goal.blocked.length ? goal.blocked.map(b => `  - [${b.todoId}] since=${b.since} reason=${b.reason}`) : [`  (なし)`]),
  ].join('\n');
}

function buildAuditPrompt(goal: GoalStore, context: string, trigger: string): string {
  return [
    `# Goal Audit (${trigger})`,
    ``,
    `あなたはWentian AgentのGoal進捗を監査する外部監査人です。`,
    `**読み取り専用**で判断し、ファイル変更・コマンド実行・外部接続は一切禁止です。`,
    ``,
    `## 監査対象Goal`,
    `- ID: ${goal.id}`,
    `- Title: ${goal.title}`,
    ``,
    `## 監査ルール`,
    `1. Plan構造 (TODO依存関係、優先順位) が妥当か評価`,
    `2. 連続失敗・blocked が増えていないか評価`,
    `3. 人間の介入が必要か評価`,
    ``,
    `## 出力フォーマット (厳守)`,
    `最初の3行を以下の形式にしてください:`,
    `VERDICT: proceed | replan | block`,
    `REASON: <一行理由>`,
    `次に、改善提案や懸念点をMarkdownで記載してください。`,
    ``,
    `## 進捗データ`,
    '```',
    context,
    '```',
  ].join('\n');
}

interface AgentResult { parsed: AuditVerdict; rawOutput: string; }

async function runAuditAgent(agent: AuditAgent, prompt: string, options: AuditOptions): Promise<AgentResult> {
  if (agent === 'mock') {
    return { parsed: options.mockVerdict || 'proceed', rawOutput: `VERDICT: ${options.mockVerdict || 'proceed'}\nREASON: mock result` };
  }
  let command: string; let args: string[];
  if (agent === 'hermes') {
    command = 'hermes'; args = ['chat', '--yolo', '--ignore-rules', '--toolsets', 'clarify', '-p', prompt];
  } else if (agent === 'claude') {
    command = 'claude'; args = ['-p', prompt, '--output-format', 'text'];
  } else {
    // kilo (Kilo CLI)
    command = 'kilo'; args = ['run', '--model', 'kilo/kilo-auto/free', prompt];
  }
  try {
    const { stdout } = await exec(command, args, { cwd: options.cwd, windowsHide: true, timeout: options.timeoutMs || 120_000, maxBuffer: 4 * 1024 * 1024 });
    return { parsed: parseVerdict(stdout), rawOutput: stdout };
  } catch (error) {
    const message = (error as Error).message;
    return { parsed: 'proceed', rawOutput: `[ERROR] agent=${agent} 監査失敗: ${message}\n監査失敗時は安全側で proceed を採用します。` };
  }
}

function parseVerdict(output: string): AuditVerdict {
  const match = output.match(/^\s*VERDICT:\s*(proceed|replan|block)/im);
  if (match) return match[1] as AuditVerdict;
  // フォールバック: 出力に "block" があれば block、"replan" があれば replan、それ以外は proceed
  if (/\bBLOCK\b/i.test(output.split('\n').slice(0, 5).join(' '))) return 'block';
  if (/\bREPLAN\b/i.test(output.split('\n').slice(0, 5).join(' '))) return 'replan';
  return 'proceed';
}

function extractReason(output: string): string {
  const match = output.match(/^\s*REASON:\s*(.+)$/im);
  return match ? match[1].trim().slice(0, 500) : 'reason not found in output';
}

/** 監査レポート一覧を新しい順に返します。 */
export async function listAuditReports(goalId: string): Promise<string[]> {
  const dir = auditDir(goalId);
  let names: string[] = []; try { names = await readdir(dir); } catch { return []; }
  return names.filter(n => n.endsWith('.md')).sort().reverse();
}
