import { randomUUID } from 'node:crypto';
import { MAINTENANCE_EXECUTION } from './maintenance-execution.js';
import { executionAccessSummary } from './execution-governance.js';
import { mkdir, readFile, readdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicOrdinaryWrite } from './safe-file.js';
import { connectionPolicy, connectionStorePath, readAgentConnections } from './agent-connection-policy.js';
import { connectionStatusUpdate, maintainAgentConnections, agentConnectionPolicyHash } from './agent-connection-maintenance.js';
import { maintainAgentInstallation, readAgentInstallations } from './agent-install-maintenance.js';
import { probeAgentCli } from './agent-marketplace.js';
import { buildExternalAgentCommand, runExternalCommand } from './external-orchestrator.js';
import { agentNodeExecutable } from './agent-runtime.js';
import { maintenanceWorkspaces } from './maintenance-workspaces.js';
import { agentNotExcluded } from './agent-exclusion-policy.js';
import { readModelPreferences } from './agent-model-selection.js';
import { readWorkEvidence, workIdentity, workCachePath } from './agent-work-policy.js';
import { loadAgentSelectionConfig } from './agent-selection.js';
import { readExecutionGrants } from './execution-governance.js';
import { latestResourceMeasurement } from './maintenance-resources.js';
import { assertOrdinaryPath } from './safe-file.js';
import type { ExternalAgentStatus } from './external-agents.js';
import { planMaintenance, validateMaintenanceDecision, type MaintenanceAction, type MaintenanceDecision, type MaintenanceObservation } from './maintenance-ai-planner.js';
import { redactTrainingText } from './training-data.js';
import { inspectMaintenanceSource, stageMaintenanceSourceEdit } from './maintenance-source-inspection.js';
import { verifyMaintenanceSourceCandidate } from './maintenance-source-verification.js';
import { isAutomaticallyDeployableSource } from './maintenance-source-deployment.js';
import { launchMaintenanceSourceDeployment } from './maintenance-source-deployment-launch.js';
import { maintenanceDeploymentCutoff, readAgentDeploymentStatus } from './maintenance-deployment-status.js';

