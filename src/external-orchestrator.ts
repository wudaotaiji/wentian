import { fileURLToPath, pathToFileURL } from 'node:url';
import { independentVerifier } from './model-diversity.js';
import { readModelPreferences } from './agent-model-selection.js';
import { ExecutionBudget, parseExecutionLimits, type ExecutionLimits } from './execution-budget.js';
import { execFile } from 'node:child_process';
import { agentNotExcluded } from './agent-exclusion-policy.js';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentPlan, PlannerCapability } from './agent-planner.js';
import { loadExternalAgentSnapshot, type ExternalAgentStatus } from './external-agents.js';
import { probeAgentCli } from './agent-marketplace.js';
import { readyAgentsOrFallback } from './external-agent-readiness.js';
import { captureArtifactSnapshot, compareArtifactSnapshots, type ArtifactEvidence } from './artifact-evidence.js';
import { createTaskWorkspace, publishTaskWorkspace, type PublishResult, type TaskWorkspace } from './task-workspace.js';
import { beginGovernedExecution, ExecutionDenied, createProjectExecutionScope } from './execution-governance.js';
import { MAINTENANCE_EXECUTION } from './maintenance-execution.js';
import { loadAcceptancePlan, verifyAcceptance, type AcceptancePlan, type AcceptanceResult } from './acceptance-verification.js';
import { loadAgentSelectionConfig } from './agent-selection.js';
import { performanceScore, recordAgentPerformance } from './agent-performance.js';
import { createAIRepairPlan, type RepairAction, type RepairFailureKind, type RepairPlan, type RepairPlannerInput } from './agent-repair-planner.js';
import { getActivePluginKernel } from './plugin-runtime.js';
import { REPAIR_PLANNER_SERVICE } from './plugin-services.js';
import { resolveTaskTarget } from './task-target.js';
import { managedConnection, connectionAllowsExecution, connectionPolicy, readAgentConnections, isFreeAgentModel, type AgentConnection } from './agent-connection-policy.js';
import { normalizeWritePaths } from './execution-policy.js';
import { orchestrationOutcome } from './task-outcome.js';
import { WORK_VERIFICATION_PROBE, workAllowsExecution } from './agent-work-policy.js';
import {prepareGooseCodexBridge} from './goose-codex-bridge.js';
import {validateGroundedFallbackAnswer,type AnswerEvidence,type WebAnswerEvidence} from './grounded-fallback-answer.js';

export interface OrchestrationTask {
  responseContract?:'grounded_answer';evidenceSource?:AgentPlan['evidenceSource'];answerResearch?:AgentPlan['answerResearch'];
  version: '1.0'; taskId: string; objective: string; workspace: string;
  requiredCapabilities: PlannerCapability[]; requestedAgents: string[]; parallel: boolean;
  allowedWritePaths: string[]; forbiddenOperations: string[]; stopConditions: string[];
  acceptanceCriteria: string[]; reportPath: string;
}

export interface OrchestrationResult {
  taskId: string; status: 'planned' | 'completed' | 'needs_review' | 'blocked' | 'failed' | 'fallback';
  selectedAgents: string[]; manifestPath: string; reports: Array<{ role: 'builder' | 'tester' | 'verifier' | 'reviewer'; agent: string; model?: string; success: boolean; provisional?: boolean; output: string; answerEvidence?:AnswerEvidence[]; webAnswerEvidence?:WebAnswerEvidence[]; attempts?: number; failureKind?: ExternalAgentFailureKind; repairs?: string[]; repairPlans?: RepairPlan[]; termination?: ProcessTerminationResult }>;
  note?: string;
  interruption?: 'timeout' | 'cancelled';
  evidence?: ArtifactEvidence;
  workspace?: TaskWorkspace;
  acceptance?: AcceptanceResult;
  acceptancePlan?: AcceptancePlan;
  publication?: PublishResult;
}

export type ExternalAgentFailureKind = RepairFailureKind;

/** CLI出力を修復方針へ変換し、認証や未導入など自動変更してはいけない失敗も区別します。 */
export function classifyExternalAgentFailure(output: string): ExternalAgentFailureKind {
  const value = output.toLowerCase();
  // Command引数内のSafety文言より、実際のRuntime診断を優先して誤分類を防ぎます。
  if (/cannot find module|module not found|missing dependency|failed to resolve import|err_module_not_found/.test(value)) return 'runtime_dependency';
  if (/forbidden operation|禁止操作|successfully installed|package installation/.test(value)) return 'forbidden_operation';
  if (/tool_call_not_applied|<tool_call>|<\/tool_call>/.test(value)) return 'tool_not_applied';
  // Terminal内の「見つからない」等を優先せず、CLI自身の承認拒否を先に分類します。
  if (/permission requested|auto-reject|rejected permission|access denied|権限/.test(value)) return 'permission';
  if (/not recognized|command not found|enoent|not_installed|見つかりません/.test(value)) return 'not_installed';
  if (/unauthorized|authentication|invalid api.?key|\b401\b|ログイン|認証/.test(value)) return 'authentication';
  if (/permission/.test(value)) return 'permission';
  if (/\b429\b|rate.?limit|quota|利用制限|上限/.test(value)) return 'rate_limit';
  if (/model not found|unknown model|invalid model|モデル.*(?:不明|存在し)/.test(value)) return 'model';
  if (/service unavailable|unexpected server error|server_error|upstream error|no available llm|利用可能な\s*llmモデル/.test(value)) return 'provider';
  if (/idle timeout|無活動timeout|meaningful output/.test(value)) return 'stalled';
  if (/timeout|timed out|時間超過/.test(value)) return 'timeout';
  return 'unknown';
}

/** 安全に自動変更できる一時障害だけを、回数制限付き修復の対象にします。 */
export function isRepairableExternalFailure(kind: ExternalAgentFailureKind): boolean {
  return ['permission', 'provider', 'model', 'rate_limit', 'timeout', 'runtime_dependency'].includes(kind);
}

/** CLI起動時の定型警告を作業進捗と誤認せず、無活動監視を正しく継続します。 */
export function isMeaningfulExternalProgress(output: string): boolean {
  const value = safeProgressLine(output);
  return Boolean(value) && !/(?:warning:\s*no stdin data received|proceeding without it|redirect stdin explicitly)/i.test(value);
}

/** 外部AgentのStreaming出力から、明示禁止した環境変更の開始・完了を検知します。 */
export function detectsForbiddenExternalOperation(output: string): boolean {
  return /(?:^|[>›→⚙$]\s*)(?:python\s+-m\s+pip|pip|npm|pnpm|yarn|bun|uv)\s+(?:install|add)\b|successfully installed\b|\b(?:winget|choco)\s+install\b|\bgit\s+(?:commit|push|reset|checkout)\b/i.test(output);
}

/** 外部Packageを変更せずに役割を引き継ぐ、ロード済みのWentian組み込み資源です。 */
export const INTERNAL_RESOURCE_HANDOFF = 'core.runner.external-agent-handoff';

/** CLIが安全に解析できるJSONで、工程の担当と状態を通知します。 */
function workflowTodo(emit: ((text: string) => void) | undefined, agent: string, label: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', detail = ''): void {
  emit?.(`• Workflow todo\n  └ ${JSON.stringify({ agent, label, status, detail })}`);
}

export interface ProcessTerminationResult {
  pid: number;
  platform: NodeJS.Platform;
  requestedAt: string;
  completedAt: string;
  attempts: number;
  verifiedStopped: boolean;
  detail: string;
}

/** 実測した失敗理由から、次候補への引継ぎメッセージを一貫した形式で作ります。 */
export function formatAgentHandoff(previousAgent: string, nextAgent: string, role: string, output: string): string {
  const limited = /(?:429|rate.?limit|quota|利用制限|上限)/i.test(output);
  return `• Agent handoff\n  └ ${previousAgent}が${limited ? '利用制限' : '失敗'}で停止したため、${nextAgent}が${role}を引き継ぎます。`;
}

/** 終了コード・応答の有無は受入検証ではないため、制作タスクは必ず検収待ちへ渡します。 */
export function classifyOrchestrationOutcome(staged: boolean, reports: OrchestrationResult['reports']): OrchestrationResult['status'] {
  if (!staged) return reports.some(report => report.success) ? 'completed' : 'failed';
  const roles = new Set(reports.filter(report => report.success).map(report => report.role));
  return ['builder', 'tester', 'verifier'].every(role => roles.has(role as any)) ? 'needs_review' : 'failed';
}

/** CLIが文章として返したProvider障害を、正常な回答として誤採用しないよう判定します。 */
export function isSuccessfulExternalOutput(output: string): boolean {
  const normalized = output.trim();
  if (!normalized) return false;
  const sample = normalized.slice(0, 8000);
  return !/(?:ERROR\s+Service Unavailable|Service Unavailable|Unexpected server error|Model not found|No payment method|\b401\s+Unauthorized|invalid api.?key|permission requested|auto-reject|利用可能な\s*LLMモデルがありません|No available LLM models?|tool_call_not_applied|<\/?(?:Bash|tool_call)\b|await(?:ing)? your (?:choice|response)|which (?:platform|engine|framework)|選んでください|選択してください)/i.test(sample);
}

/** 制作Pipelineでは「応答が来た」と「役割を完了した」を分離して判定します。 */
export function validateRoleCompletion(role: 'builder' | 'tester' | 'verifier' | 'reviewer', output: string, changedFiles = 0): { success: boolean; reason?: string } {
  if (!isSuccessfulExternalOutput(output)) return { success: false, reason: '未実行Tool、質問返し、または既知エラーを検出しました。' };
  if (role === 'reviewer') return { success: true };
  const marker = output.match(/WENTIAN_ROLE_RESULT\s*:\s*(PASS|FAIL)/i)?.[1]?.toUpperCase();
  if (marker !== 'PASS') return { success: false, reason: marker === 'FAIL' ? 'Agentが役割不合格を報告しました。' : '役割完了Markerがありません。' };
  if (role === 'builder' && changedFiles < 1) return { success: false, reason: 'Builder実行中の実ファイル差分が0件です。' };
  return { success: true };
}

