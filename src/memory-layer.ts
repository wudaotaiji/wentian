/**
 * Memory Layer: 人間/プロジェクトの暗黙知識を compact 除外で Agent へ常時注入する。
 * 5層アーキテクチャ L2。設計参照: docs/ARCHITECTURE.md
 *
 * 読み込み順 (優先度高い順):
 *   1. $WENTIAN_SYSTEM_POLICY 環境変数 (あれば最優先)
 *   2. cwd の AGENTS.md (存在すれば)
 *   3. cwd の SOUL.md (存在すれば)
 *   4. .wentian/memory/*.md をファイル名昇順で結合
 *   5. safeRuntimeContext (OS/arch/cwd/time)
 *   6. Goal context (L1) -- オプション
 *
 * 返り値の system message には metadata.immovable=true が付き、
 * agent-compactor.ts の compactConversation / pruneOldToolOutputs が
 * これらを除外して保持することを保証します。
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CompactorConversationMessage } from './agent-compactor.js';
import { safeRuntimeContext } from './agent-context.js';
import type { GoalStore } from './goal-store.js';

const MAX_PER_FILE_BYTES = 64 * 1024; // 64KiB を超えるmemory fileは先頭だけ採用
const MAX_TOTAL_BYTES = 256 * 1024; // 全memory合計の上限

export interface MemoryLayerInput {
  cwd: string;
  goal?: GoalStore;
  env?: NodeJS.ProcessEnv;
  /** テスト用: ファイル読込をスキップして input.overrideMessages だけ返す */
  overrideMessages?: CompactorConversationMessage[];
  /** テスト用: 時刻を固定 */
  now?: Date;
}

/** cwd からメモリ源 (AGENTS.md / SOUL.md / .wentian/memory/*.md) を非同期に読み、system message 配列を返します。 */
export async function buildMemoryLayer(input: MemoryLayerInput): Promise<CompactorConversationMessage[]> {
  if (input.overrideMessages) return input.overrideMessages;
  const env = input.env || process.env;
  const out: CompactorConversationMessage[] = [];
  const now = input.now || new Date();
  const sourceLabel: string[] = [];

  // 1. 環境変数 (最優先)
  if (env.WENTIAN_SYSTEM_POLICY) {
    out.push(makeSystem(`[環境変数 WENTIAN_SYSTEM_POLICY]\n${env.WENTIAN_SYSTEM_POLICY}`, 'memory-layer'));
    sourceLabel.push('env:WENTIAN_SYSTEM_POLICY');
  }

  // 2. AGENTS.md (cwd)
  const agentsContent = await tryReadFile(path.join(input.cwd, 'AGENTS.md'), MAX_PER_FILE_BYTES);
  if (agentsContent !== undefined) {
    out.push(makeSystem(`[AGENTS.md / プロジェクト運用ルール]\n${agentsContent}`, 'memory-layer'));
    sourceLabel.push('AGENTS.md');
  }

  // 3. SOUL.md
  const soulContent = await tryReadFile(path.join(input.cwd, 'SOUL.md'), MAX_PER_FILE_BYTES);
  if (soulContent !== undefined) {
    out.push(makeSystem(`[SOUL.md / プロジェクト理念・行動原則]\n${soulContent}`, 'memory-layer'));
    sourceLabel.push('SOUL.md');
  }

  // 4. .wentian/memory/*.md
  const memoryDir = path.join(input.cwd, '.wentian', 'memory');
  const memoryFiles = await tryReaddir(memoryDir);
  if (memoryFiles && memoryFiles.length > 0) {
    const sorted = memoryFiles.filter(name => name.endsWith('.md')).sort();
    const combined: string[] = [];
    let total = 0;
    for (const name of sorted) {
      const content = await tryReadFile(path.join(memoryDir, name), MAX_PER_FILE_BYTES);
      if (content === undefined) continue;
      const header = `### ${name}`;
      const block = `${header}\n${content}`;
      if (total + block.length > MAX_TOTAL_BYTES) {
        combined.push(`### ${name}\n[省略: 全体サイズ上限 ${MAX_TOTAL_BYTES} bytes 超過]`);
        break;
      }
      combined.push(block);
      total += block.length;
      sourceLabel.push(`.wentian/memory/${name}`);
    }
    if (combined.length > 0) {
      out.push(makeSystem(`[プロジェクトメモリ / .wentian/memory]\n${combined.join('\n\n')}`, 'memory-layer'));
    }
  }

  // 5. Runtime context (OS/arch/cwd/time) -- 秘密情報を含まない
  out.push(makeSystem(safeRuntimeContext(input.cwd), 'runtime'));

  // 6. Goal context (L1) -- あれば進捗要約を注入
  if (input.goal) {
    const progress = formatGoalSummary(input.goal, now);
    out.push(makeSystem(progress, 'goal-context'));
    sourceLabel.push('goal-context');
  }

  // メタ情報 (debug用、LLMに送らないsource label)
  if (out.length > 0) {
    out[0] = { ...out[0], content: prependSourceLabel(typeof out[0].content === 'string' ? out[0].content : '', sourceLabel) };
  }
  return out;
}

function makeSystem(content: string, source: 'memory-layer' | 'goal-context' | 'runtime'): CompactorConversationMessage {
  return { role: 'system', content, metadata: { immovable: true, source } };
}

function prependSourceLabel(content: string, labels: string[]): string {
  if (labels.length === 0) return content;
  return `[Memory Layer sources: ${labels.join(', ')}]\n\n${content}`;
}

async function tryReadFile(target: string, maxBytes: number): Promise<string | undefined> {
  try {
    const raw = await readFile(target, 'utf8');
    return raw.length > maxBytes ? `${raw.slice(0, maxBytes)}\n[... ${raw.length - maxBytes} 文字省略 ...]` : raw;
  } catch {
    return undefined;
  }
}

async function tryReaddir(target: string): Promise<string[] | undefined> {
  try { return await readdir(target); } catch { return undefined; }
}

function formatGoalSummary(goal: GoalStore, now: Date): string {
  const total = goal.todos.length;
  const done = goal.metrics.completedCount;
  const blocked = goal.metrics.blockedCount;
  const next = goal.todos.find(t => t.status === 'active') || goal.todos.find(t => t.status === 'pending');
  const nextLine = next ? `次に着手: [${next.id}] ${next.title}` : '次に着手: (なし — Plan作成が必要)';
  const todos = goal.todos.slice(0, 20).map(t =>
    `- [${t.id}] ${t.status.padEnd(7)} attempts=${t.attempts} ${t.title}` +
    (t.lastError ? ` (lastError: ${t.lastError.slice(0, 80)})` : ''),
  ).join('\n');
  return [
    `[Project Goal / ${goal.id}]`,
    `title: ${goal.title}`,
    `status: ${goal.status}  progress: ${done}/${total} (${total === 0 ? 0 : Math.round(done / total * 100)}%)  blocked: ${blocked}`,
    `consecutiveFailures: ${goal.metrics.consecutiveFailures}/${goal.stop.maxConsecutiveFailures}  totalAttempts: ${goal.metrics.totalAttempts}`,
    `context: ${goal.description.slice(0, 800)}`,
    `current_time: ${now.toISOString()}`,
    nextLine,
    '--- TODO一覧 (先頭20件) ---',
    todos || '(TODOなし)',
  ].join('\n');
}
