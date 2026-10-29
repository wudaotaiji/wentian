import { cliText } from './cli-language.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { renameWithRetry } from './atomic-file.js';
import path from 'node:path';
import { redactTrainingText } from './training-data.js';

export interface SessionMessage { role: 'user' | 'assistant'; content: string; }
export interface SessionTokenUsage { input: number; cachedInput: number; output: number; reasoning: number; total: number; costUsd?: number; estimated?: boolean; }
export interface AgentSession {
  version: '1.0'; id: string; createdAt: string; updatedAt: string;
  workspace: string; model: string; messages: SessionMessage[];
  title?: string; usage?: SessionTokenUsage;
}

/** ProviderごとのOpenAI互換Usageを、セッション全体のToken使用量へ安全に加算します。 */
export function addTokenUsage(current: SessionTokenUsage, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, any>;
  const input = Number(value.prompt_tokens ?? value.input_tokens ?? 0);
  const output = Number(value.completion_tokens ?? value.output_tokens ?? 0);
  const cached = Number(value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens ?? 0);
  const reasoning = Number(value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens ?? 0);
  current.input += Number.isFinite(input) ? input : 0;
  current.output += Number.isFinite(output) ? output : 0;
  current.cachedInput += Number.isFinite(cached) ? cached : 0;
  current.reasoning += Number.isFinite(reasoning) ? reasoning : 0;
  const suppliedTotal = Number(value.total_tokens);
  current.total += Number.isFinite(suppliedTotal) ? suppliedTotal : (Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0);
}

/** 終了時に、使用量と再開方法をCodex CLIに近い読みやすい形式で表示します。 */
export function formatSessionExit(session: AgentSession): string {
  const usage = session.usage ?? { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 };
  const number = (value: number) => value.toLocaleString('en-US');
  const title = session.title?.trim() || cliText('このセッション');
  return [
    '─'.repeat(80),
    `Token usage${usage.estimated ? ' (estimated)' : ''}: total=${number(usage.total)} input=${number(usage.input)} (+ ${number(usage.cachedInput)} cached) output=${number(usage.output)} (reasoning ${number(usage.reasoning)})`,
    cliText('このセッションを再開するには、次を実行してください:'),
    `  wentian resume ${session.id}`,
    cliText('または wentian resume を実行し、{0} を選択してください。',title),
  ].join('\n');
}

function sessionsRoot(): string {
  return process.env.WENTIAN_SESSION_PATH || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'sessions');
}

function sessionPath(id: string): string {
  if (!/^wt-\d{8}-\d{6}-[a-f0-9]{8}$/.test(id)) throw new Error(`不正なSession IDです: ${id}`);
  return path.join(sessionsRoot(), `${id}.json`);
}

/** 並行終了でも壊れたJSONを残さないよう、一時ファイルから原子的に置換します。 */
async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, target);
}

/** 日時で追跡でき、推測困難な末尾を持つSession IDを発行します。 */
export function createSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `wt-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export async function createAgentSession(workspace: string, model: string): Promise<AgentSession> {
  const now = new Date().toISOString();
  const session: AgentSession = { version: '1.0', id: createSessionId(), createdAt: now, updatedAt: now, workspace, model, messages: [], usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 } };
  await saveAgentSession(session);
  return session;
}

/** Tool出力・画像Data URL・System Promptを除外し、会話本文だけを伏字化して保存します。 */
export async function saveAgentSession(session: AgentSession, sourceMessages?: Array<{ role: string; content?: unknown }>): Promise<void> {
  // タイトルも会話本文と同じ伏字化規則を通し、秘密値が一覧表示へ漏れないようにします。
  if (session.title) session.title = redactTrainingText(session.title).slice(0, 60);
  if (sourceMessages) session.messages = sourceMessages.flatMap(message => {
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') return [];
    return [{ role: message.role, content: redactTrainingText(message.content) } as SessionMessage];
  }).slice(-200);
  session.updatedAt = new Date().toISOString();
  await atomicWrite(sessionPath(session.id), `${JSON.stringify(session, null, 2)}\n`);
}

export async function loadAgentSession(id: string): Promise<AgentSession> {
  const value = JSON.parse(await readFile(sessionPath(id), 'utf8')) as AgentSession;
  if (value.version !== '1.0' || value.id !== id || !Array.isArray(value.messages)) throw new Error(`Sessionファイルが不正です: ${id}`);
  return value;
}

export async function listAgentSessions(): Promise<AgentSession[]> {
  let names: string[] = []; try { names = await readdir(sessionsRoot()); } catch { return []; }
  const loaded = await Promise.all(names.filter(name => /^wt-.*\.json$/.test(name)).map(async name => {
    try { return await loadAgentSession(name.slice(0, -5)); } catch { return undefined; }
  }));
  return loaded.filter((item): item is AgentSession => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