/** 停止確認済みBuilderの部分成果を、後続の独立検証へ回収できる条件だけを許可します。 */
export function canSalvageBuilderFailure(role: string, kind: ExternalAgentFailureKind, changedFiles: number, termination?: ProcessTerminationResult): boolean {
  return role === 'builder' && ['timeout', 'stalled'].includes(kind) && changedFiles > 0 && termination?.verifiedStopped === true;
}

/** 内部思考ではなく、利用者が検証できるTask分解・依存関係・担当候補だけを表示します。 */
export function formatTaskOrchestration(task: OrchestrationTask, selected: ExternalAgentStatus[]): string {
  if(!task.requiredCapabilities.includes('file_write'))return[
    '## Read-only investigation',task.evidenceSource==='web'?`- 情報源: Web資料${task.answerResearch?'（取得済み・出典と取得時刻を引継ぎ）':'（未取得）'}`:`- Target: ${task.workspace}`,'- 目的: 現在の依頼への調査・説明',
    '- 成果物: 根拠・確認範囲・未確認事項を示した回答',`- 調査候補: ${selected.map(agent=>agent.id).join(' → ')||'なし'}`,
    '- 制約: 読み取り専用。変更・公開・秘密取得は禁止',
    '### Investigation Todos',task.evidenceSource==='web'?'[ ] 依頼の時点・場所と取得資料を確認':'[ ] 作業場所と依頼を確認','[ ] 必要な資料を調査','[ ] 根拠と未確認範囲を検証して回答',
  ].join('\n');
  const capabilities = capabilitiesByAgent();
  const builders = selected.filter(agent => capabilities[agent.id]?.includes('file_write')).map(agent => agent.id);
  const reviewers = selected.filter(agent => !builders.includes(agent.id)).map(agent => agent.id);
  const validationCandidates = [...reviewers, ...builders];
  return [
    '## Task breakdown / orchestration',
    `- 目的: ${task.objective}`,
    `- Target: ${task.workspace}`,
    `- 成果物: ${task.requiredCapabilities.includes('file_write') ? '実ファイル変更と検証記録' : '読み取り専用レポート'}`,
    `- 制約: ${task.forbiddenOperations.join('、')}`,
    `- 合格条件: ${task.requiredCapabilities.includes('file_write') ? 'Builder成功 → Tester成功 → Verifier成功 → 競合検査 → Target反映' : '根拠付き回答'}`,
    `- Builder候補: ${builders.join(' → ') || 'なし'}`,
    `- Tester / Verifier候補: ${validationCandidates.join(' → ') || 'なし'}（Builder担当は最後のFallback）`,
    '',
    '### Execution Todos',
    `[•] Wentian · Target確認とSnapshot作成  target=${task.workspace}`,
    '[ ] Wentian · 隔離Staging Workspace準備',
    `[ ] Builder · 実装（失敗時は次候補へ引継ぎ）  candidates=${builders.join(' → ') || 'なし'}`,
    `[ ] Tester · 読取り専用検証  candidates=${validationCandidates.join(' → ') || 'なし'}`,
    `[ ] Verifier · 最終検収  candidates=${validationCandidates.join(' → ') || 'なし'}`,
    '[ ] Wentian · 競合検査とTarget反映',
    '[ ] Wentian · Manifestと最終結果出力',
  ].join('\n');
}

class ExternalCommandStoppedError extends Error {
  constructor(message: string, readonly termination: ProcessTerminationResult) { super(message); this.name = 'ExternalCommandStoppedError'; }
}

/** 外部Agentが無言でも稼働状況を判断できる、一定形式のHeartbeatを作成します。 */
export function formatExternalAgentHeartbeat(state: { role: string; agent: string; pid?: number; startedAt: number; lastOutputAt: number; receivedBytes: number }): string {
  const elapsed = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const silent = Math.max(0, Math.floor((Date.now() - state.lastOutputAt) / 1000));
  return `• Working ${state.role} (${elapsed}s • esc to interrupt)\n  └ agent=${state.agent}, pid=${state.pid || 'pending'}, last-output=${silent}s ago, received=${state.receivedBytes} bytes`;
}

function safeProgressLine(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 500);
}

const capabilitiesByAgent = (): Record<string, PlannerCapability[]> => loadAgentSelectionConfig().agentCapabilities;
/** 組み込みランナーを持ち、Health確認後に自動選択できる外部Agentです。 */
export const automaticRunnerAgents = new Set(Object.keys(loadAgentSelectionConfig().agentCapabilities));

/** Health、鮮度、応答時間、直近失敗を数値化し、固定順序なしで候補を比較します。 */
export function scoreExternalAgent(agent: ExternalAgentStatus, task = 'review', now = Date.now()): number {
  const performance = performanceScore(agent.id, task, now);
  if (performance === Number.NEGATIVE_INFINITY) return performance;
  let score = agent.state === 'available' ? 1_000 : 0;
  if (agent.liveState === 'healthy') score += 500;
  if (agent.freshWithin24Hours) score += 200;
  score -= Math.min(agent.latencyMs ?? 10_000, 60_000) / 100;
  return performance * 100 + score;
}

/** Planner計画を、外部プロセスへ渡せる制限付きTask Schemaへ変換します。 */
export function createOrchestrationTask(plan: AgentPlan, workspace = process.cwd()): OrchestrationTask {
  if (!plan.delegation.enabled) throw new Error('外部エージェント委譲が明示されていません。');
  // Fallbackのobjectiveには過去の会話が含まれるため、作業先は今回の依頼だけから決めます。
  const targetInput = (plan.delegation.objective || '').startsWith('[Wentian LLM fallback]')
    ? plan.text : (plan.delegation.objective || plan.text);
  const target = resolveTaskTarget(targetInput, workspace, plan.targetPath);
  const root = target.workspace;
  const taskId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const reportPath = path.join(root, '.wentian', 'orchestration', 'runs', taskId);
  return {
    version: '1.0', taskId, objective: plan.delegation.objective || plan.text, workspace: root,responseContract:plan.responseContract,evidenceSource:plan.evidenceSource,answerResearch:plan.answerResearch,
    requiredCapabilities: plan.requiredCapabilities, requestedAgents: plan.delegation.requestedAgents,
    parallel: plan.delegation.parallel, allowedWritePaths: normalizeWritePaths(root, plan.allowedWritePaths ?? []),
    forbiddenOperations: ['delete', 'drop', 'git state change', 'external state change', 'secret extraction'],
    stopConditions: ['Builder 180秒／検証90秒Timeout', '権限不足', '破壊操作が必要', '同一エラー再発'],
    acceptanceCriteria: ['読み取り専用の根拠を提示', '実行コマンドを完全な形で記録', '推測を事実として報告しない'],
    reportPath,
  };
}

/** Health状態、明示指定、能力を使い、最大数を抑えて実行候補を選択します。 */
export function selectExternalAgents(task: OrchestrationTask, agents: ExternalAgentStatus[], verification = false): ExternalAgentStatus[] {
  const requested = new Set(task.requestedAgents.map(value => value.toLowerCase()));
  const taskKind = task.requiredCapabilities.includes('file_write') ? 'coding' : task.requiredCapabilities.includes('web') ? 'web' : 'review';
  const capabilities = capabilitiesByAgent();
  const eligible = agents.filter(agent => automaticRunnerAgents.has(agent.id) && agent.state === 'available' && connectionAllowsExecution(agent) && (!requested.size || requested.has(agent.id)) && (requested.has(agent.id) || scoreExternalAgent(agent, taskKind) !== Number.NEGATIVE_INFINITY) && task.requiredCapabilities.every(capability => (capabilities[agent.id] || ['text']).includes(capability)) && (verification || (!task.requiredCapabilities.includes('file_read') && !task.requiredCapabilities.includes('file_write')) || workAllowsExecution(agent, task.requiredCapabilities.includes('file_write') ? 'coding' : 'reading')));
  // 明示指定時は指定順を尊重し、自動選択時は実測スコアで最大候補数まで選びます。
  const sorted = eligible.sort((left, right) => requested.size ? task.requestedAgents.indexOf(left.id) - task.requestedAgents.indexOf(right.id) : compareAgentPriority(left.id,right.id) || scoreExternalAgent(right, taskKind) - scoreExternalAgent(left, taskKind));
  return sorted.slice(0, loadAgentSelectionConfig().maxCandidates);
}

/** 制作タスクでは書込み可能なBuilderを先頭に確保し、別AgentのTester・Verifier候補を性能順で続けます。 */
export function selectStagedExternalAgents(task: OrchestrationTask, agents: ExternalAgentStatus[], verification = false): ExternalAgentStatus[] {
  const requested = new Set(task.requestedAgents.map(value => value.toLowerCase()));
  const capabilities = capabilitiesByAgent();
  const eligible = agents.filter(agent => automaticRunnerAgents.has(agent.id) && agent.state === 'available' && connectionAllowsExecution(agent) && agent.liveState === 'healthy'
    && (!requested.size || requested.has(agent.id)));
  const builders = eligible.filter(agent => (verification || scoreExternalAgent(agent, 'coding') !== Number.NEGATIVE_INFINITY) && (verification || workAllowsExecution(agent, 'coding')) && capabilities[agent.id]?.includes('file_write') && buildExternalAgentCommand(agent.id, task.objective, task.workspace, 'builder', { attempt: 0 }, agent.connection))
    .sort((left, right) => requested.size ? task.requestedAgents.indexOf(left.id) - task.requestedAgents.indexOf(right.id) : compareAgentPriority(left.id,right.id) || scoreExternalAgent(right, 'coding') - scoreExternalAgent(left, 'coding'));
  if (!builders.length) return [];
  const reviewers = eligible.filter(agent => !builders.some(builder => builder.id === agent.id))
    .sort((left, right) => requested.size ? task.requestedAgents.indexOf(left.id) - task.requestedAgents.indexOf(right.id) : compareAgentPriority(left.id,right.id) || scoreExternalAgent(right, 'review') - scoreExternalAgent(left, 'review'));
  // Builder障害時にも別の書込み可能Agentへ引き継げるよう、Builder候補とReviewer候補を別枠で保持します。
  const limit = loadAgentSelectionConfig().maxCandidates;
  return [...builders.slice(0, limit), ...reviewers.slice(0, Math.max(2, limit))];
}

