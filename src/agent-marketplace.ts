import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { loadAgentSelectionConfig } from './agent-selection.js';
import {agentSearchDirectories,agentRuntimeEnvironment} from './agent-runtime.js';

const execFileAsync = promisify(execFile);

export interface AgentCatalogDefinition {
  id: string; name: string; repository: string; cli: string;
  install?: { executable: string; arguments: string[]; method: 'npm' | 'winget' | 'uv' | 'github' };
  compatibility: 'windows' | 'wsl2';
  note: string;
}

export interface IntelligentAgentCandidate extends AgentCatalogDefinition {
  popularity?: number;
  popularitySource: 'github_stars' | 'unavailable';
  installed: boolean;
  version?: string;
  liveState: 'healthy' | 'not_installed' | 'probe_failed';
  checkedAt: string;
  latencyMs?: number;
  probeError?: string;
  installSupported: boolean;
}

export const AGENT_CATALOG: AgentCatalogDefinition[] = [
  { id:'lmstudio', name:'LM Studio', repository:'lmstudio-ai/lmstudio-js', cli:'lms', compatibility:'windows', note:'LM StudioのモデルとWentianのスキル・ツールで作業を実行' },
  { id: 'ollama', name: 'Ollama CLI', repository: 'ollama/ollama', cli: 'ollama', compatibility: 'windows', note: '直接CLIとWentianのスキル・ツールで作業を実行' },
  { id: 'opencode', name: 'OpenCode', repository: 'anomalyco/opencode', cli: 'opencode', install: { executable: 'npm.cmd', arguments: ['install', '-g', 'opencode-ai@latest'], method: 'npm' }, compatibility: 'windows', note: 'OpenAI互換Providerを利用可能' },
  { id: 'kilo', name: 'Kilo Code', repository: 'Kilo-Org/kilocode', cli: 'kilo', install: { executable: 'npm.cmd', arguments: ['install', '-g', '@kilocode/cli@latest'], method: 'npm' }, compatibility: 'windows', note: '利用時はモデルの明示を推奨' },
  { id: 'crush', name: 'Crush', repository: 'charmbracelet/crush', cli: 'crush', install: { executable: 'winget.exe', arguments: ['install', '--id', 'charmbracelet.crush', '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'], method: 'winget' }, compatibility: 'windows', note: 'Windows公式Wingetパッケージ' },
  { id: 'goose', name: 'goose', repository: 'aaif-goose/goose', cli: 'goose', install:{executable:'github-release',arguments:['aaif-goose/goose','goose-x86_64-pc-windows-msvc.zip'],method:'github'},compatibility: 'windows', note: '公式のWindows CLIをチェックサム検査後に導入' },
  { id: 'codex', name: 'OpenAI Codex CLI', repository: 'openai/codex', cli: 'codex', install: { executable: 'winget.exe', arguments: ['install', '--id', 'OpenAI.Codex', '--exact', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'], method: 'winget' }, compatibility: 'windows', note: 'OpenAI公式CLI' },
  { id: 'gemini', name: 'Gemini CLI', repository: 'google-gemini/gemini-cli', cli: 'gemini', install: { executable: 'npm.cmd', arguments: ['install', '-g', '@google/gemini-cli@latest'], method: 'npm' }, compatibility: 'windows', note: 'Google公式CLI' },
  { id: 'claude', name: 'Claude Code', repository: 'anthropics/claude-code', cli: 'claude', install: { executable: 'npm.cmd', arguments: ['install', '-g', '@anthropic-ai/claude-code@latest'], method: 'npm' }, compatibility: 'windows', note: 'Anthropic公式CLI' },
  { id: 'cline', name: 'Cline CLI', repository: 'cline/cline', cli: 'cline', install: { executable: 'npm.cmd', arguments: ['install', '-g', 'cline@latest'], method: 'npm' }, compatibility: 'windows', note: '導入後にProvider設定が必要' },
  { id: 'openclaw', name: 'OpenClaw', repository: 'openclaw/openclaw', cli: 'openclaw', install: { executable: 'npm.cmd', arguments: ['install', '-g', 'openclaw@latest'], method: 'npm' }, compatibility: 'windows', note: 'Windows対応。導入後にonboardが必要' },
  { id: 'aider', name: 'Aider', repository: 'Aider-AI/aider', cli: 'aider', install: { executable: 'uv.exe', arguments: ['tool', 'install', '--force', '--python', '3.12', '--with', 'pip', 'aider-chat@latest'], method: 'uv' }, compatibility: 'windows', note: 'uvの隔離環境へPython 3.12で導入' },
  { id: 'hermes', name: 'Hermes Agent', repository: 'NousResearch/hermes-agent', cli: 'hermes',install:{executable:'uv.exe',arguments:['tool','install','--python','3.13','hermes-agent'],method:'uv'},compatibility: 'windows', note: '公式PyPIパッケージをuvの隔離環境へ導入' },
  { id: 'continue', name: 'Continue', repository: 'continuedev/continue', cli: 'cn', compatibility: 'windows', note: 'IDE中心。CLI自動導入は対象外' },
];

let popularityCache: { at: number; values: Map<string, number> } | undefined;
let probeCache: { at: number; values: Map<string, Pick<IntelligentAgentCandidate, 'installed' | 'version' | 'liveState' | 'checkedAt' | 'latencyMs' | 'probeError'>> } | undefined;

/** `where.exe`がApp Execution Aliasや制限環境で失敗しても、PATHを直接検査できる候補を生成します。 */
export function agentExecutableCandidates(cli: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  // npmは同名のUnix用shimとWindows用.cmdを並べるため、Windowsでは実行可能な拡張子付きを優先します。
  const names = path.extname(cli) ? [cli] : process.platform === 'win32'
    ? [...extensions.map(extension => `${cli}${extension.toLowerCase()}`), cli]
    : [cli];
  return [...new Set(agentSearchDirectories(env).flatMap(directory => names.map(name => path.join(directory.replace(/^"|"$/g, ''), name))))];
}

/** Windowsの複数のコマンド解決方式を併用し、実行可能ファイルの絶対Pathを返します。 */
export async function resolveAgentExecutable(cli: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('where.exe', [cli], { timeout: 2000, windowsHide: true });
    const found = stdout.trim().split(/\r?\n/).find(candidate => /\.(?:exe|cmd|bat|com)$/i.test(candidate));
    if (found) return found;
  } catch { /* PATH直接検査へ継続します。 */ }
  for (const candidate of agentExecutableCandidates(cli)) {
    try { await access(candidate); return candidate; } catch { /* 次候補を確認します。 */ }
  }
  return undefined;
}

/** WindowsのBatch Shimを引用符文字列へ連結せず、cmd.exeのcallへ引数配列として渡します。 */
export function agentVersionCommand(resolvedExecutable: string, platform: NodeJS.Platform = process.platform, comSpec = process.env.ComSpec || 'cmd.exe'): { executable: string; args: string[] } {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(resolvedExecutable)) {
    return { executable: comSpec, args: ['/d', '/c', 'call', resolvedExecutable, '--version'] };
  }
  return { executable: resolvedExecutable, args: ['--version'] };
}

async function githubPopularity(): Promise<Map<string, number>> {
  if (popularityCache && Date.now() - popularityCache.at < 60 * 60 * 1000) return popularityCache.values;
  const values = new Map<string, number>();
  await Promise.all(AGENT_CATALOG.map(async item => {
    try {
      const response = await fetch(`https://api.github.com/repos/${item.repository}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'wentian-control-center' }, signal: AbortSignal.timeout(5000) });
      if (response.ok) values.set(item.id, Number((await response.json() as any).stargazers_count) || 0);
    } catch { /* ネットワーク障害時は人気度なしのまま安全に継続します。 */ }
  }));
  popularityCache = { at: Date.now(), values };
  return values;
}

export async function probeAgentCli(item: Pick<AgentCatalogDefinition, 'cli'>, signal?: AbortSignal): Promise<Pick<IntelligentAgentCandidate, 'installed' | 'version' | 'liveState' | 'checkedAt' | 'latencyMs' | 'probeError'>> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const resolvedExecutable = await resolveAgentExecutable(item.cli);
    if (!resolvedExecutable) return { installed: false, liveState: 'not_installed', checkedAt };
    try {
      // .cmd/.batをshell:trueや引用符付き文字列で起動せず、callと引数配列で安全に実行します。
      // これによりDEP0190警告、引用符の誤認、cmd.exeエラー由来の文字化け表示を同時に回避します。
      const command = agentVersionCommand(resolvedExecutable);
      signal?.throwIfAborted();
      const checking = execFileAsync(command.executable, command.args, { windowsHide: true, env:agentRuntimeEnvironment() });
      let stopping: Promise<unknown> | undefined;
      let timedOut = false;
      // Windowsのcmdラッパーだけを終了してCLI本体を残さないよう、子孫を含めて停止します。
      const abort = () => { stopping ||= import('./external-orchestrator.js').then(async ({terminateProcessTree}) => {
        if (checking.child.pid) await terminateProcessTree(checking.child.pid);
      }).catch(() => { checking.child.kill(); }); };
      // execFileのtimeoutはWindowsのcmdだけを停止して子を残すため、期限でも同じツリー停止を使います。
      const timer = setTimeout(() => { timedOut = true; abort(); }, loadAgentSelectionConfig().probeTimeoutMs);
      checking.child.stdin?.end();
      signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) abort();
      let version;
      try { version = await checking; }
      catch (error) { if (timedOut) throw new Error('CLIの生存確認が制限時間を超過しました。'); throw error; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await stopping; }
      signal?.throwIfAborted();
      if (timedOut) throw new Error('CLIの生存確認が制限時間を超過しました。');
      return { installed: true, version: `${version.stdout || version.stderr}`.trim().split(/\r?\n/)[0].slice(0, 160), liveState: 'healthy', checkedAt, latencyMs: Date.now() - startedAt };
    } catch (error: any) {
      return { installed: true, version: `${error?.stdout || error?.stderr || ''}`.trim().slice(0, 160) || undefined, liveState: 'probe_failed', checkedAt, latencyMs: Date.now() - startedAt, probeError: String(error?.message || error).slice(0, 500) };
    }
  } catch { return { installed: false, liveState: 'not_installed', checkedAt }; }
}

/** GitHub Star人気度で上位候補を自動登録し、ローカルCLIをリアルタイム検査します。 */
export async function discoverPopularAgents(limit = 100) {
  const popularity = await githubPopularity();
  if (!probeCache || Date.now() - probeCache.at >= 5000) {
    const entries = await Promise.all(AGENT_CATALOG.map(async item => [item.id, await probeAgentCli(item)] as const));
    probeCache = { at: Date.now(), values: new Map(entries) };
  }
  const candidates = AGENT_CATALOG.map(item => ({ ...item, popularity: popularity.get(item.id), popularitySource: popularity.has(item.id) ? 'github_stars' as const : 'unavailable' as const, ...probeCache!.values.get(item.id)!, installSupported: item.compatibility === 'windows' && Boolean(item.install) }))
    .sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1) || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 100)));
  return { generatedAt: new Date().toISOString(), popularityCacheAt: popularityCache ? new Date(popularityCache.at).toISOString() : undefined, candidates };
}

type Approval = { agentId: string; expiresAt: number };
const approvals = new Map<string, Approval>();

export function installPlan(agentId: string) {
  const item = AGENT_CATALOG.find(candidate => candidate.id === agentId);
  if (!item) throw new Error('登録されていない外部エージェントです。');
  if (!item.install || item.compatibility !== 'windows') throw new Error('この端末での自動インストールには対応していません。');
  return { agentId: item.id, name: item.name, method: item.install.method, executable: item.install.executable, arguments: item.install.arguments, requiresFeatureFlag: true, requiresAdminAuthentication: true, changesLocalMachine: true };
}

export function issueInstallApproval(agentId: string): string {
  installPlan(agentId);
  const token = randomBytes(24).toString('base64url');
  approvals.set(token, { agentId, expiresAt: Date.now() + 60_000 });
  return token;
}

export async function executeApprovedInstall(agentId: string, token: string): Promise<{ installed: boolean; output: string }> {
  const approval = approvals.get(token);
  approvals.delete(token);
  if (!approval || approval.agentId !== agentId || approval.expiresAt < Date.now()) throw new Error('承認トークンが無効または期限切れです。');
  installPlan(agentId);
  await (await import('./agent-install-maintenance.js')).installCatalogAgent(agentId);
  probeCache = undefined;
  const probe=await probeAgentCli(AGENT_CATALOG.find(agent=>agent.id===agentId)!);
  if(probe.liveState!=='healthy')throw new Error(probe.probeError||'導入後のCLI起動確認に失敗しました。');
  return { installed: true, output: '公式パッケージの導入・CLI起動確認に成功しました。' };
}