export interface AIMaintenanceReport {
  version: 1; agent: string; cycle: string; updatedAt: string;
  status: 'investigating' | 'verified' | 'waiting' | 'needs_approval' | 'implementation_required' | 'unconfirmed';
  decision?: MaintenanceDecision; observations: MaintenanceObservation[];
  history: Array<{ action: MaintenanceAction; observation: string }>;
  plannerError?: string; lastRepairAt?: string; lastSourceRepairAt?: string;
}
const reportRoot = () => process.env.WENTIAN_AI_MAINTENANCE_ROOT || path.join(path.dirname(connectionStorePath()), 'ai-maintenance');
const validId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
/** URLの資格情報・クエリ、利用者の秘密環境変数を、AI送信と保存の両方から除きます。 */
export function sanitizeMaintenanceEvidence(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (/(?:api[_-]?key|authorization|password|credential|secret|access[_-]?token)/i.test(_key)) return '[REDACTED]';
    if (typeof item !== 'string') return item;
    let text = item;
    for (const [key, secret] of Object.entries(process.env)) {
      // 短い接続プレースホルダーでAgent IDなどのプロトコル値を壊さず、資格情報フィールドは長さによらず上で除去します。
      if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) && secret && secret.length >= 12) text = text.split(secret).join('[REDACTED]');
    }
    text = text.replace(/https?:\/\/[^\s"<>]+/g, raw => {
      try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return '[REDACTED_URL]'; }
    });
    return redactTrainingText(text);
  }) ?? 'null';
}
/** 一般一覧へ実ログを流さず、管理者向けの判断・根拠ID・対応履歴だけを公開します。 */
export async function readAIMaintenanceReports(): Promise<Array<Omit<AIMaintenanceReport, 'observations'> & { evidence: Array<{ id: string; kind: string }> }>> {
  let names: string[];
  try { names = await readdir(reportRoot()); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const reports = [];
  for (const name of names.filter(name => name.endsWith('.json') && validId(name.slice(0, -5))).slice(0, 100)) {
    const report = JSON.parse(await readFile(path.join(reportRoot(), name), 'utf8')) as AIMaintenanceReport;
    const { observations, ...summary } = report;
    reports.push({ ...summary, evidence: observations.map(({ id, kind }) => ({ id, kind })) });
  }
  return reports;
}
async function saveReport(report: AIMaintenanceReport): Promise<void> {
  await mkdir(reportRoot(), { recursive: true });
  await atomicOrdinaryWrite(path.join(reportRoot(), report.agent + '.json'), sanitizeMaintenanceEvidence(report) + '\n');
}
/** 保存領域の増大を防ぐため、当機能が作成した履歴だけをAgentごとに直近20サイクル保持します。 */
async function archiveReport(report: AIMaintenanceReport): Promise<void> {
  const directory = path.join(reportRoot(), 'history');
  const name = `${report.agent}-${Date.now()}-${report.cycle}.json`;
  await atomicOrdinaryWrite(path.join(directory, name), sanitizeMaintenanceEvidence(report) + '\n');
  const names = (await readdir(directory)).filter(name => name.startsWith(report.agent + '-') && /^[a-z0-9_-]+-\d{13}-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse();
  for (const old of names.slice(20)) { const file = path.join(directory, old); await assertOrdinaryPath(file); await unlink(file); }
}
/** 調査するファイル名はホスト側で限定します。AIへ任意ファイル読取り能力を与えません。 */
async function diagnosticEvidence(agent: string): Promise<unknown> {
  const readTail = async (file: string) => { try {
    await assertOrdinaryPath(file);
    const handle = await open(file, 'r');
    try { const size = (await handle.stat()).size; const data = Buffer.alloc(Math.min(size, 3000)); await handle.read(data, 0, data.length, Math.max(0, size - data.length)); return data.toString('utf8'); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  } };
  const work = readWorkEvidence()[agent];
  const root = path.resolve(path.dirname(workCachePath()), 'work-verification');
  const relative = work?.evidenceDirectory ? path.relative(root, path.resolve(work.evidenceDirectory)) : '..';
  const within = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  const [connectionDiagnostic, workDiagnostic] = await Promise.all([
    readTail(path.join(path.dirname(connectionStorePath()), 'connection-diagnostics', agent + '.json')),
    within && work ? readTail(path.join(work.evidenceDirectory, 'failure.json')) : Promise.resolve(null),
  ]);
  return { connectionDiagnostic, workDiagnostic, installation: readAgentInstallations()[agent],
    grants: readExecutionGrants().filter(grant => grant.agent === agent).map(grant => ({ root: grant.root, expiresAt: grant.expiresAt, expired: Date.parse(grant.expiresAt) <= Date.now(), allowHostAccount: grant.allowHostAccount })),
    resources: latestResourceMeasurement(), maintenanceAccess: executionAccessSummary() };
}
type MaintainOptions = NonNullable<Parameters<typeof maintainAgentConnections>[3]>;
export interface AIMaintenanceDependencies {
  planner?: typeof planMaintenance; maintain?: typeof maintainAgentConnections;
  probe?: typeof probeAgentCli; install?: typeof maintainAgentInstallation;
  diagnostics?: (id: string) => Promise<unknown>; help?: (agent: ExternalAgentStatus, signal?: AbortSignal) => Promise<string>;
  source?: typeof inspectMaintenanceSource;
  stageSource?: typeof stageMaintenanceSourceEdit;
  verifySource?: typeof verifyMaintenanceSourceCandidate;
  deploySource?: typeof launchMaintenanceSourceDeployment;
}
async function inspectHelp(agent: ExternalAgentStatus, signal?: AbortSignal): Promise<string> {
  const cwd = maintenanceWorkspaces().connection;
  await mkdir(cwd, { recursive: true });
  const base = buildExternalAgentCommand(agent.id, '', cwd, 'reviewer', { attempt: 0 }, agent.connection);
  if (!base) throw new Error('このAgentのCLIヘルプ取得方法は未実装です。');
  const prefix = base.executable === agentNodeExecutable() ? base.args.slice(0, 1) : [];
  return runExternalCommand({ executable: base.executable, args: [...prefix, '--help'] }, { cwd, agent: agent.id, role: 'maintenance-help', timeoutMs: 15000, idleTimeoutMs: 15000, maintenance: true, maintenanceToken:MAINTENANCE_EXECUTION, signal });
}
/** 成功認定はAIの文章ではなく、現在の設定に一致する有効な実証記録だけで決めます。 */
function hostVerified(agent: ExternalAgentStatus): boolean {
  const connection = agent.connection, work = agent.workEvidence, now = Date.now();
  const cutoff = maintenanceDeploymentCutoff();
  const required = loadAgentSelectionConfig().agentCapabilities[agent.id]?.includes('file_write') ? ['reading','coding','testing','verification'] as const : ['reading'] as const;
  return Boolean(agent.liveState === 'healthy' && connection?.status === 'verified' && Date.parse(connection.expiresAt) > now
    && connection.policyHash === agentConnectionPolicyHash(agent.id) && connection.cliVersion === agent.version
    && work?.status === 'passed' && work.identity === workIdentity(connection, agent.version) && Date.parse(work.expiresAt) > now
    && (cutoff === undefined || (Date.parse(connection.checkedAt) > cutoff && Date.parse(work.checkedAt) > cutoff))
    && required.every(capability => work.capabilities[capability] === true));
}

/** AIが観測→判断→許可済み能力の実行→再観測を繰り返します。成功認定は従来の実証条件だけが行います。 */
export async function maintainAgentsWithAI(agents: ExternalAgentStatus[], onUpdate?: Parameters<typeof maintainAgentConnections>[1], signal?: AbortSignal,
  options: MaintainOptions = {}, dependencies: AIMaintenanceDependencies = {}): Promise<ExternalAgentStatus[]> {
  const results: ExternalAgentStatus[] = [];
  for (const initial of agents) {
    signal?.throwIfAborted();
    if (!validId(initial.id) || !agentNotExcluded(initial) || !connectionPolicy().enabled) { results.push(initial); continue; }
    let agent = initial;
    const cycle = randomUUID();
    let previous: AIMaintenanceReport | undefined;
    try { previous = JSON.parse(await readFile(path.join(reportRoot(), agent.id + '.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const report: AIMaintenanceReport = { version: 1, cycle, agent: agent.id, updatedAt: new Date().toISOString(), status: 'investigating', observations: [], history: [], lastRepairAt: previous?.lastRepairAt, lastSourceRepairAt: previous?.lastSourceRepairAt };
    const observe = (kind: string, facts: unknown) => {
      const clean = sanitizeMaintenanceEvidence(facts);
      const limit = kind === 'inspect_source' ? 12000 : 2000;
      const observation = { id: `${cycle}:${report.observations.length}`, kind, facts: clean.length > limit ? { excerpt: clean.slice(0, limit), truncated: true } : JSON.parse(clean) };
      report.observations.push(observation); return observation.id;
    };
    const configuration = () => JSON.stringify(readModelPreferences()[agent.id]);
    const revision = configuration();
    const refresh = () => {
      const connection = readAgentConnections()[agent.id] || agent.connection;
      if (connection) agent = connectionStatusUpdate(agent, connection, readWorkEvidence()[agent.id] || agent.workEvidence);
    };
    refresh();
    const access=executionAccessSummary();
    observe('current', { agent, modelPreference: readModelPreferences()[agent.id], maintenanceAccess:{defaultAllowed:access.maintenanceDefault,revoked:access.revokedAgents.includes(agent.id)}, autoInstall: options.autoInstall !== false, verifyWork: options.verifyWork !== false });
    if (previous) observe('previous_cycle', { updatedAt: previous.updatedAt, status: previous.status, decision: previous.decision, history: previous.history });
    const deployment = readAgentDeploymentStatus(agent.id);
    if (deployment) observe('previous_deployment', deployment);
    await saveReport(report);
    // 8回は暴走防止の上限です。自然言語の分類や原因を決める値ではありません。
    try { for (let step = 0; step < 8; step++) {
      signal?.throwIfAborted();
      if (!agentNotExcluded(agent) || !connectionPolicy().enabled || revision !== configuration()) { report.status = 'unconfirmed'; break; }
      if (deployment?.status === 'deployment_started' || deployment?.status === 'recovery_required') { report.status = 'unconfirmed'; break; }
      refresh();
      const now = Date.now(), connection = agent.connection, work = agent.workEvidence;
      const cutoff = maintenanceDeploymentCutoff();
      if (cutoff === Number.POSITIVE_INFINITY) { report.status = 'unconfirmed'; observe('deployment_pending', { confirmationRequired: true }); break; }
      const connectionStaleAfterDeployment = cutoff !== undefined && !(Date.parse(connection?.checkedAt || '') > cutoff);
      const workStaleAfterDeployment = cutoff !== undefined && !(Date.parse(work?.checkedAt || '') > cutoff);
      const connected = agent.liveState === 'healthy' && connection?.status === 'verified' && Date.parse(connection.expiresAt) > now
        && connection.policyHash === agentConnectionPolicyHash(agent.id) && connection.cliVersion === agent.version && !connectionStaleAfterDeployment;
      const passed = hostVerified(agent);
      const workReady = workStaleAfterDeployment || !work || work.identity !== (connection ? workIdentity(connection, agent.version) : '') || Date.parse(work.retryAt) <= now || work.status === 'passed';
      const tried = (action: MaintenanceAction) => report.history.some(item => item.action === action);
      const allowed: MaintenanceAction[] = ['wait', 'request_approval', 'report_defect'];
      if (!tried('inspect_cli')) allowed.push('inspect_cli');
      if (!tried('inspect_evidence')) allowed.push('inspect_evidence');
      if (!tried('inspect_help')) allowed.push('inspect_help');
      // 原因が実装にある可能性をAIが調べられるよう、複数回の限定的な読取りを許可します。
      if (access.maintenanceDefault && !access.revokedAgents.includes(agent.id)) {
        if (report.history.filter(item => item.action === 'inspect_source').length < 4) allowed.push('inspect_source');
        if (!tried('stage_source_edit') && (!previous?.lastSourceRepairAt || now - Date.parse(previous.lastSourceRepairAt) >= 3600000)
          && report.observations.some(item => item.kind === 'inspect_source' && (item.facts as any)?.result?.operation === 'read')) allowed.push('stage_source_edit');
        if (!tried('verify_source_edit') && report.observations.some(item => item.kind === 'stage_source_edit' && (item.facts as any)?.result?.candidateId)) allowed.push('verify_source_edit');
        if (!tried('deploy_source_edit') && report.observations.some(item => item.kind === 'verify_source_edit' && (item.facts as any)?.result?.status === 'candidate_verified' && isAutomaticallyDeployableSource((item.facts as any)?.result?.source))) allowed.push('deploy_source_edit');
      }
      // 修復・再接続は必ず読み取り専用の追加観測を先行させます。モデル固定は下位実行器も再照合します。
      if (report.history.length) {
        if (agent.liveState === 'healthy' && !tried('connect')) allowed.push('connect');
        if (connected && workReady && options.verifyWork !== false && !tried('verify_work')) allowed.push('verify_work');
        if (options.autoInstall !== false && process.env.WENTIAN_AGENT_AUTO_INSTALL !== 'false' && !tried('repair_cli')
          && agent.liveState !== 'healthy' && !readAgentInstallations()[agent.id]?.processBlocked
          && (!previous?.lastRepairAt || now - Date.parse(previous.lastRepairAt) >= 3600000)) allowed.push('repair_cli');
      }
      if (passed) allowed.push('complete');
      const input = { agent: agent.id, observations: report.observations, history: report.history, allowedActions: allowed,
        constraints: { pinnedModel: readModelPreferences()[agent.id], autoInstall: options.autoInstall !== false, verifyWork: options.verifyWork !== false,
          connectionVerified: Boolean(connected), workVerified: passed, workRetryAt: work?.retryAt, maintenanceDefaultAllowed:access.maintenanceDefault&&!access.revokedAgents.includes(agent.id), grantsMayNotBeCreatedOrExtended: true, arbitraryCommandsAllowed: false, remainingSteps: 8 - step } };
      let decision: MaintenanceDecision;
      try { decision = validateMaintenanceDecision(await (dependencies.planner || planMaintenance)(input, signal), input); }
      catch (error) {
        signal?.throwIfAborted();
        report.status = 'unconfirmed'; report.plannerError = sanitizeMaintenanceEvidence(String((error as Error).message)).slice(0, 1000); break;
      }
      if (decision.action === 'stage_source_edit' && !decision.evidence.some(id => {
        const item = report.observations.find(observation => observation.id === id);
        const result = (item?.facts as any)?.result;
        return item?.kind === 'inspect_source' && result?.operation === 'read' && result?.path === decision.edit?.path
          && Array.isArray(result.lines) && result.lines.map((line: { text?: unknown }) => typeof line.text === 'string' ? line.text : '').join('\n').includes(decision.edit?.expected || '\0');
      })) { report.status = 'unconfirmed'; report.plannerError = '修正対象の実際の読取り証跡を確認できません。'; break; }
      if (decision.action === 'verify_source_edit' && !decision.evidence.some(id => {
        const item = report.observations.find(observation => observation.id === id);
        return item?.kind === 'stage_source_edit' && (item.facts as any)?.result?.candidateId === decision.verification?.candidateId;
      })) { report.status = 'unconfirmed'; report.plannerError = '検証対象の修正候補を確認できません。'; break; }
      if (decision.action === 'deploy_source_edit' && !decision.evidence.some(id => {
        const item = report.observations.find(observation => observation.id === id), result = (item?.facts as any)?.result;
        return item?.kind === 'verify_source_edit' && result?.status === 'candidate_verified' && result?.candidateId === decision.deployment?.candidateId && isAutomaticallyDeployableSource(result?.source);
      })) { report.status = 'unconfirmed'; report.plannerError = '配備対象の検証証跡を確認できません。'; break; }
      // コード本文を管理APIや判断履歴へ含めず、専用候補だけへ保存します。
      const { edit: _edit, ...visibleDecision } = decision;
      report.decision = visibleDecision;
      report.updatedAt = new Date().toISOString();
      await saveReport(report);
      signal?.throwIfAborted();
      if (!agentNotExcluded(agent) || !connectionPolicy().enabled || revision !== configuration()) { report.status = 'unconfirmed'; break; }
      if (['wait', 'request_approval', 'report_defect', 'complete'].includes(decision.action)) {
        refresh();
        if (decision.action === 'complete' && !hostVerified(agent)) { report.status = 'unconfirmed'; observe('invalidated', { code: 'evidence_changed_during_planning' }); break; }
        report.status = ({ wait: 'waiting', request_approval: 'needs_approval', report_defect: 'implementation_required', complete: 'verified' } as const)[decision.action as 'wait' | 'request_approval' | 'report_defect' | 'complete']; break;
      }
      // AIの応答待ち中に設定・許可が変わった場合、古い判断を実行しません。
      signal?.throwIfAborted();
      if (!agentNotExcluded(agent) || !connectionPolicy().enabled || revision !== configuration()) { report.status = 'unconfirmed'; break; }
      if (decision.action === 'inspect_source' || decision.action === 'stage_source_edit' || decision.action === 'verify_source_edit' || decision.action === 'deploy_source_edit') {
        const currentAccess = executionAccessSummary();
        if (!currentAccess.maintenanceDefault || currentAccess.revokedAgents.includes(agent.id)) { report.status = 'unconfirmed'; break; }
      }
      options.onActivity?.([agent.id]);
      try {
        let facts: unknown;
        if (decision.action === 'inspect_cli') { agent = { ...agent, ...await (dependencies.probe || probeAgentCli)({ cli: agent.cli || agent.id }, signal) }; facts = { liveState: agent.liveState, version: agent.version, probeError: agent.probeError }; }
        else if (decision.action === 'inspect_evidence') facts = await (dependencies.diagnostics || diagnosticEvidence)(agent.id);
        else if (decision.action === 'inspect_help') facts = await (dependencies.help || inspectHelp)(agent, signal);
        else if (decision.action === 'inspect_source') facts = await (dependencies.source || inspectMaintenanceSource)(decision.source!, signal);
        else if (decision.action === 'stage_source_edit') { report.lastSourceRepairAt = new Date().toISOString(); await saveReport(report); facts = await (dependencies.stageSource || stageMaintenanceSourceEdit)(decision.edit!, path.join(reportRoot(), 'proposals', agent.id), signal); }
        else if (decision.action === 'verify_source_edit') facts = await (dependencies.verifySource || verifyMaintenanceSourceCandidate)(decision.verification!, path.join(reportRoot(), 'proposals', agent.id), signal);
        else if (decision.action === 'deploy_source_edit') facts = await (dependencies.deploySource || launchMaintenanceSourceDeployment)(decision.deployment!, path.join(reportRoot(), 'proposals', agent.id), agent.id, signal);
        else if (decision.action === 'repair_cli') {
          report.lastRepairAt = new Date().toISOString(); await saveReport(report);
          agent = await (dependencies.install || maintainAgentInstallation)(agent, onUpdate, signal, { repair: true }); facts = agent;
        } else {
          const maintained = await (dependencies.maintain || maintainAgentConnections)([agent], onUpdate, signal,
            { ...options, autoInstall: false, verifyWork: decision.action === 'verify_work', forceConnection: connectionStaleAfterDeployment, forceWork: workStaleAfterDeployment, selectCandidates: async (candidates, facts) => {
              const id = observe('model_candidates', { candidates: candidates.map((candidate, index) => ({ id: String(index), ...candidate })), facts });
              const selectionInput = { agent: agent.id, observations: report.observations, history: report.history, allowedActions: ['select_candidate'] as MaintenanceAction[],
                constraints: { ...input.constraints, candidateIds: candidates.map((_candidate, index) => String(index)) } };
              const selection = validateMaintenanceDecision(await (dependencies.planner || planMaintenance)(selectionInput, signal), selectionInput);
              signal?.throwIfAborted();
              if (!agentNotExcluded(agent) || !connectionPolicy().enabled || revision !== configuration()) throw new Error('AI判断中に保守設定が変更されました。');
              report.history.push({ action: 'select_candidate', observation: id });
              observe('model_selection', selection); await saveReport(report);
              return [candidates[Number(selection.candidate)]];
            } });
          agent = maintained[0] || agent; facts = agent;
        }
        refresh();
        const id = observe(decision.action, { result: facts, current: { liveState: agent.liveState, version: agent.version, connection: agent.connection, workEvidence: agent.workEvidence } });
        report.history.push({ action: decision.action, observation: id });
        await onUpdate?.(agent);
        if (decision.action === 'stage_source_edit') report.status = 'implementation_required';
        if (decision.action === 'verify_source_edit') report.status = 'implementation_required';
        if (decision.action === 'deploy_source_edit') { report.status = 'implementation_required'; break; }
      } catch (error) {
        signal?.throwIfAborted();
        if ((error as any)?.termination?.verifiedStopped === false) throw error;
        const id = observe(decision.action, { error: String((error as Error).message), code: (error as any)?.code, name: (error as Error).name });
        report.history.push({ action: decision.action, observation: id });
      } finally { options.onActivity?.([]); }
      report.updatedAt = new Date().toISOString(); await saveReport(report);
    } } finally {
      if (report.status === 'investigating' || signal?.aborted) report.status = 'unconfirmed';
      report.updatedAt = new Date().toISOString(); await saveReport(report);
      // 最新表示と別にサイクル単位の証跡を残し、次の確認で過去の判断を失いません。
      await archiveReport(report);
    }
    results.push(agent);
  }
  return results;
}