function candidateExternalAgents(task: OrchestrationTask, agents: ExternalAgentStatus[]): ExternalAgentStatus[] {
  const requested = new Set(task.requestedAgents.map(value => value.toLowerCase()));
  // 過去のnot_installedは負のキャッシュにすぎないため、選択不能時の軽量再プローブ候補から除外しません。
  const capabilities = capabilitiesByAgent();
  return agents.filter(agent => (!requested.size || requested.has(agent.id)) && task.requiredCapabilities.every(capability => (capabilities[agent.id] || ['text']).includes(capability))).sort((left, right) => requested.size ? task.requestedAgents.indexOf(left.id) - task.requestedAgents.indexOf(right.id) : compareAgentPriority(left.id,right.id)).slice(0, loadAgentSelectionConfig().maxCandidates);
}

/** Windowsのnpm Shimを介さず、導入済みパッケージの実体をNode.jsで安全に起動します。 */
function npmPackageEntry(packageName: string, relativeEntry: string): string | undefined {
  const npmRoot = process.env.npm_config_prefix || (process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : undefined);
  const entry = npmRoot ? path.join(npmRoot, 'node_modules', ...packageName.split('/'), ...relativeEntry.split('/')) : undefined;
  return entry && existsSync(entry) ? entry : undefined;
}

/** OpenCodeがAI修復で選択できるモデルを管理者設定のAllowlistとして返します。 */
export function opencodeFallbackModels(): string[] {
  const managed = managedConnection('opencode');
  if (managed) return managed.mode !== 'local' ? [managed.model] : [];
  if (connectionPolicy().enabled && readAgentConnections().opencode) return [];
  return (process.env.WENTIAN_OPENCODE_FALLBACK_MODELS || 'opencode/nemotron-3.5-lightning-free,wentian/wentian-auto/remote,opencode/deepseek-v4-flash-free').split(',').map(value => value.trim()).filter(Boolean);
}

/** Agentごとの差異を吸収し、非対話実行用の完全なコマンド定義を返します。 */
export interface ExternalAgentCommand {executable:string;args:string[];connection?:AgentConnection;gooseCodex?:{model:string;role:'builder'|'tester'|'verifier'|'reviewer'}}
export function buildExternalAgentCommand(...args:Parameters<typeof buildExternalAgentCommandInner>):ExternalAgentCommand|undefined {
  const command=buildExternalAgentCommandInner(...args);
  const connection=args[5]===undefined?managedConnection(args[0]):args[5]||undefined;
  return command?{...command,connection}:undefined;
}
function buildExternalAgentCommandInner(agent: string, objective: string, workspace: string, role: 'builder' | 'tester' | 'verifier' | 'reviewer', repair: { attempt: number; failureKind?: ExternalAgentFailureKind; action?: RepairAction; model?: string } = { attempt: 0 }, connection: AgentConnection | null | undefined = undefined, trustedAcceptance?: AcceptancePlan,responseContract?:'grounded_answer'): ExternalAgentCommand | undefined {
  // 保守検証は明示された候補、通常実行は実応答確認済みの候補を使用します。
  const managed = connection === undefined ? managedConnection(agent) : connection || undefined;
  // 選択後に接続記録が失効した場合も、古い既定モデルへ戻して実行しません。
  if (connection === undefined && connectionPolicy().enabled && readAgentConnections()[agent] && !managed) return undefined;
  if (agent === 'ollama' || agent === 'lmstudio') {
    if (!managed?.model || managed.mode !== 'native') return undefined;
    if (agent === 'ollama' && objective.startsWith('[Wentian LLM fallback]')) return { executable: 'ollama', args: ['run', managed.model, objective, '--hidethinking', '--nowordwrap'] };
    const runner = fileURLToPath(new URL('./hosted-model-agent.ts', import.meta.url));
    const loader = pathToFileURL(fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))).href;
    return { executable: agentNodeExecutable(), args: ['--import', loader, runner, agent, managed.model, objective.startsWith('[Wentian LLM fallback]') ? 'conversation' : role, objective, trustedAcceptance ? Buffer.from(JSON.stringify(trustedAcceptance)).toString('base64') : '', managed.baseUrl||readModelPreferences()[agent]?.baseUrl || (agent==='lmstudio'?process.env.LMSTUDIO_BASE_URL:process.env.OLLAMA_HOST) || ''] };
  }
  const writable = role === 'builder';
  const llmFallback = objective.startsWith('[Wentian LLM fallback]');
  const roleDirective = writable
    ? '目的の成果物を実装してください。追加質問で停止せず合理的な既定を選び、この作業場所内で実ファイルを作成・編集してください。Package導入やダウンロードは禁止です。導入済み資源または依存不要のHTML・CSS・JavaScriptなどを優先してください。'
    : '目的に記載された成果物は既にBuilderがこの作業場所へ作成済みです。あなたは新規制作やTarget Pathへの移動をせず、現在の作業場所にある成果物だけを読み取り、非破壊的な検査を実際に実行して合否判定してください。';
  // npmの.cmd Shimは改行などのcmd.exe特殊文字を拒否するため、安全な単一行引数へ正規化します。
  const safety = llmFallback&&responseContract!=='grounded_answer'
    ? `役割: 会話回答。呼出し元のJSON出力仕様・操作制約を厳守してください。今回の処理でツールが禁止されている場合は調査せず、調査が必要な依頼を構造化された作業計画として返してください。作業実績・変更内容の調査が許可されている場合も読み取り専用です。未確認範囲を明記し、秘密情報取得は禁止です。依頼: ${objective.replace(/^\[Wentian LLM fallback\]\s*/, '')}`.replace(/[\r\n]+/g, ' ')
    : llmFallback
    ? `役割: 読み取り専用の調査・回答。現在の作業場所は ${workspace} です。ホストが確定したこの場所を使い、同じ場所を利用者へ再質問しないでください。現在の依頼と参考履歴は別です。依頼へ直接、必要な根拠と詳細を含めて回答してください。現在のプロジェクトでの作業実績・変更内容など、ワークスペースの事実を尋ねる依頼では、指定された作業場所内に限り読み取り専用でGitの履歴・状態と関連資料を実際に調査してください。参考履歴だけを根拠に現在のファイルが調査不能と判断しないでください。参照できない他アプリの記録を推測しないでください。作業場所外の読取り、書込み、状態変更、秘密情報取得は禁止です。調査根拠と未確認範囲を分けて回答してください。依頼: ${objective.replace(/^\[Wentian LLM fallback\]\s*/, '')}`.replace(/[\r\n]+/g, ' ')
    : `役割: ${role}。目的: ${objective}。実際の作業場所: ${workspace}。${roleDirective} 依頼文に別のTarget Pathが含まれていても直接操作せず、すべての読取り・書込み・コマンドをこの作業場所内だけで行ってください。Targetへの反映はWentianが検証後に担当します。${writable ? 'この作業場所内だけで必要なファイル作成・編集を許可します。' : '読み取り専用です。ファイルを変更せず、Tool呼出し文字列を出すだけではなく実際に検査してください。'} 禁止: 削除、Git状態変更、作業場所外への書込み、外部システム変更、秘密情報取得。停止条件: 禁止操作が必要、権限不足、Timeout。実行コマンドと根拠を省略せず報告し、最終行を成功時は WENTIAN_ROLE_RESULT: PASS、不合格・未完了時は WENTIAN_ROLE_RESULT: FAIL としてください。`.replace(/[\r\n]+/g, ' ');
  if (agent === 'goose') {
    const cliProvider=managed?.mode==='native'&&managed.provider==='codex';
    return { executable: 'goose', args: ['run', '--no-session', '--no-profile', ...(!llmFallback&&!cliProvider ? ['--with-builtin', 'developer'] : []), '--quiet', '--max-turns', llmFallback ? '1' : '20', ...(managed ? [...(managed.mode==='native'?(managed.provider?['--provider',managed.provider]:[]):['--provider',managed.provider||'wentian-local']), '--model', managed.model] : []), '--text', safety],...(cliProvider?{gooseCodex:{model:managed.model,role:llmFallback?'reviewer':role}}:{}) };
  }
  if (agent === 'codex') {
    const entry=npmPackageEntry('@openai/codex','bin/codex.js');
    const args=['--no-daemon','--ask-for-approval','never','exec','--skip-git-repo-check','--ephemeral','--sandbox',llmFallback||role!=='builder'?'read-only':'workspace-write','--cd',workspace,'--json',...(managed?['--model',managed.model,...(managed.provider?['--config',`model_provider=${JSON.stringify(managed.provider)}`]:[])]:[]),safety];
    return entry?{executable:agentNodeExecutable(),args:[entry,...args]}:{executable:'codex',args};
  }
  if (agent === 'crush') {
    const entry = npmPackageEntry('@charmland/crush', 'run-crush.js');
    const args = ['run', '--quiet', ...(managed ? ['--model', managed.mode !== 'local' ? managed.model : `wentian-local/${managed.model}`, '--small-model', managed.mode !== 'local' ? managed.model : `wentian-local/${managed.model}`] : []), safety];
    return entry ? { executable: agentNodeExecutable(), args: [entry, ...args] } : { executable: 'crush', args };
  }
  if (agent === 'kilo') {
    const entry = npmPackageEntry('@kilocode/cli', 'bin/kilo');
    const args = ['run', '--model', managed ? (managed.mode !== 'local' ? managed.model : `wentian-local/${managed.model}`) : process.env.WENTIAN_KILO_MODEL || 'kilo/kilo-auto/free', '--dir', workspace, ...(repair.action === 'enable_workspace_auto_approval' ? ['--auto'] : []), safety];
    return entry && existsSync(entry) ? { executable: agentNodeExecutable(), args: [entry, ...args] } : { executable: 'kilo', args };
  }
  if (agent === 'opencode') {
    const executable = npmPackageEntry('opencode-ai', `bin/${process.platform === 'win32' ? 'opencode.exe' : 'opencode'}`);
    // Buildの既定をNemotronへ固定し、古いグローバル設定やタイトル生成用の補助モデルと混同しません。
    const primary = managed ? (managed.mode !== 'local' ? managed.model : `wentian-local/${managed.model}`) : process.env.WENTIAN_OPENCODE_MODEL || 'opencode/nemotron-3-ultra-free';
    const fallbacks = opencodeFallbackModels();
    const model = repair.action === 'switch_model' && repair.model && fallbacks.includes(repair.model) && (!managed || isFreeAgentModel(agent, repair.model)) ? repair.model : primary;
    const args = ['run', '--dir', workspace, '--model', model, '--title', `wentian-${Date.now()}`, ...(repair.action === 'enable_workspace_auto_approval' ? ['--auto'] : []), safety];
    return { executable: executable && existsSync(executable) ? executable : 'opencode', args };
  }
  if (agent === 'hermes') {
    const project = process.env.WENTIAN_HERMES_PROJECT;
    const toolsets = llmFallback ? 'clarify' : 'file,terminal,web';
    return { executable: project ? 'uv' : 'hermes', args: [...(project ? ['run', '--project', project, '--python', '3.11', 'hermes'] : []), 'chat', '--yolo', '--quiet', '--max-turns', '90', '--toolsets', toolsets, ...(managed ? [...(managed.mode==='native'?(managed.provider?['--provider',managed.provider]:[]):['--provider','wentian-internal']), '--model', managed.model] : []), '--query', safety] };
  }
  if (agent === 'claude') {
    const executable = npmPackageEntry('@anthropic-ai/claude-code', 'bin/claude.exe') || 'claude';
    const args = ['-p', safety, '--permission-mode', 'bypassPermissions', '--input-format', 'text', '--output-format', 'text'];
    if (managed || process.env.WENTIAN_CLAUDE_MODEL) args.push('--model', managed?.model || process.env.WENTIAN_CLAUDE_MODEL!);
    if (managed) args.push('--effort', 'medium');
    return { executable, args };
  }
  if (agent === 'openclaw') {
    const entry = npmPackageEntry('openclaw', 'openclaw.mjs');
    const executable = entry ? agentNodeExecutable() : 'openclaw';
    const args = [...(entry ? [entry] : []), 'agent', '--local', '--session-id', randomUUID(), '--json','--thinking','off','--timeout','120','--model', managed ? managed.mode==='native'?managed.model:`wentian-local/${managed.model}` : process.env.WENTIAN_OPENCLAW_MODEL || 'local-model', '--message', safety];
    return { executable, args,connection:managed };
  }
  if (agent === 'cline') {
    // Clineはtool_callが適用されない環境があるため、書込み担当にはせずレビュー用途だけで起動します。
    if (role === 'builder') return undefined;
    const executable = npmPackageEntry('cline/node_modules/@cline/cli-windows-x64', 'bin/cline.exe');
    const entry = npmPackageEntry('cline', 'bin/cline');
    const args = ['--cwd', workspace, '--timeout', '90', ...(managed ? ['--provider', managed.mode !== 'local' ? 'cline' : 'openai', '--model', managed.model, '--thinking', managed.mode==='local'?'none':'medium'] : []), safety];
    return executable ? { executable, args } : entry ? { executable: agentNodeExecutable(), args: [entry, ...args] } : { executable: 'cline', args };
  }
  return undefined;
}

/** 外部コマンドを起動し、終了コードと標準出力を待ちます。 */
function execFileAndWait(executable: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(executable, args, { cwd, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    child.once('error', error => resolve({ code: 1, stdout: '', stderr: error.message }));
  });
}

/** PIDがまだ存在するかを、OSのプロセス一覧で確認します。 */
async function processExists(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    const result = await execFileAndWait('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return result.code === 0 && new RegExp(`"${pid}"(?:,|$)`).test(result.stdout);
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * TimeoutまたはEsc時にプロセスツリーを終了し、停止確認が終わるまで戻りません。
 * Windowsではtaskkillの/Tで子孫を対象にし、終了後にPIDを再確認します。
 */
export async function terminateProcessTree(pid: number): Promise<ProcessTerminationResult> {
  const requestedAt = new Date().toISOString();
  let attempts = 0;
  let detail = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attempts = attempt;
    if (process.platform === 'win32') {
      const result = await execFileAndWait('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
      detail = `taskkill exit=${result.code}${result.stderr.trim() ? `: ${result.stderr.trim().slice(0, 300)}` : ''}`;
    } else {
      try { process.kill(-pid, attempt === 1 ? 'SIGTERM' : 'SIGKILL'); detail = `process groupへ${attempt === 1 ? 'SIGTERM' : 'SIGKILL'}を送信`; }
      catch { try { process.kill(pid, attempt === 1 ? 'SIGTERM' : 'SIGKILL'); } catch { /* 既に停止済みです。 */ } }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!(await processExists(pid))) return { pid, platform: process.platform, requestedAt, completedAt: new Date().toISOString(), attempts, verifiedStopped: true, detail };
  }
  return { pid, platform: process.platform, requestedAt, completedAt: new Date().toISOString(), attempts, verifiedStopped: false, detail: `${detail}; 2回の終了処理後もPIDが残存しています。` };
}

/** TimeoutやEsc時に、停止確認を完了してから呼出し元へ失敗を返します。 */
const runningAgentCommands = new Map<string, number>();
/** 本作業中のエージェントの接続設定を、保守側で書き換えないための実行状態です。 */
export function isAgentExecuting(agent: string): boolean { return (runningAgentCommands.get(agent) || 0) > 0; }
/** OpenClawの安定したJSON封筒から、モデルの回答本文だけを取り出します。 */
export function openClawResponseText(output:string):string{
  const candidates=[output.trim(),...output.split(/\r?\n/).map((line,index,lines)=>line.trim().startsWith('{')?lines.slice(index).join('\n').trim():'').filter(Boolean)];
  for(const candidate of candidates){try{const value=JSON.parse(candidate);if(value.ok===false||value.status==='error'||value.error)return output;const payloads=value.payloads||value.result?.payloads||value.output?.payloads;if(Array.isArray(payloads)){const text=payloads.filter(item=>typeof item.text==='string').map(item=>item.text).join('\n');if(text)return text;}if(value.ok===true&&typeof value.final==='string'&&value.final)return value.final;if(typeof value.text==='string')return value.text;}catch{/* ログ行を除いた次の候補を調べます。 */}}
  return output;
}

/** CodexのJSONイベントから最終回答だけを取り出し、指示やコマンドのエコーを合格にしません。 */
export function codexResponseText(output:string):string {
  const messages:string[]=[];
  for(const line of output.split(/\r?\n/)){
    let event:any;try{event=JSON.parse(line);}catch{continue;}
    if(event.type==='error'||event.type==='turn.failed')throw Object.assign(new Error('Codexの実応答に失敗しました。'),{diagnostic:output});
    if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string')messages.push(event.item.text);
  }
  if(!messages.length)throw new Error('Codexの最終回答を確認できませんでした。');
  // 進捗のagent_messageと最終回答を混ぜず、最後の回答だけを利用者・構造化検証へ渡します。
  return messages.at(-1)!;
}
/** 設定生成だけを分離し、接続先選択を実CLIなしで検証できるようにします。 */
export async function prepareExternalRuntime(command:ExternalAgentCommand,options:{cwd:string;agent:string;role:string}):Promise<void> {
    if(options.agent==='openclaw'){
      // 会話ではツールを無効にし、制作では必要なローカルツールだけを持つ専用設定を使います。
      // 既存のメッセージ配送・プラグイン・履歴・認証設定を、この単発実行へ持ち込みません。
      const target=path.join(options.cwd,'.wentian/openclaw-runtime.json');
      if(path.resolve(target)!==path.resolve(options.cwd,'.wentian/openclaw-runtime.json'))throw new Error('OpenClaw設定の保存先が実行領域外です。');
      const model=command.args[command.args.indexOf('--model')+1].replace(/^wentian-local\//,'');
      const conversation=options.role==='connection-probe'||options.role==='group-conversation'||command.args.at(-1)?.includes('役割: 会話回答');
      const selection=command.connection||readAgentConnections()[options.agent||'openclaw']||readModelPreferences()[options.agent || 'openclaw'];
      const config={models:{providers:{'wentian-local':{baseUrl:selection?.baseUrl || connectionPolicy().localBaseUrl,api:'openai-completions',apiKey:selection?.source==='wentian'?(process.env.WENTIAN_API_KEY||'dummy'):'dummy',models:[{id:model,name:model,contextWindow:16384,maxTokens:conversation?1024:2048,reasoning:false,input:['text']}]}}},agents:{defaults:{workspace:options.cwd,skipBootstrap:true,experimental:{localModelLean:true},model:{primary:'wentian-local/'+model},bootstrapMaxChars:1000,bootstrapTotalMaxChars:2000}},plugins:{enabled:false},tools:conversation?{deny:['*']}:{allow:(options.role==='builder'||options.role==='work-standalone')?['read','write','edit','exec']:['read','exec']}};
      if(selection?.mode==='native'){
        // 既存のプロバイダー設定だけを隔離実行へ引き継ぎ、古いagents.listや配送設定は持ち込みません。
        const home=process.env.USERPROFILE||os.homedir();
        const source=process.env.OPENCLAW_CONFIG_PATH||path.join(home,'.openclaw/openclaw.json');
        const native=JSON.parse(await readFile(source,'utf8'));
        let providers=native.models?.providers;
        if(!providers){const agentModels=JSON.parse(await readFile(path.join(home,'.openclaw/agents/main/agent/models.json'),'utf8'));providers=agentModels.providers;}
        if(!providers||!Object.keys(providers).length)throw new Error('OpenClawのネイティブプロバイダー設定を確認できません。');
        config.models.providers=providers;
        config.agents.defaults.model.primary=command.args[command.args.indexOf('--model')+1];
      }
      await mkdir(path.dirname(target),{recursive:true});await writeFile(target,JSON.stringify(config));
      const state=path.join(options.cwd,'.wentian/openclaw-state');
      if(path.resolve(state)!==path.resolve(options.cwd,'.wentian/openclaw-state'))throw new Error('OpenClaw状態の保存先が実行領域外です。');
      await mkdir(state,{recursive:true});
    }
}
export function runExternalCommand(command: ExternalAgentCommand, options: { maintenance?: boolean; maintenanceToken?:typeof MAINTENANCE_EXECUTION; projectScope?:object; cwd: string; timeoutMs: number; idleTimeoutMs?: number; input?: string; signal?: AbortSignal; role: string; agent: string; emit?: (text: string) => void }): Promise<string> {
  runningAgentCommands.set(options.agent, (runningAgentCommands.get(options.agent) || 0) + 1);
  let governance: Awaited<ReturnType<typeof beginGovernedExecution>> | undefined;
  let succeeded = false;
  return (async()=>{
    // 設定ファイルの生成やCLI起動より前に、全共通経路で許可を検証します。
    governance = await beginGovernedExecution({ ...command, connection: command.connection || readAgentConnections()[options.agent] }, options);
    options = { ...options, signal: governance.signal };
    options.signal?.throwIfAborted();
    await prepareExternalRuntime(command,options);
    const executable=await resolveAgentExecutable(command.executable);
    if(command.gooseCodex&&options.agent==='goose'){
      const selection=command.gooseCodex;
      // Gooseが渡す子引数の代わりに既存のCodexランナーの制約を使います。認証は元の設定を参照します。
      const child=buildExternalAgentCommand('codex','',options.cwd,selection.role,{attempt:0},{mode:'native',model:selection.model,status:'pending',checkedAt:'',expiresAt:'',fingerprint:'',policyHash:''})!;
      child.args[child.args.length-1]='-';
      child.executable=await resolveAgentExecutable(child.executable)||child.executable;
      const bridge=await prepareGooseCodexBridge(child);
      try{const output=await executeExternalCommand({...command,executable:executable||command.executable},{...options,env:bridge.env});succeeded=true;return output;}
      finally{await bridge.cleanup()}
    }
    // OpenClawの正式な環境変数で隔離設定と状態を指定し、未対応CLI引数を渡しません。
    const runtimeOptions=options.agent==='openclaw'?{...options,env:{OPENCLAW_CONFIG_PATH:path.join(options.cwd,'.wentian/openclaw-runtime.json'),OPENCLAW_STATE_DIR:path.join(options.cwd,'.wentian/openclaw-state')}}:options;
    const output=await executeExternalCommand({...command,executable:executable||command.executable}, runtimeOptions);
    const result=options.agent==='codex'&&command.args.includes('--json')?codexResponseText(output):options.agent==='openclaw'&&command.args.includes('--json')?openClawResponseText(output):output;
    succeeded=true;return result;
  })().finally(async () => {
    const remaining = (runningAgentCommands.get(options.agent) || 1) - 1;
    if (remaining) runningAgentCommands.set(options.agent, remaining); else runningAgentCommands.delete(options.agent);
    await governance?.complete(succeeded);
  });
}
function executeExternalCommand(command: { executable: string; args: string[] }, options: { maintenance?: boolean; cwd: string; timeoutMs: number; idleTimeoutMs?: number; input?: string; signal?: AbortSignal; role: string; agent: string; emit?: (text: string) => void;env?:NodeJS.ProcessEnv }): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopping = false;
    const startedAt = Date.now(); let lastOutputAt = startedAt; let receivedBytes = 0; let pendingLine = ''; let lastEmittedAt = 0; let outputTail = '';
    const child = execFile(command.executable, command.args, { cwd: options.cwd, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      // 接続検査だけは短い出力予算を使い、通常の制作・会話には適用しません。
      env: { ...agentRuntimeEnvironment(), WENTIAN_INSTALL_ROOT: process.env.WENTIAN_INSTALL_ROOT || process.cwd(), ...(options.agent === 'goose' && (options.role === 'connection-probe'||options.role.startsWith('work-')||options.role==='tester'||options.role==='verifier') ? {GOOSE_MAX_TOKENS:'1024', GOOSE_THINKING_EFFORT:'off'} : {}),...options.env, WENTIAN_MAINTENANCE_LOADED_ONLY: options.maintenance ? 'true' : 'false', NO_PROXY: `${process.env.NO_PROXY || ''},127.0.0.1,localhost,::1`, PYTHONIOENCODING: 'utf-8', PIP_REQUIRE_VIRTUALENV: '1', PIP_NO_INDEX: '1', UV_OFFLINE: '1', npm_config_offline: 'true' } }, (error, stdout, stderr) => {
      if (stopping) return;
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(idleTimer); clearInterval(heartbeat); options.signal?.removeEventListener('abort', abort);
      if (error) {
        // Node.jsのError.messageだけではCLIのProvider・権限エラー本文が欠落するため、標準出力と標準エラーも分類処理へ渡します。
        const detail = [error.message, String(stdout || '').trim(), String(stderr || '').trim()].filter(Boolean).join('\n').slice(-20_000);
        reject(Object.assign(new Error(detail), { diagnostic: `${stdout || ''}\n${stderr || ''}` }));
      } else resolve(`${stdout || stderr}`.trim());
    });
    const onOutput = (chunk: Buffer | string) => {
      const text = String(chunk); receivedBytes += Buffer.byteLength(text); pendingLine += text;
      // 時間超過でも直前のCLI診断を保持し、保存側で秘密値を除去できるようにします。
      outputTail = (outputTail + text).slice(-20_000);
      const lines = pendingLine.split(/\r?\n/); pendingLine = lines.pop() || '';
      const latest = [...lines].reverse().map(safeProgressLine).find(Boolean);
      if (latest && detectsForbiddenExternalOperation(latest)) { void stop(`禁止操作をStreaming出力で検出しました: ${latest}`); return; }
      if (latest && isMeaningfulExternalProgress(latest)) { lastOutputAt = Date.now(); scheduleIdleTimeout(); }
      // 高頻度出力でTUIを埋めないよう、Agent出力イベントは最大1秒に1回へ抑制します。
      if (latest && Date.now() - lastEmittedAt >= 1_000) { lastEmittedAt = Date.now(); options.emit?.(`• External output\n  └ agent=${options.agent}: ${latest}`); }
    };
    child.stdout?.on('data', onOutput); child.stderr?.on('data', onOutput);
    // 非対話RunnerへEOFを即時通知し、Claude等が標準入力待ちのまま停止することを防ぎます。
    child.stdin?.on('error', () => { /* 起動失敗時のEPIPEはプロセス結果で扱います。 */ });
    child.stdin?.end(options.input);
    // 無出力は障害の証明ではありません。指定がない限り全体期限だけで停止します。
    const idleTimeoutMs = options.idleTimeoutMs ?? options.timeoutMs;
    let idleTimer: NodeJS.Timeout;
    const scheduleIdleTimeout = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { void stop(`外部Agentが${idleTimeoutMs / 1000}秒間、意味のある出力を返さず無活動Timeoutになりました。`); }, idleTimeoutMs);
      idleTimer.unref();
    };
    options.emit?.(`• External process started\n  └ agent=${options.agent}, role=${options.role}, pid=${child.pid || 'pending'}, timeout=${options.timeoutMs / 1000}s, idle-timeout=${idleTimeoutMs / 1000}s`);
    const heartbeat = setInterval(() => options.emit?.(formatExternalAgentHeartbeat({ role: options.role, agent: options.agent, pid: child.pid, startedAt, lastOutputAt, receivedBytes })), 5_000);
    heartbeat.unref();
    const stop = async (message: string) => {
      if (settled || stopping) return;
      stopping = true; clearTimeout(timer); clearTimeout(idleTimer); clearInterval(heartbeat); options.signal?.removeEventListener('abort', abort);
      const termination = child.pid
        ? await terminateProcessTree(child.pid)
        : { pid: 0, platform: process.platform, requestedAt: new Date().toISOString(), completedAt: new Date().toISOString(), attempts: 1, verifiedStopped: child.kill(), detail: 'PID未取得のためChildProcess.killを実行' };
      settled = true;
      reject(Object.assign(new ExternalCommandStoppedError(`${message} プロセス停止確認=${termination.verifiedStopped ? '成功' : '失敗'} (PID=${termination.pid})`, termination), {diagnostic:outputTail}));
    };
    const abort = () => { void stop(options.signal?.reason instanceof Error ? options.signal.reason.message : '外部Agentを中断しました。'); };
    const timer = setTimeout(() => { void stop(`外部Agentが${options.timeoutMs / 1000}秒でTimeoutしました。`); }, options.timeoutMs);
    scheduleIdleTimeout();
    options.signal?.addEventListener('abort', abort, { once: true });
  });
}

async function saveManifest(task: OrchestrationTask, result: Omit<OrchestrationResult, 'manifestPath'>): Promise<string> {
  await mkdir(task.reportPath, { recursive: true });
  const manifestPath = path.join(task.reportPath, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify({ task, result: { ...result, outcome: orchestrationOutcome({ ...result, manifestPath }) }, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return manifestPath;
}

/** 外部Agentの選択・実行・Manifest記録を一つの安全境界で行います。 */
export async function orchestrateExternalTask(plan: AgentPlan, options: { workspace?: string; enabled?: boolean; signal?: AbortSignal; emit?: (text: string) => void; workVerification?: symbol; limits?: Partial<ExecutionLimits> } = {}, dependencies: Partial<{
  loadSnapshot: typeof loadExternalAgentSnapshot;
  readyAgents: typeof readyAgentsOrFallback;
  runCommand: typeof runExternalCommand;
  repairPlanner: typeof createAIRepairPlan;
}> = {}): Promise<OrchestrationResult> {
  // 接続・実行境界を差し替え可能にし、外部CLIを起動せず通常経路を結合テストできます。
  // Repair ProviderはPlugin Overlayで差し替え可能です。Runtime未初期化時は互換用の組み込み実装へ戻します。
  const pluginRepairPlanner = getActivePluginKernel()?.optional(REPAIR_PLANNER_SERVICE) || createAIRepairPlan;
  const runtime = { loadSnapshot: loadExternalAgentSnapshot, readyAgents: readyAgentsOrFallback, runCommand: runExternalCommand, repairPlanner: pluginRepairPlanner, ...dependencies };
  const task = createOrchestrationTask(plan, options.workspace);
  const budget=new ExecutionBudget(parseExecutionLimits(options.limits));
  if(options.limits?.maxTokens!==undefined||options.limits?.maxCostUsd!==undefined){const partial={taskId:task.taskId,status:'blocked' as const,selectedAgents:[],reports:[],note:'この外部CLI（External CLI）は内部使用量を強制計測できないため、指定されたトークン・費用上限を保証できません。Gateway経由の直接実行を使用してください。'};return{...partial,manifestPath:await saveManifest(task,partial)}}
  const deadline=AbortSignal.timeout(budget.limits.maxRuntimeMs);const executionSignal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
  const verification = options.workVerification === WORK_VERIFICATION_PROBE;
  // 対応済みの外部CLIにはファイル単位の強制制限がないため、起動前に拒否します。
  if (task.requiredCapabilities.includes('file_write') && !task.allowedWritePaths.includes('.')) {
    const partial = { taskId: task.taskId, status: 'blocked' as const, selectedAgents: [], reports: [], note: 'この外部ランナーでは限定書き込み範囲を強制できません。直接実行モード（direct）を使用してください。外部CLIは起動していません。' };
    return { ...partial, manifestPath: await saveManifest(task, partial) };
  }
  // 毎回全CLIを起動せず、まず24時間Health Check Cacheだけで候補を絞ります。
  const snapshot = await runtime.loadSnapshot({ probeLive: false });
  const preparedAgents = await runtime.readyAgents();
  snapshot.agents = preparedAgents;
  const staged = task.requiredCapabilities.includes('file_write');
  let selected = staged
    ? selectStagedExternalAgents(task, snapshot.agents, verification)
    : selectExternalAgents(task, snapshot.agents, verification);
  const candidates = staged
    ? snapshot.agents.filter(agent => automaticRunnerAgents.has(agent.id) && (!task.requestedAgents.length || task.requestedAgents.includes(agent.id))).slice(0, Math.max(3, loadAgentSelectionConfig().maxCandidates))
    : candidateExternalAgents(task, snapshot.agents).filter(agent => automaticRunnerAgents.has(agent.id));
  const permittedCandidates = candidates.filter(agent => agentNotExcluded(agent) && (verification || (!task.requiredCapabilities.includes('file_read') && !staged) || workAllowsExecution(agent, staged ? 'coding' : 'reading')));
  // 実行時だけ、Freshな候補がない場合に対象候補へ限定した軽量CLI確認を行います。
  if (!staged && !selected.length && options.enabled) {
    const probed = await Promise.all(permittedCandidates.map(async agent => ({ agent, probe: await probeAgentCli({ cli: agent.cli || agent.id }) })));
    selected = selectExternalAgents(task, probed.filter(item => item.probe.liveState === 'healthy').map(item => ({ ...item.agent, state: 'available' as const, liveState: 'healthy' as const, version: item.probe.version, lastObservedAt: item.probe.checkedAt, latencyMs: item.probe.latencyMs })), verification);
  }
  if (!staged && !selected.length && !options.enabled) selected = candidates;
  if (staged && !selected.length && options.enabled) {
    const probed = await Promise.all(permittedCandidates.map(async agent => ({ agent, probe: await probeAgentCli({ cli: agent.cli || agent.id }) })));
    selected = selectStagedExternalAgents(task, probed.filter(item => item.probe.liveState === 'healthy').map(item => ({ ...item.agent, state: 'available' as const, liveState: 'healthy' as const, version: item.probe.version, lastObservedAt: item.probe.checkedAt, latencyMs: item.probe.latencyMs })), verification);
  } else if (staged && !options.enabled) selected = candidates;
  const selectedAgents = selected.map(agent => agent.id);
  options.emit?.(`• Task orchestration\n${formatTaskOrchestration(task, selected)}`);
  workflowTodo(options.emit, 'wentian', staged?'Target確認とSnapshot作成':'調査・回答の準備', staged?'in_progress':'completed', `target=${task.workspace}`);
  if (!selected.length) {
    workflowTodo(options.emit, 'wentian', staged?'Target確認とSnapshot作成':'調査・回答の準備', 'failed', '実行可能なAgent候補なし');
    // 候補自体がいない場合と、接続確認済みでも作業能力検証が未合格で起動を許可しない場合を、台帳で分けます。
    const unverifiedCandidates = candidates.filter(agent => !verification && !workAllowsExecution(agent, staged ? 'coding' : 'reading')).map(agent => agent.id);
    const note = candidates.length && unverifiedCandidates.length === candidates.length
      ? `候補Agent（${unverifiedCandidates.join(', ')}）は接続確認済みでも、この用途の作業能力検証が未合格・失効のため起動を許可しませんでした。能力検証の再試行待ちまたは利用者対応待ちです（wentian agents で状態確認）。`
      : '必要能力を満たす利用可能な外部エージェントがありません。';
    const partial = { taskId: task.taskId, status: staged ? 'blocked' as const : 'fallback' as const, selectedAgents, reports: [], note };
    return { ...partial, manifestPath: await saveManifest(task, partial) };
  }
  if (!options.enabled) {
    workflowTodo(options.emit, 'wentian', 'Target確認とSnapshot作成', 'completed', `target=${task.workspace}`);
    const partial = { taskId: task.taskId, status: 'planned' as const, selectedAgents, reports: [], note: 'WENTIAN_ENABLE_EXTERNAL_ORCHESTRATIONが無効のため計画だけを記録しました。' };
    return { ...partial, manifestPath: await saveManifest(task, partial) };
  }
  let builderModel:string|undefined;
  let projectScope:object|undefined;
  const execute = async (agent: ExternalAgentStatus, role: 'builder' | 'tester' | 'verifier' | 'reviewer',remainingCandidates=0): Promise<OrchestrationResult['reports'][number]> => {
    const performanceTask = role === 'builder' ? 'coding' : role === 'tester' ? 'testing' : role === 'verifier' ? 'verification' : 'review';
    options.emit?.(`• Delegated ${role}\n  └ agent=${agent.id}`);
    const roleLabel = role === 'builder' ? 'Builder実装' : role === 'tester' ? 'Tester読取り専用検証' : role === 'verifier' ? 'Verifier最終検収' : 'レビュー';
    workflowTodo(options.emit, agent.id, roleLabel, 'in_progress', `role=${role}, workspace=${task.workspace}`);
    const repairs: string[] = [];
    const repairPlans: RepairPlan[] = [];
    const config = loadAgentSelectionConfig();
    let previousFailure: ExternalAgentFailureKind | undefined;
    let consecutiveSameFailure = 0;
    let lastFailureKind: ExternalAgentFailureKind | undefined;
    let repairPlan: RepairPlan | undefined;
    let lastReport: OrchestrationResult['reports'][number] | undefined;
    let answerFeedback:string|undefined;
    if (!verification && !workAllowsExecution(agent, role === 'builder' ? 'coding' : role === 'tester' ? 'testing' : role === 'verifier' ? 'verification' : 'reading') && (role !== 'reviewer' || task.requiredCapabilities.includes('file_read'))) return { role, agent: agent.id, success: false, output: 'この用途の作業能力検証が未合格または失効しています。', attempts: 0, failureKind: 'permission' };
    for (let attempt = 0; attempt <= (verification ? 0 : config.maxRepairAttempts); attempt += 1) {
      const startedAt = Date.now();
      if (!agentNotExcluded(agent)) return { role, agent: agent.id, success: false, output: '管理者により使用禁止に設定されています。' };
      const actualModel=repairPlan?.model??agent.connection?.model;
      // 単一エージェントの能力試験（Capability Probe）は固定ホスト検査を通し、出荷用の独立検証とは区別します。
      if(role==='verifier'&&!verification&&!independentVerifier(builderModel,actualModel,config.modelFamilies))return{role,agent:agent.id,success:false,output:'実装担当と異なるモデル（Model Diversity）を確認できないため検証を停止しました。',failureKind:'permission'};
      const objective=answerFeedback?`${task.objective}\n\nホストによる回答検証で不合格になりました: ${answerFeedback}。元の依頼へ回答し、指定された構造と実ファイルの引用を再確認してJSONだけを返してください。実行権限や設定は変更しないでください。`:task.objective;
      const command = buildExternalAgentCommand(agent.id, objective, task.workspace, role, { attempt, failureKind: previousFailure, action: repairPlan?.action, model: repairPlan?.model }, agent.connection, acceptancePlan,task.responseContract);
      if (!command) return { role, agent: agent.id, success: false, output: 'このAgentの自動Runnerは未対応です。', attempts: attempt + 1, failureKind: 'not_installed', repairs };
      const roleBefore = role === 'reviewer' ? undefined : await captureArtifactSnapshot(task.workspace);
      try {
        // 修復後も元Taskと同じ実行時間を保証し、短いHealth Probe用Timeoutで本作業を切断しません。
        budget.reserve(0,0);const timeoutMs = Math.min(config.roleTimeoutMs[role],budget.remainingMs());
        let output = await runtime.runCommand(command, { cwd: task.workspace, timeoutMs, signal: executionSignal, role, agent: agent.id, emit: options.emit, projectScope });
        // 構造化回答を途中で切ると、正常なJSONと引用を破壊するため先に検収します。
        if(task.responseContract!=='grounded_answer')output=output.slice(-20_000);
        let answerEvidence:AnswerEvidence[]|undefined;
        let webAnswerEvidence:WebAnswerEvidence[]|undefined;
        if(role==='reviewer'&&task.responseContract==='grounded_answer'){
          try{const checked=await validateGroundedFallbackAnswer(output,task.workspace,task.evidenceSource==='workspace',{required:task.evidenceSource==='web',research:task.answerResearch});output=checked.answer;answerEvidence=checked.evidence;webAnswerEvidence=checked.webEvidence;}
          catch(error){throw Object.assign(new Error(String((error as Error).message)),{answerValidation:true});}
        }
        const changedFiles = roleBefore ? compareArtifactSnapshots(roleBefore, await captureArtifactSnapshot(task.workspace)).changes.length : 0;
        const completion = validateRoleCompletion(role, output, changedFiles);
        const success = completion.success && !(agent.id === 'cline' && classifyExternalAgentFailure(output) === 'tool_not_applied');
        const failureKind = success ? undefined : classifyExternalAgentFailure(output);
        const verifiedOutput = completion.reason ? `${output || '出力なし'}\nWentian検証: ${completion.reason}` : output;
        lastReport = { role, agent: agent.id, model: actualModel, success, output: verifiedOutput || '出力がないため役割完了を確認できません。', attempts: attempt + 1, ...(answerEvidence?{answerEvidence}:{}), ...(webAnswerEvidence?.length?{webAnswerEvidence}:{}), ...(failureKind ? { failureKind } : {}), repairs: [...repairs], repairPlans: [...repairPlans] };
        await recordAgentPerformance({ agent: agent.id, task: performanceTask, success, latencyMs: Date.now() - startedAt, output: lastReport.output, ...(success ? {} : { error: `${failureKind}: ${lastReport.output}` }) });
        if (success) {
          workflowTodo(options.emit, agent.id, roleLabel, 'completed', `role=${role}, attempts=${attempt + 1}`);
          options.emit?.(`• ${role} 応答受信（内容は未検証）\n  └ agent=${agent.id}, attempts=${attempt + 1}`);
          return lastReport;
        }
        previousFailure = failureKind;
      } catch (error) {
        const termination = error instanceof ExternalCommandStoppedError ? error.termination : undefined;
        const output = error instanceof Error ? error.message : String(error);
        const failureKind = error instanceof ExecutionDenied ? 'permission' : classifyExternalAgentFailure((error as { diagnostic?: string })?.diagnostic || output);
        const changedFiles = roleBefore ? compareArtifactSnapshots(roleBefore, await captureArtifactSnapshot(task.workspace)).changes.length : 0;
        if (canSalvageBuilderFailure(role, failureKind, changedFiles, termination)) {
          const salvagedOutput = `${output}\nWentian検証: Builder停止前の実ファイル差分${changedFiles}件を暫定回収しました。Tester・Verifier合格までTargetへ反映しません。`;
          lastReport = { role, agent: agent.id, model: actualModel, success: false, provisional: true, output: salvagedOutput, attempts: attempt + 1, failureKind, repairs: [...repairs], repairPlans: [...repairPlans], termination };
          await recordAgentPerformance({ agent: agent.id, task: performanceTask, success: false, latencyMs: Date.now() - startedAt, output: salvagedOutput, error: `${failureKind}: 暫定回収・検証待ち` });
          workflowTodo(options.emit, agent.id, roleLabel, 'pending', `provisional=true, changes=${changedFiles}, verification=pending`);
          options.emit?.(`• Builder artifact salvaged\n  └ agent=${agent.id}, changes=${changedFiles}, process=stopped, verification=pending`);
          return lastReport;
        }
        lastReport = { role, agent: agent.id, model: actualModel, success: false, output, attempts: attempt + 1, failureKind, repairs: [...repairs], repairPlans: [...repairPlans], ...(termination ? { termination } : {}) };
        if (!(error instanceof ExecutionDenied)) await recordAgentPerformance({ agent: agent.id, task: performanceTask, success: false, latencyMs: Date.now() - startedAt, output, error: `${failureKind}: ${output}` });
        if (termination) options.emit?.(`• Process tree termination\n  └ pid=${termination.pid}, attempts=${termination.attempts}, verified=${termination.verifiedStopped ? 'stopped' : 'still-running'}`);
        // 中断、停止確認失敗、認証エラー、未導入、Cline未適用は自動変更せず次Agentへ引き継ぎます。
        if (error instanceof ExecutionDenied || options.signal?.aborted || termination?.verifiedStopped === false) return lastReport;
        if((error as {answerValidation?:boolean}).answerValidation&&attempt===0&&attempt<config.maxRepairAttempts&&budget.limits.maxAttempts-budget.attempts>remainingCandidates){
          // 形式・引用の検証理由をAIへ返します。意味や引用をホストの定型処理で補完しません。
          answerFeedback=output;options.emit?.(`• 回答の根拠を再検証\n  └ agent=${agent.id}: ${output}`);continue;
        }
        previousFailure = failureKind;
      }
      consecutiveSameFailure = previousFailure === lastFailureKind ? consecutiveSameFailure + 1 : 1;
      lastFailureKind = previousFailure;
      if (verification || !previousFailure || !isRepairableExternalFailure(previousFailure) || attempt >= config.maxRepairAttempts || consecutiveSameFailure >= 2) break;
      const plannerInput: RepairPlannerInput = {
        agent: agent.id, role, failureKind: previousFailure, failureSummary: lastReport?.output || '', attempt: attempt + 1,
        isolatedWorkspace: Boolean(workspace && path.resolve(task.workspace) === path.resolve(workspace.directory)),
        allowedModels: agent.id === 'opencode' ? opencodeFallbackModels() : [],
        allowedInternalResources: previousFailure === 'runtime_dependency' ? [INTERNAL_RESOURCE_HANDOFF] : [],
      };
      const plannerServer = process.env.WENTIAN_REPAIR_PLANNER_URL || `http://127.0.0.1:${process.env.PORT || '8787'}`;
      try{budget.replan();repairPlan = await runtime.repairPlanner(plannerInput, plannerServer, executionSignal)}catch(error){repairs.push(String(error));break}
      repairPlans.push(repairPlan);
      if (repairPlan.action === 'handoff') {
        repairs.push(`[${repairPlan.source}] handoff: ${repairPlan.rationale}`);
        break;
      }
      const repair = `[${repairPlan.source}] ${repairPlan.action}${repairPlan.model ? ` model=${repairPlan.model}` : ''}${repairPlan.resource ? ` resource=${repairPlan.resource}` : ''}: ${repairPlan.rationale}`;
      repairs.push(repair);
      const execution = repairPlan.action === 'use_internal_resource' ? 'internal-handoff' : `attempt=${attempt + 2}/${config.maxRepairAttempts + 1}`;
      options.emit?.(`• AI Self-healing ${agent.id}\n  └ failure=${previousFailure}, ${execution}, action=${repair}`);
      // 内部Runnerへの切替は、同じ壊れたCLIを再起動せず外側の候補ループへ制御を返します。
      if (repairPlan.action === 'use_internal_resource') break;
    }
    const report = lastReport || { role, agent: agent.id, success: false, output: '外部Agentの実行結果を取得できませんでした。', attempts: 1, failureKind: 'unknown' as const, repairs };
    report.repairs = [...repairs];
    report.repairPlans = [...repairPlans];
    workflowTodo(options.emit, agent.id, roleLabel, 'failed', `role=${role}, failure=${report.failureKind || 'unknown'}, attempts=${report.attempts || 1}`);
    options.emit?.(`• ${role} failed\n  └ agent=${agent.id}, failure=${report.failureKind || 'unknown'}, attempts=${report.attempts || 1}: ${report.output.slice(0, 200)}`);
    return report;
  };
  let reports: OrchestrationResult['reports'];
  let note: string | undefined;
  let evidence: ArtifactEvidence | undefined;
  let workspace: TaskWorkspace | undefined;
  let acceptancePlan: AcceptancePlan | undefined;
  let acceptance: AcceptanceResult | undefined;
  let publication: PublishResult | undefined;
  let stagedPipelineComplete = false;
  if (staged) {
    const capabilities = capabilitiesByAgent();
    const builders = selected.filter(agent => capabilities[agent.id]?.includes('file_write') && buildExternalAgentCommand(agent.id, task.objective, task.workspace, 'builder', { attempt: 0 }, agent.connection));
    if (!builders.length) {
      // 書込み可能なCLIアダプターを持たないのか、能力検証が未合格で起動を許可しないのかを台帳で分けます。
      const awaitingVerification = verification ? [] : selected.filter(agent => capabilities[agent.id]?.includes('file_write') && buildExternalAgentCommand(agent.id, task.objective, task.workspace, 'builder', { attempt: 0 }, agent.connection) && !workAllowsExecution(agent, 'coding')).map(agent => agent.id);
      const partial = { taskId: task.taskId, status: 'blocked' as const, selectedAgents, reports: [], note: awaitingVerification.length
        ? `書込み可能な候補（${awaitingVerification.join(', ')}）の実装能力検証が未合格のため、builderを起動しませんでした（wentian agents で状態確認）。原本への代替実行は行いません。`
        : 'builder・tester・verifierの外部Agent構成を確立できません。原本への代替実行は行いません。' };
      return { ...partial, manifestPath: await saveManifest(task, partial) };
    }
    reports = [];
    try {
      acceptancePlan = await loadAcceptancePlan(task.workspace);
      workspace = await createTaskWorkspace(task.workspace, verification ? path.dirname(task.workspace) : undefined);
      projectScope = createProjectExecutionScope(workspace.source,workspace.directory);
      task.workspace = workspace.directory;
      workflowTodo(options.emit, 'wentian', 'Target確認とSnapshot作成', 'completed', `target=${workspace.source}`);
      workflowTodo(options.emit, 'wentian', '隔離Staging Workspace準備', 'completed', `workspace=${workspace.directory}`);
      options.emit?.(`• 制作場所を準備しました\n  └ ${workspace.directory}`);
      // 実行前にも場所と基準を保存し、中断時に成果物の所在を失わないようにします。
      await saveManifest(task, { taskId: task.taskId, status: 'needs_review', selectedAgents, reports, workspace, acceptancePlan });
    } catch (error) {
      const partial = { taskId: task.taskId, status: 'blocked' as const, selectedAgents, reports,
        note: `制作場所の準備に失敗しました。原本では実行しません。${error instanceof Error ? error.message : String(error)}` };
      return { ...partial, manifestPath: await saveManifest(task, partial) };
    }
    const before = workspace.baseline;
    let residualProcessDetected = false;
    const runUntilSuccess = async (role: 'builder' | 'tester' | 'verifier', agents: ExternalAgentStatus[]) => {
      let previous: OrchestrationResult['reports'][number] | undefined;
      const failures = new Map<string, number>();
      for (const agent of agents) {
        if (executionSignal.aborted) return undefined;
        const category = role === 'builder' ? 'coding' : role === 'tester' ? 'testing' : 'verification';
        if (!verification && performanceScore(agent.id, category) === Number.NEGATIVE_INFINITY) { options.emit?.(`実作業の失敗待機期間中のため${agent.id}/${role}を再起動しません。`); continue; }
        if (previous) {
          options.emit?.(formatAgentHandoff(previous.agent, agent.id, role, previous.output));
        }
        const report = await execute(agent, role); reports.push(report);
        if (report.termination?.verifiedStopped === false) { residualProcessDetected = true; return undefined; }
        if (report.success || (role === 'builder' && report.provisional)) return agent;
        const kind = report.failureKind || 'unknown'; failures.set(kind, (failures.get(kind) || 0) + 1);
        if ((failures.get(kind) || 0) >= 2) { options.emit?.(`同じ失敗が2候補で続いたため${role}を打ち切ります: ${kind}`); return undefined; }
        previous = report;
      }
      return undefined;
    };
    const builder = await runUntilSuccess('builder', builders);
    builderModel=[...reports].reverse().find(report=>report.role==='builder'&&report.agent===builder?.id)?.model;
    // 独立Agentを優先し、全滅時だけBuilderを検証Fallbackへ回します。VerifierはTesterと別Agentを必須にします。
    // Kiloの作業能力試験は外部Testerの非対話Shellが長時間停止するため、Builder以後の試験をWentianホストで実行します。
    // その後のacceptance（固定スクリプト）・差分比較・公開判定が全て合格した場合だけ完了扱いにします。
    const hostVerifiedKiloProbe = verification && builder?.id === 'kilo';
    const testerCandidates = builder ? [...selected.filter(agent => agent.id !== builder.id && automaticRunnerAgents.has(agent.id)), builder] : [];
    const tester = hostVerifiedKiloProbe ? builder : builder && !residualProcessDetected ? await runUntilSuccess('tester', testerCandidates) : undefined;
    const verifierCandidates = tester && builder
      ? (verification?[builder]:snapshot.agents.filter(agent => agent.id !== tester.id && agent.id !== builder.id && automaticRunnerAgents.has(agent.id) &&
          (verification||(agent.state==='available'&&connectionAllowsExecution(agent)&&independentVerifier(builderModel,agent.connection?.model,loadAgentSelectionConfig().modelFamilies)))&&(!task.requestedAgents.length||task.requestedAgents.includes(agent.id)))
        )
      : [];
    const verifier = hostVerifiedKiloProbe ? builder : tester && !residualProcessDetected ? await runUntilSuccess('verifier', verifierCandidates) : undefined;
    stagedPipelineComplete = Boolean(builder && tester && verifier);
    if (residualProcessDetected) {
      note = '外部Agentの残存プロセスを検出したため、次候補と内部LLMを起動せず停止しました。';
      options.emit?.(`• Orchestration stopped\n  └ ${note}`);
    }
    if (!residualProcessDetected && !executionSignal.aborted) {
      workflowTodo(options.emit, 'wentian', '受入検証', 'in_progress', `workspace=${task.workspace}`);
      acceptance = await verifyAcceptance(task.workspace, acceptancePlan, before, { signal: options.signal, terminate: terminateProcessTree, emit: options.emit });
      workflowTodo(options.emit, 'wentian', '受入検証', ['failed', 'blocked'].includes(acceptance.status) ? 'failed' : 'completed', `status=${acceptance.status}`);
    } else {
      acceptance = { status: 'blocked', plan: acceptancePlan, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), commands: [], note: '外部プロセス残存または中断のため検証を開始しません。' };
    }
    evidence = compareArtifactSnapshots(before, await captureArtifactSnapshot(task.workspace));
    if (stagedPipelineComplete && evidence.changes.length && acceptance.status === 'passed' && !executionSignal.aborted) {
      workflowTodo(options.emit, 'wentian', '競合検査とTarget反映', 'in_progress', `target=${workspace.source}, changes=${evidence.changes.length}`);
      publication = await publishTaskWorkspace(workspace, evidence.changes);
      workflowTodo(options.emit, 'wentian', '競合検査とTarget反映', publication.status === 'published' ? 'completed' : 'failed', `status=${publication.status}, files=${publication.files.length}`);
    }
    note = [note, stagedPipelineComplete ? 'Builder・Tester・Verifierを完了し、実ファイル差分と受入検証を記録しました。' : '制作Pipelineが完了していないため、部分成果物をTargetへ反映していません。'].filter(Boolean).join('\n');
    if (!evidence.before.complete || !evidence.after.complete) note += '\nファイル記録が不完全です。変更件数は参考値です。台帳のissuesで未確認範囲を確認してください。';
  } else if (task.parallel) {
    reports = await Promise.all(selected.map(agent => execute(agent, 'reviewer')));
  } else {
    reports = [];
    let previous: OrchestrationResult['reports'][number] | undefined;
    let repeatedFailures = 0;
    for (const [index,agent] of selected.entries()) {
      if (previous) options.emit?.(formatAgentHandoff(previous.agent, agent.id, 'reviewer', previous.output));
      // 回答訂正で全予算を使い切らず、残る候補の初回試行を確保します。
      const report = await execute(agent, 'reviewer',task.responseContract==='grounded_answer'?selected.length-index-1:0);
      reports.push(report);
      if (report.success || report.termination?.verifiedStopped === false || options.signal?.aborted) break;
      repeatedFailures = previous?.failureKind === report.failureKind && (task.responseContract!=='grounded_answer'||previous?.output===report.output) ? repeatedFailures + 1 : 1;
      if (repeatedFailures >= 2) { note = '同じ失敗が2候補で続いたため、原因確認まで再委任を停止しました。'; break; }
      previous = report;
    }
  }
  // 制作開始後は失敗時にも部分変更があり得るため、内部Agentの再編集へ自動移行しません。
  const status = options.signal?.aborted ? 'failed' as const : staged
    ? !stagedPipelineComplete || !evidence?.changes.length || ['failed', 'blocked'].includes(acceptance?.status || '') ? 'failed' as const : publication?.status === 'published' ? 'completed' as const : 'needs_review' as const
    : classifyOrchestrationOutcome(false, reports);
  const interruption = options.signal?.aborted ? (options.signal.reason?.name === 'TimeoutError' ? 'timeout' as const : 'cancelled' as const) : undefined;
  const partial = { taskId: task.taskId, status, selectedAgents, reports, ...(interruption ? { interruption } : {}), ...(note ? { note } : {}), ...(evidence ? { evidence } : {}), ...(workspace ? { workspace } : {}), ...(acceptance ? { acceptance, acceptancePlan } : {}), ...(publication ? { publication } : {}) };
  const manifestPath = await saveManifest(task, partial);
  workflowTodo(options.emit, 'wentian', 'Manifestと最終結果出力', 'completed', `status=${status}, manifest=${manifestPath}`);
  return { ...partial, manifestPath };
}
import {compareAgentPriority as compareManualAgentPriority,compareForcedAgentPriority} from './agent-management.js';
const compareAgentPriority = (left:string,right:string) => compareForcedAgentPriority(left,right) || compareManualAgentPriority(left,right);
import {agentNodeExecutable,agentRuntimeEnvironment} from './agent-runtime.js';
import {resolveAgentExecutable} from './agent-marketplace.js';
