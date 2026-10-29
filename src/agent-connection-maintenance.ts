import { maintenanceWorkspaces } from './maintenance-workspaces.js';
import { MAINTENANCE_EXECUTION } from './maintenance-execution.js';
import { runResourceLimited, type measureMaintenanceResources } from './maintenance-resources.js';
import { ExecutionDenied } from './execution-governance.js';
import { createHash } from 'node:crypto';
import { maintenancePythonCommand } from './maintenance-python.js';
export { maintenancePythonCommand } from './maintenance-python.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentNotExcluded } from './agent-exclusion-policy.js';
import { fileURLToPath } from 'node:url';
import { renameWithRetry } from './atomic-file.js';
import { buildExternalAgentCommand, isAgentExecuting, runExternalCommand } from './external-orchestrator.js';
import { buildGroupConversationCommand } from './group-agent-responder.js';
import { connectionPolicy, connectionStorePath, isFreeAgentModel, managedAgentIds, readAgentConnections, type AgentConnection } from './agent-connection-policy.js';
import type { ExternalAgentStatus } from './external-agents.js';
import type { AgentWorkEvidence } from './agent-work-policy.js';
import { verifyAgentWork } from './agent-work-maintenance.js';
import { maintenanceDeploymentCutoff } from './maintenance-deployment-status.js';
import { readWorkEvidence,workEvidenceState,workIdentity } from './agent-work-policy.js';
import { acquireAgentMaintenanceLease } from './agent-maintenance-lease.js';
import {maintainAgentInstallation,readAgentInstallations} from './agent-install-maintenance.js';
import {orderAgents} from './agent-management.js';
import {agentNodeExecutable} from './agent-runtime.js';
import {redactTrainingText} from './training-data.js';
import { readModelPreferences, manualModelPreference } from './agent-model-selection.js';
import { configuredAgentModels } from './agent-native-models.js';
import { assertMaintenanceModelReady, MaintenanceModelDeferred } from './maintenance-model-admission.js';

export interface ConnectionMaintenanceDependencies {
  admit?: typeof assertMaintenanceModelReady;
  run: typeof runExternalCommand;
  configure: (agent: string, mode: 'free' | 'local' | 'native', model: string, apply: boolean, choice?:ConnectionCandidate) => Promise<{ fingerprint: string; changedFiles: string[]; backup?: string }>;
  rollback: (agent: string, mode: 'free' | 'local' | 'native', model: string, backup: string, choice?:ConnectionCandidate) => Promise<void>;
  discover: (agent: string, workspace: string) => Promise<string[] | undefined>;
  discoverLocal: (baseUrl: string, preferred: string) => Promise<string[]>;
  now: () => number;
  native?: typeof configuredAgentModels;
  localBases?:()=>string[];
  skipCandidates?:string[];
  selectCandidates?: (candidates: ConnectionCandidate[], evidence: unknown) => Promise<ConnectionCandidate[]>;
}
export interface ConnectionCandidate {mode:'free'|'local'|'native';model:string;provider?:string;baseUrl?:string;source?:'free'|'wentian'|'other'}
/** 同名でもプロバイダー・接続先の違う候補を混同しません。 */
export const connectionCandidateKey=(choice:ConnectionCandidate)=>JSON.stringify([choice.mode,choice.provider||'',choice.baseUrl||'',choice.model]);
/** 保存した選択と保守方針が変われば、期限内でも以前の接続認定を再確認します。 */
export function agentConnectionPolicyHash(agent:string):string {
  return createHash('sha256').update(JSON.stringify({policy:connectionPolicy(),preference:readModelPreferences()[agent]})).digest('hex');
}
/** 利用者指定と、標準ローカルサービスの接続口だけを実在一覧で確認します。 */
export function automaticLocalBaseUrls():string[]{
  const configured=readModelPreferences();
  const ollama=process.env.OLLAMA_HOST||'http://127.0.0.1:11434';
  return [...new Set([connectionPolicy().localBaseUrl,configured.lmstudio?.baseUrl,...Object.values(configured).map(value=>value.baseUrl),process.env.LMSTUDIO_BASE_URL,ollama.includes('://')?ollama.replace(/\/$/,'').replace(/\/v1$/,'')+'/v1':undefined].filter((value):value is string=>Boolean(value)))].filter(value=>{try{const url=new URL(value);return['http:','https:'].includes(url.protocol)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash}catch{return false}});
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 秘密値や応答本文を保存せず、失敗の種類だけを記録します。 */
function failureReason(error: unknown): string {
  if (error instanceof MaintenanceModelDeferred) return error.message;
  const text = (error as { diagnostic?: string })?.diagnostic ?? String(error).replace(/^.*Command failed:.*$/gm, '');
  if (/ModuleNotFoundError.*(?:yaml|PyYAML)/i.test(text)) return '自動保守に必要なPyYAMLがPythonへ導入されていません。';
  if (/No installed Python|Python was not found|(?:spawn|ENOENT).*\b(?:py|python)\b/i.test(text)) return '自動保守用のPythonを起動できませんでした。';
  if (/生存確認が成功/i.test(text)) return 'CLIの起動確認に失敗しました。';
  if (/unauthorized|authentication|401|403|api.?key|log.?in/i.test(text)) return '認証・利用権限の確認に失敗しました。';
  if (/model not found|unknown model|invalid model/i.test(text)) return '指定モデルが提供されていません。';
  if (/model.*unloaded|not loaded/i.test(text)) return '指定モデルが未ロードのため、ロード済みモデルで再確認します。';
  if (/context overflow|context size.*exceed|prompt too large/i.test(text)) return 'ローカルモデルの入力長が不足しています。最小のツール構成と十分なコンテキスト長で再確認します。';
  if (/timeout|timed out|時間|タイムアウト/i.test(text)) return '実応答の待機時間を超過しました。';
  if (/quota|rate.limit|429|402|credit/i.test(text)) return '無料枠・利用制限により応答できませんでした。';
  if (/unknown option|unknown flag|invalid argument/i.test(text)) return '導入済みCLIが起動引数に対応していません。';
  if (/unsupported.*(?:high|reasoning)|reasoning.*unsupported|invalid.*reasoning/i.test(text)) return '推論強度の設定がローカルLLMに対応していません。';
  if (/provider.*(?:not found|not configured|unknown)|no.*provider/i.test(text)) return 'モデルのプロバイダー設定を認識できませんでした。';
  if (/並行変更/i.test(text)) return '設定の並行変更を検出したため、上書きせず保守を停止しました。';
  if (/config.*(?:invalid|validation)|設定.*(?:不正|スキーマ)/i.test(text)) return '設定形式の検査に失敗しました。';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|connect.*timeout/i.test(text)) return '接続先へ到達できませんでした。';
  if (/指定した確認応答/i.test(text)) return '接続は完了しましたが確認用の実応答が一致しませんでした。';
  return 'CLI・一覧取得・設定更新または実応答の確認に失敗しました。';
}

/** CLI未導入と、接続・能力の確認結果を分けて表示し、再試行待ちを隠しません。 */
export function connectionStatusUpdate(agent: ExternalAgentStatus, connection: AgentConnection, workEvidence?: AgentWorkEvidence): ExternalAgentStatus {
  if (connection.maintenanceDeferred) return {...agent, connection, workEvidence, state:'needs_recheck', stateLabel:connection.maintenanceDeferredKind === 'permission' ? '実行許可待ち・保守保留' : connection.maintenanceDeferredKind === 'model' ? 'ローカルモデル未ロード・保守保留' : '保守保留', note:connection.reason || new MaintenanceModelDeferred().message};
  const installation=agent.installation||readAgentInstallations()[agent.id];
  if(agent.liveState==='not_installed'&&installation&&installation.status!=='verified')return {...agent,installation,connection,workEvidence,state:'needs_recheck',stateLabel:installation.status==='installing'?'CLI自動導入中':installation.status==='retry_wait'?'CLI導入失敗・再試行待ち':installation.status==='disabled'?'CLI自動導入停止':'CLI導入に対応が必要',note:installation.reason+(installation.retryAt?' 次回確認予定: '+installation.retryAt:'')};
  if (agent.liveState !== 'healthy') return { ...agent, connection, workEvidence,
    state: agent.liveState === 'not_installed' ? 'unavailable' : 'needs_recheck',
    stateLabel: agent.liveState === 'not_installed' ? 'CLI未導入' : 'CLI起動失敗',
    note: agent.liveState === 'not_installed' ? 'CLIを検出できません。バックグラウンドで自動導入を開始します。' : agent.probeError || connection.reason || 'CLIの起動確認に失敗しました。' };
  const verified = connection.status === 'verified' && Date.parse(connection.expiresAt) > Date.now();
  if (connection.status === 'verified' && !verified) return { ...agent, connection, workEvidence, state: 'needs_recheck',
    stateLabel: '接続確認期限切れ・再確認待ち', note: `前回の接続確認は成功しましたが、有効期限（${connection.expiresAt}）を過ぎています。再確認が必要です。` };
  if (!verified) return { ...agent, connection, workEvidence, state: 'needs_recheck',
    stateLabel: connection.status === 'pending' ? '接続確認中' : '接続確認失敗・再試行待ち',
    note: `${connection.reason || '接続確認中です。'}${connection.status === 'failed' ? ` 次回確認予定: ${connection.expiresAt}` : ''}` };
  const cutoff = maintenanceDeploymentCutoff();
  if (cutoff !== undefined && !(Date.parse(connection.checkedAt) > cutoff && Date.parse(workEvidence?.checkedAt || '') > cutoff)) return { ...agent, connection, workEvidence, state: 'needs_recheck', stateLabel: '接続確認中', note: 'プログラム更新後の接続・作業を再確認中です。' };
  const identityMatches = Boolean(workEvidence && workEvidence.identity === workIdentity(connection, agent.version));
  const workState = identityMatches ? workEvidenceState(workEvidence) : 'unverified';
  const workPassed = workState === 'passed';
  let stateLabel = '接続確認済み・作業未検証';
  if (workPassed) stateLabel = '実作業検証済み';
  else if (workState === 'attention_required') stateLabel = '実作業検証・利用者対応待ち';
  else if (workState === 'retry_pending') stateLabel = '実作業検証失敗・再試行待ち';
  else if (workState === 'expired') stateLabel = '実作業検証期限切れ・再確認待ち';
  else if (identityMatches && workEvidence?.status === 'failed') stateLabel = '実作業検証失敗・再確認待ち';
  return { ...agent, connection, workEvidence, state: workState === 'attention_required' ? 'unavailable' : workPassed ? 'available' : 'needs_recheck',
    stateLabel,
    note: identityMatches ? workEvidence?.reason || connection.reason || '接続を確認しました。' : '接続は確認済みです。現在のモデル・CLI版に一致する実作業の合格記録がありません。' };
}

/** 接続設定だけを扱うPythonブリッジへ値を引数配列で渡し、秘密情報は出力しません。 */
export async function configure(agent: string, mode: 'free' | 'local' | 'native', model: string, apply: boolean, signal?: AbortSignal, backup?: string, choice?:ConnectionCandidate, run: typeof runExternalCommand = runExternalCommand):Promise<{fingerprint:string;changedFiles:string[];backup?:string}> {
  if (agent === 'ollama' || agent === 'lmstudio') {
    if (mode !== 'native') throw new Error('Ollama/LM Studioはネイティブモデルだけを選択できます。');
    return { fingerprint: createHash('sha256').update(JSON.stringify({model, host: agent === 'ollama' ? process.env.OLLAMA_HOST || '' : choice?.baseUrl||readModelPreferences().lmstudio?.baseUrl || '', runnerRevision: 1})).digest('hex'), changedFiles: [] };
  }
  const python = maintenancePythonCommand();
  const preference = choice||manualModelPreference(agent);
  const command = { executable: python.executable, args: [...python.args, path.join(root, 'scripts', 'maintain-agent-connection.py'), '--agent', agent, '--mode', mode, '--model', model,
    '--base-url', preference?.baseUrl || connectionPolicy().localBaseUrl, ...(preference?.source === 'wentian' ? ['--gateway'] : []),
    '--report-root', path.join(path.dirname(connectionStorePath()), 'connection-backups'), ...(apply ? ['--apply'] : []), ...(backup ? ['--rollback', backup] : [])] };
  // 設定ブリッジも許可済みの保守専用領域で起動します。プロジェクト全体への実行許可は要求しません。
  const workspace = maintenanceWorkspaces().connection;
  await mkdir(workspace, { recursive: true });
  const output = await run(command, { cwd: workspace, timeoutMs: 30_000, idleTimeoutMs: 30_000, agent, role: 'connection-config', signal, maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION });
  const result=JSON.parse(output) as { fingerprint: string; changedFiles: string[]; backup?: string };
  const backend=agent==='goose'&&mode==='native'&&preference?.provider==='codex'
    ?(await configure('codex','native',model,false,signal,undefined,undefined,run)).fingerprint:undefined;
  return {...result,fingerprint:createHash('sha256').update(JSON.stringify({settings:result.fingerprint,backend,mode,model,provider:preference?.provider,baseUrl:preference?.baseUrl})).digest('hex')};
}

/** CLIまたは公式の無料カテゴリから候補を取得し、取得失敗と候補ゼロを区別します。 */
export async function discoverAgentModels(agent: string, workspace: string, signal?: AbortSignal): Promise<string[] | undefined> {
  if(agent==='codex'){
    const base=buildExternalAgentCommand(agent,'一覧検査',workspace,'reviewer',{attempt:0},null)!;
    const prefix=base.executable===agentNodeExecutable()?base.args.slice(0,1):[];
    const output=await runExternalCommand({executable:base.executable,args:[...prefix,'debug','models']},{cwd:workspace,timeoutMs:30000,idleTimeoutMs:30000,agent,role:'model-discovery',signal,maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION});
    const payload=JSON.parse(output);
    if(!Array.isArray(payload.models))throw new Error('Codexのモデル一覧形式が不正です。');
    return payload.models.filter((item:any)=>item.visibility==='list'&&typeof item.slug==='string').map((item:any)=>item.slug);
  }
  if (agent === 'cline') {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch('https://api.cline.bot/api/v1/ai/cline/recommended-models', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`Cline無料モデル一覧: HTTP ${response.status}`);
    const payload = await response.json() as { free?: Array<{ id: string }> };
    if (!Array.isArray(payload.free)) throw new Error('Cline無料カテゴリを取得できません。');
    return payload.free.map(item => item.id).filter(model => isFreeAgentModel(agent, model));
  }
  if (!['opencode', 'kilo', 'crush'].includes(agent)) return undefined;
  // 導入済みの実行ファイルを再利用し、npmの対話的ラッパーを避けます。
  const base = buildExternalAgentCommand(agent, '一覧検査', workspace, 'reviewer', { attempt: 0 }, null)!;
  const prefix = base.executable === agentNodeExecutable() ? base.args.slice(0, 1) : [];
  const args = agent === 'crush' ? [...prefix, 'models'] : [...prefix, 'models'];
  const output = await runExternalCommand({ executable: base.executable, args }, { cwd: workspace, timeoutMs: 30_000, idleTimeoutMs: 30_000, agent, role: 'model-discovery', signal,maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION });
  const models = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map(line => line.trim()).filter(model => /^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]*\/[a-zA-Z0-9/_.:@+-]+$/.test(model) && !model.startsWith('wentian-local/'));
  const preferred = agent === 'kilo' ? 'kilo/kilo-auto/free' : `${agent === 'crush' ? 'opencode-zen' : 'opencode'}/nemotron-3-ultra-free`;
  return [...new Set(models)].sort((a, b) => Number(b === preferred) - Number(a === preferred) || a.localeCompare(b));
}

/** 自動選定では無料モデルだけを使い、その他のモデルは利用者の明示選択でのみ使用します。 */
export async function discoverFreeModels(agent: string, workspace: string, signal?: AbortSignal): Promise<string[] | undefined> {
  return (await discoverAgentModels(agent, workspace, signal))?.filter(model => isFreeAgentModel(agent, model));
}

/** 接続確認では実モデルを指定し、ツールを禁止した短い応答だけで成否を判定します。 */
export async function discoverLocalModels(baseUrl: string, preferred: string, signal?: AbortSignal): Promise<string[]> {
  // 実際のモデル一覧を検査し、廃止済みの設定値を何度も試しません。
  const endpoint = new URL(baseUrl.replace(/\/$/, '') + '/models');
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('ローカルLLMの接続先設定が不正です。');
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(endpoint, {signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
  if (!response.ok) throw new Error(`ローカルモデル一覧: HTTP ${response.status}`);
  const payload = await response.json() as {data?: Array<{id?: unknown; type?: string; available?:boolean; deprecated?:boolean}>};
  if (!Array.isArray(payload.data)) throw new Error('ローカルモデル一覧の形式が不正です。');
  const models = [...new Set(payload.data.filter(item => item.available !== false && item.deprecated !== true && item.type !== 'embedding' && typeof item.id === 'string' && item.id.trim() && !/embedding|embed-text/i.test(item.id)).map(item => String(item.id)))];
  if (!models.length) throw new Error('ローカル推論サーバーに会話用モデルがありません。');
  // LM Studioの一覧は未ロードの導入済みモデルも含みます。
  // 稼働中のモデルを優先し、確認のたびに重いモデルを入れ替えません。
  let loaded = new Set<string>();
  try {
    const native = new URL('/api/v1/models', endpoint);
    const limit = AbortSignal.timeout(3_000);
    const state = await fetch(native, {signal:signal ? AbortSignal.any([signal,limit]) : limit});
    if (state.ok) {
      const status = await state.json() as {models?: Array<{key?: string; loaded_instances?: unknown[]}>};
      loaded = new Set(status.models?.filter(model => model.loaded_instances?.length).map(model => model.key || '') || []);
    }
  } catch { if(signal?.aborted)throw new Error('保守処理を中断しました。'); }
  return models.sort((a, b) => Number(loaded.has(b)) - Number(loaded.has(a)) || Number(b === preferred) - Number(a === preferred));
}

/** 明示した候補で短い実応答を検査し、既定モデルへの復帰を防ぎます。 */
export function connectionProbeCommand(agent: string, entry: AgentConnection, workspace: string, token: string) {
  const prompt = `読み取り専用の接続検証です。禁止: ツール呼出し、ファイル調査・変更、コマンド実行、外部システム操作、秘密情報取得。書き込み許可範囲: なし。停止条件: 禁止操作が必要。報告先: 標準出力のみ。${token}だけを返してください。`;
  const command = buildGroupConversationCommand(agent, prompt, workspace, entry);
  if (!command) throw new Error('接続検証ランナーが未対応です。');
  if (agent === 'goose') {
    // 拡張を読み込まない接続検査では、会話履歴用の長い指示を重ねません。
    // 少量の文字列エコーに限定し、ローカルモデルの推論時間を抑えます。
    const textIndex = command.args.indexOf('--text');
    command.args[textIndex + 1] = `ツール、ファイル、コマンド、外部システムを一切操作せず、${token}だけを返してください。`;
  }
  return command;
}

/** 設定の変化・CLI版・方針変更時に再検証し、成功記録は24時間まで再利用します。 */
export async function maintainAgentConnection(agent: ExternalAgentStatus, previous: AgentConnection | undefined, deps: Partial<ConnectionMaintenanceDependencies> = {}, signal?: AbortSignal): Promise<AgentConnection> {
  const policy = connectionPolicy();
    const services = { admit: assertMaintenanceModelReady, run: ((command, options) => runExternalCommand(command, { ...options, signal, maintenance:true, maintenanceToken:MAINTENANCE_EXECUTION })) as typeof runExternalCommand,
    configure: (agent: string, mode: 'free' | 'local' | 'native', model: string, apply: boolean, choice?:ConnectionCandidate) => configure(agent, mode, model, apply, signal,undefined,choice),
    rollback: async (agent: string, mode: 'free' | 'local' | 'native', model: string, backup: string, choice?:ConnectionCandidate) => { await configure(agent, mode, model, false, undefined, backup,choice); },
    discover: (agent: string, workspace: string) => discoverFreeModels(agent, workspace, signal),
    discoverLocal: (baseUrl: string, preferred: string) => discoverLocalModels(baseUrl, preferred, signal), native: configuredAgentModels, localBases:automaticLocalBaseUrls, now: Date.now, ...deps };
  const now = services.now();
  const preference=manualModelPreference(agent.id),storedPreference=readModelPreferences()[agent.id];
  const policyHash = agentConnectionPolicyHash(agent.id);
  const candidate: AgentConnection = { mode: preference?.mode || previous?.mode || (['codex','ollama','lmstudio'].includes(agent.id)?'native':'local'), model: preference?.model || previous?.model || policy.localModel, provider:preference?.provider, status: 'pending', checkedAt: new Date(now).toISOString(), expiresAt: new Date(now).toISOString(), fingerprint: '', policyHash, cliVersion: agent.version };
  if (isAgentExecuting(agent.id)) return previous?.status === 'verified' && Date.parse(previous.expiresAt) > now ? previous : { ...candidate, reason: 'エージェントの実行中は接続設定の保守を延期します。' };
  // 期限付き実行許可を専用領域だけに付与できるよう、ランダムな子領域を使います。
  const connectionRoot = maintenanceWorkspaces().connection;
  await mkdir(connectionRoot, { recursive: true });
  const workspace = await mkdtemp(path.join(connectionRoot, 'probe-'));
  try {
    candidate.stage = 'cli';
    if (agent.liveState !== 'healthy') throw new Error('CLIの生存確認が成功していません。');
    if(preference&&!preference.model)return{...candidate,status:'failed',reason:'モデル固定が有効です。使用するモデルを選択してください。',expiresAt:new Date(now+policy.retryAfterMs).toISOString()};
    candidate.stage = 'settings';
    const warnings:string[]=[];
    // 旧設定を読めない場合も、独立した候補の発見まで止めません。適用前の検査は候補ごとに必須です。
    let existing:Awaited<ReturnType<ConnectionMaintenanceDependencies['configure']>>|undefined;
    try{existing=await services.configure(agent.id,candidate.mode,candidate.model,false,previous||preference);candidate.fingerprint=existing.fingerprint;}
    catch(error){if(signal?.aborted||(error as {termination?:{verifiedStopped?:boolean}})?.termination?.verifiedStopped===false||failureReason(error).includes('並行変更'))throw error;warnings.push(failureReason(error));}
    if (existing && previous && previous.policyHash === policyHash && previous.cliVersion === agent.version) {
      const plan = existing;
      // 保留でpendingへ戻った記録は、以前の成功期限が残っていても再利用しません。
      // モデルのロード状態や接続先の解決が回復したら、次回確認で復帰できるようにします。
      if (previous.status !== 'pending' && !previous.maintenanceDeferred && !services.skipCandidates?.includes(connectionCandidateKey(previous))&&plan.fingerprint === previous.fingerprint && (previous.status === 'failed' || !plan.changedFiles.length) && Date.parse(previous.expiresAt) > now) return previous;
    }
    candidate.stage = 'discovery';
    const discovered:ConnectionCandidate[]=[];
    if(preference)discovered.push(preference);
    else{
      // 一つの一覧取得が失敗しても、別の認可済み接続口の確認を継続します。
      const hosted=agent.id==='ollama'||agent.id==='lmstudio';
      const results=await Promise.allSettled([
        services.discover(agent.id,workspace),services.native(agent.id,signal),
        ...(agent.id==='codex'||agent.id==='ollama'?[]:services.localBases().map(async baseUrl=>(await services.discoverLocal(baseUrl,storedPreference?.model||policy.localModel)).map(model=>({mode:hosted?'native' as const:'local' as const,model,baseUrl,...(Object.values(readModelPreferences()).some(value=>value.source==='wentian'&&value.baseUrl===baseUrl)?{source:'wentian' as const}:{})}))))
      ]);
      signal?.throwIfAborted();
      for(const result of results)if(result.status==='rejected')warnings.push(failureReason(result.reason));
      const available=results[0].status==='fulfilled'?results[0].value as string[]|undefined:undefined;
      if(!hosted&&agent.id!=='codex')for(const model of available||[])if(isFreeAgentModel(agent.id,model))discovered.push({mode:'free',model});
      const native=results[1].status==='fulfilled'?results[1].value as Array<{model:string;provider?:string}>:[];
      for(const value of native)discovered.push({mode:'native',...value,...(agent.id==='lmstudio'?{baseUrl:storedPreference?.baseUrl||process.env.LMSTUDIO_BASE_URL||policy.localBaseUrl}:{})});
      // Codexの読み取り専用一覧は、設定済みのネイティブ接続から取得された候補です。
      if(agent.id==='codex')for(const model of available||[])discovered.push({mode:'native',model,provider:native[0]?.provider});
      for(const result of results.slice(2))if(result.status==='fulfilled')discovered.push(...result.value as ConnectionCandidate[]);
    }
    if(warnings.length)candidate.discoveryWarning=[...new Set(warnings)].join(' ').slice(0,1000);
    const priorAttempts=previous?.policyHash===policyHash&&previous.cliVersion===agent.version?previous.attempts||[]:[];
    const last=new Map(priorAttempts.filter(item=>item.mode).map(item=>[connectionCandidateKey(item as ConnectionCandidate),item]));
    let models=[...new Map(discovered.filter(value=>/^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]{0,255}$/.test(value.model)&&(!value.provider||/^[a-zA-Z0-9_.-]{1,128}$/.test(value.provider))&&!['wentian-auto/','wentian-agent/','external/'].some(prefix=>value.model.startsWith(prefix))).map(value=>[connectionCandidateKey(value),value])).values()]
      .filter(value=>!services.skipCandidates?.includes(connectionCandidateKey(value)))
      .filter(value=>preference||!last.get(connectionCandidateKey(value))?.retryAt||Date.parse(last.get(connectionCandidateKey(value))!.retryAt!)<=now)
      .sort((a,b)=>{const order=(value:ConnectionCandidate)=>{const attempt=last.get(connectionCandidateKey(value));return attempt?.status==='failed'?Date.parse(attempt.checkedAt||'')||1:0};return order(a)-order(b)})
      .slice(0,preference?1:policy.maxCandidates*2);
    if (services.selectCandidates && models.length) {
      const permitted = new Map(models.map(choice => [connectionCandidateKey(choice), choice]));
      const selected = await services.selectCandidates(models, { priorAttempts, discoveryWarning: candidate.discoveryWarning, fixedModel: Boolean(preference) });
      if (!selected.length || selected.some(choice => !permitted.has(connectionCandidateKey(choice)))) throw new Error('AI保守の候補選択が許可されたモデル一覧に一致しません。');
      // AIの返却オブジェクトを直接適用せず、検証前のホスト側候補を使います。
      models = [...new Set(selected.map(connectionCandidateKey))].map(key => permitted.get(key)!);
    }
    candidate.attempts = priorAttempts.slice(-48);
    if(!models.length)candidate.reason='実在するモデル候補を確認できないか、確認済みの候補が再試行待ちです。接続先・認証・モデル一覧を自動で再確認します。';
    const probeStarted=services.now();
    for (const choice of models) {
      // 一つのAgentが候補数倍の応答待ち時間を占有しないよう、接続確認の時間枠を共有します。
      const remaining=policy.probeTimeoutMs-(services.now()-probeStarted);
      if(remaining<=0){candidate.reason='今回の接続確認の時間枠を使い切りました。未試行候補は次回の保守で確認します。';break;}
      const model=choice.model;
      delete candidate.maintenanceDeferred;
      delete candidate.maintenanceDeferredKind;
      if (signal?.aborted) throw new Error('保守処理を中断しました。');
      candidate.model = model;
      candidate.mode=choice.mode;candidate.provider=choice.provider;candidate.baseUrl=choice.baseUrl;candidate.source=choice.source;
      candidate.stage = 'settings';
      let plan:Awaited<ReturnType<ConnectionMaintenanceDependencies['configure']>>|undefined;
      const token = `WENTIAN_CONNECTION_OK_${agent.id.toUpperCase()}`;
      try {
        // 設定変更や推論要求を送る前に、コールドロードが発生しない候補だけ許可します。
        await services.admit(agent.id, candidate, signal);
        plan=await services.configure(agent.id,candidate.mode,model,true,choice);candidate.fingerprint=plan.fingerprint;
        candidate.stage = 'probe';
        const command = connectionProbeCommand(agent.id, candidate, workspace, token);
        await services.admit(agent.id,candidate,signal);
        const output = await services.run(command, { cwd: workspace, timeoutMs: remaining, idleTimeoutMs: remaining, agent: agent.id, role: 'connection-probe' });
        const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
        // コマンドのエコーやエラーメッセージ内のトークンを成功と誤認しません。
        if (/API Error|Model not found|Unauthorized|Ran into this error|Server error|<tool_call>|<Bash\b/i.test(clean)) throw Object.assign(new Error('接続検査でCLIがエラーを返しました。'),{diagnostic:clean});
        if (!clean.split(/\r?\n/).some(line => line.trim() === token)) throw new Error('指定した確認応答を受信できませんでした。');
        // CLI自身が設定を正規化した場合も、成功後の実設定の指紋を保存します。
        candidate.fingerprint = (await services.configure(agent.id, candidate.mode, model, false,choice)).fingerprint;
        candidate.attempts.push({ ...choice, status: 'verified',phase:'connection',checkedAt:new Date(services.now()).toISOString() });candidate.attempts=candidate.attempts.slice(-48);
        return { ...candidate, status: 'verified', expiresAt: new Date(services.now() + policy.cacheTtlMs).toISOString(), reason: `${candidate.discoveryWarning?'一部の設定・一覧取得に失敗しましたが、別の候補で確認を継続しました。 ':''}${candidate.mode === 'free' ? '無料モデル' : candidate.mode === 'native' ? 'Agent提供モデル' : 'Wentian/ローカルLLM'}の設定・実応答を確認しました。` };
      } catch (error) {
        if (error instanceof ExecutionDenied) {
          if (plan?.backup) await services.rollback(agent.id,candidate.mode,model,plan.backup,choice);
          return {...candidate,status:'pending',maintenanceDeferred:true,maintenanceDeferredKind:'permission',reason:error.message,expiresAt:new Date(services.now()+policy.retryAfterMs).toISOString()};
        }
        if (error instanceof MaintenanceModelDeferred) {
          if (plan?.backup) await services.rollback(agent.id,candidate.mode,model,plan.backup,choice);
          candidate.maintenanceDeferred=true;candidate.maintenanceDeferredKind='model';candidate.reason=error.message;
          // 推論していない候補を接続失敗や作業失敗として記録しません。
          continue;
        }
        // 残存プロセスを確認できない場合は次モデルを起動しません。
        if ((error as { termination?: { verifiedStopped?: boolean } })?.termination?.verifiedStopped === false) throw error;
        if(failureReason(error).includes('並行変更'))throw error;
        // 未成功モデルを通常設定へ残さず、試験前の接続設定へ戻します。
        if (plan?.backup) { candidate.stage = 'rollback'; await services.rollback(agent.id, candidate.mode, model, plan.backup,choice); }
        if (signal?.aborted) throw error;
        if(plan)candidate.fingerprint = (await services.configure(agent.id, candidate.mode, model, false,choice)).fingerprint;
        candidate.reason = failureReason(error);
        // 詳細は秘密値を除去した保守専用領域へ保存し、一般の一覧には分類済みの理由だけを出します。
        const diagnosticRoot=path.join(path.dirname(connectionStorePath()),'connection-diagnostics');await mkdir(diagnosticRoot,{recursive:true});
        await writeFile(path.join(diagnosticRoot,agent.id+'.json'),JSON.stringify({checkedAt:new Date().toISOString(),stage:candidate.stage,model,reason:candidate.reason,diagnostic:redactTrainingText(String((error as {diagnostic?:string}).diagnostic||(error as Error).message||error)).slice(-12000)},null,2));
        candidate.attempts.push({ ...choice, status: 'failed', phase:'connection',reason: candidate.reason,checkedAt:new Date(services.now()).toISOString(),retryAt:new Date(services.now()+policy.retryAfterMs).toISOString() });candidate.attempts=candidate.attempts.slice(-48);
      }
    }
  } catch (error) {
    if ((error as { termination?: { verifiedStopped?: boolean } })?.termination?.verifiedStopped === false || signal?.aborted) throw error;
    candidate.reason = failureReason(error);
  }
  finally { await rm(workspace, { recursive: true, force: true,maxRetries:10,retryDelay:200 }); }
  return { ...candidate, status: candidate.maintenanceDeferred ? 'pending' : 'failed', expiresAt: new Date(services.now() + policy.retryAfterMs).toISOString() };
}

let maintenanceQueue: Promise<unknown> = Promise.resolve();
/** サイクル間は排他し、サイクル内ではリソース制約に従ってAgentを並行保守します。 */
export function maintainAgentConnections(agents: ExternalAgentStatus[], onUpdate?: (agent: ExternalAgentStatus) => Promise<void>, signal?: AbortSignal, dependencies: {
  connect?: typeof maintainAgentConnection; work?: typeof verifyAgentWork; install?:typeof maintainAgentInstallation;
  admit?: typeof assertMaintenanceModelReady;
  selectCandidates?: ConnectionMaintenanceDependencies['selectCandidates'];
  autoInstall?: boolean; verifyWork?: boolean; forceConnection?: boolean; forceWork?: boolean; resources?: typeof measureMaintenanceResources; onActivity?: (ids: string[]) => void;
} = {}): Promise<ExternalAgentStatus[]> {
  const job = maintenanceQueue.then(async () => {
    const release=acquireAgentMaintenanceLease(path.join(path.dirname(connectionStorePath()),'connection-maintenance.sqlite'));
    if(!release)throw new Error('別プロセスが保守を実行中です。次回確認で再試行します。');
    try{
    const store = readAgentConnections();
    // 復旧待ちを先に処理し、既に接続できているAgentの重い再検証で全件の復旧を塞ぎません。
    // 同じ段階では利用者指定の優先順を維持します。未導入CLIの導入は接続復旧の後です。
    const phase=(agent:ExternalAgentStatus)=>agent.liveState!=='healthy'?2:store[agent.id]?.status==='verified'?1:0;
    agents=orderAgents(agents).sort((a,b)=>phase(a)-phase(b));
    const installed=new Map<string,ExternalAgentStatus>();
    // Agentごとに導入・接続・作業検証を連続実行します。別Agentの完了を待ちません。
    // 共有接続台帳の読取り・原子的保存だけは直列化し、並行更新の欠落を防ぎます。
    let saving: Promise<void> = Promise.resolve();
    const active = new Set<string>();
    await runResourceLimited(agents.filter(agent => managedAgentIds.includes(agent.id) && agentNotExcluded(agent)), async initial => {
      active.add(initial.id); dependencies.onActivity?.([...active]);
      try {
      let agent = initial;
      if (dependencies.autoInstall !== false) agent = await (dependencies.install || maintainAgentInstallation)(agent, onUpdate, signal);
      installed.set(agent.id,agent);
      if (agent.liveState !== 'healthy' || signal?.aborted || !agentNotExcluded(agent)) return;
      const selectionRevision=JSON.stringify(readModelPreferences()[agent.id]);
      const skipped:string[]=[];
      for(let recovery=0;recovery<(manualModelPreference(agent.id)?1:connectionPolicy().maxCandidates);recovery++){
      if(signal?.aborted||selectionRevision!==JSON.stringify(readModelPreferences()[agent.id]))return;
      const existingConnection = store[agent.id];
      // 有効期限内の接続確認を毎回やり直すと、後段の状態更新で合格済み証跡が一時的に外れます。
      // 接続記録が有効ならそのまま能力検証段階へ進み、設定変更または期限切れ時だけ再接続します。
      const selectedModel = manualModelPreference(agent.id);
      const reuseConnection = (!dependencies.forceConnection && existingConnection?.status === 'verified' && Date.parse(existingConnection.expiresAt) > Date.now()
        && existingConnection.policyHash===agentConnectionPolicyHash(agent.id)&&existingConnection.cliVersion===agent.version
        && !skipped.includes(connectionCandidateKey(existingConnection))&&(!selectedModel || (selectedModel.mode === existingConnection.mode && selectedModel.model === existingConnection.model&&selectedModel.provider===existingConnection.provider)));
      if (!reuseConnection) {
        await onUpdate?.({...agent,state:'needs_recheck',stateLabel:'接続確認中',note:'接続設定・実モデルの応答を自動確認しています。',connection:{...(store[agent.id]||{mode:'local',model:connectionPolicy().localModel,fingerprint:'',policyHash:''}),status:'pending',checkedAt:new Date().toISOString(),expiresAt:new Date().toISOString()}});
        store[agent.id] = await (dependencies.connect || maintainAgentConnection)(agent, store[agent.id], {skipCandidates:skipped,admit:dependencies.admit || assertMaintenanceModelReady,selectCandidates:dependencies.selectCandidates}, signal);
        // 接続確認中に利用者がモデルを選び直した場合、古い結果で新しい選択を上書きしません。
        if (signal?.aborted || !agentNotExcluded(agent) || selectionRevision !== JSON.stringify(readModelPreferences()[agent.id])) {
          store[agent.id] = readAgentConnections()[agent.id];
          return;
        }
        // 長い全件確認の途中でも、完了した候補の結果をCLIと共有します。
        saving = saving.then(async () => {
          if(signal?.aborted||selectionRevision!==JSON.stringify(readModelPreferences()[agent.id]))return;
          const target = connectionStorePath(); await mkdir(path.dirname(target), { recursive: true });
          const temporary = `${target}.${process.pid}.tmp`;
          await writeFile(temporary, JSON.stringify({ version: '1.0', agents: { ...readAgentConnections(), [agent.id]: store[agent.id] } }, null, 2), 'utf8');
          if(signal?.aborted||selectionRevision!==JSON.stringify(readModelPreferences()[agent.id])){await rm(temporary,{force:true});return;}
          await renameWithRetry(temporary, target);
        });
        await saving;
        const connection = store[agent.id];
        await onUpdate?.(connectionStatusUpdate(agent, connection, readWorkEvidence()[agent.id]));
      }
      if (signal?.aborted || dependencies.verifyWork === false || !agentNotExcluded(agent)) return;
      const connection = store[agent.id];
      if (!connection || connection.status !== 'verified' || Date.parse(connection.expiresAt) <= Date.now()) return;
      // 期限内の接続記録でも、モデルが退避済みなら作業検証で再ロードしません。
      const deferWork = async (error: MaintenanceModelDeferred | ExecutionDenied) => {
        if (signal?.aborted || selectionRevision!==JSON.stringify(readModelPreferences()[agent.id])) return;
        connection.status='pending';connection.maintenanceDeferred=true;connection.maintenanceDeferredKind=error instanceof ExecutionDenied?'permission':'model';connection.reason=error.message;
        saving=saving.then(async()=>{
          if (signal?.aborted || selectionRevision!==JSON.stringify(readModelPreferences()[agent.id])) return;
          const target=connectionStorePath();await mkdir(path.dirname(target),{recursive:true});
          const temporary=`${target}.${process.pid}.tmp`;
          await writeFile(temporary,JSON.stringify({version:'1.0',agents:{...readAgentConnections(),[agent.id]:connection}},null,2),'utf8');
          await renameWithRetry(temporary,target);
        });await saving;
        await onUpdate?.(connectionStatusUpdate(agent,connection,readWorkEvidence()[agent.id]));
      };
      try { await (dependencies.admit || assertMaintenanceModelReady)(agent.id,connection,signal); }
      catch (error) { if (!(error instanceof MaintenanceModelDeferred)) throw error; await deferWork(error); return; }
      if (signal?.aborted || selectionRevision!==JSON.stringify(readModelPreferences()[agent.id])) return;
      const selected = manualModelPreference(agent.id);
      if (selected && (selected.model !== connection.model || selected.mode !== connection.mode||selected.provider!==connection.provider)) return;
      const prior=readWorkEvidence()[agent.id];
      if(!prior||prior.identity!==workIdentity(connection,agent.version)||Date.parse(prior.status==='passed'?prior.expiresAt:prior.retryAt)<=Date.now())await onUpdate?.({...connectionStatusUpdate(agent,connection,prior),stateLabel:'実作業検証中',note:'隔離した作業場所で実ファイル読取り・役割別検証を実行しています。'});
      let workEvidence: AgentWorkEvidence;
      try {
        workEvidence = await (dependencies.work || verifyAgentWork)({ ...agent, connection, state: 'available' }, signal, async (command, options) => {
          await (dependencies.admit || assertMaintenanceModelReady)(agent.id,connection,options.signal);
          return runExternalCommand(command,{...options,maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION});
        }, { force: dependencies.forceWork });
      } catch (error) { if (!(error instanceof MaintenanceModelDeferred) && !(error instanceof ExecutionDenied)) throw error; await deferWork(error); return; }
      if(signal?.aborted||selectionRevision!==JSON.stringify(readModelPreferences()[agent.id]))return;
      await onUpdate?.(connectionStatusUpdate(agent, connection, workEvidence));
      if(workEvidence.status==='passed'||selected||workEvidence.failureKind==='unsafe_process')break;
      // 接続だけ通るモデルへ固着せず、実作業が失敗した候補を冷却して別候補を検証します。
      skipped.push(connectionCandidateKey(connection));
      connection.attempts=[...(connection.attempts||[]),{model:connection.model,mode:connection.mode,provider:connection.provider,baseUrl:connection.baseUrl,status:'failed',phase:'work',reason:workEvidence.reason,checkedAt:new Date().toISOString(),retryAt:workEvidence.retryAt}].slice(-48) as AgentConnection['attempts'];
      saving=saving.then(async()=>{const target=connectionStorePath();await mkdir(path.dirname(target),{recursive:true});const temporary=`${target}.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify({version:'1.0',agents:{...readAgentConnections(),[agent.id]:connection}},null,2),'utf8');await renameWithRetry(temporary,target)});await saving;
      }
      } finally { active.delete(initial.id); dependencies.onActivity?.([...active]); }
    }, signal, dependencies.resources);
    return agents.map(initial => {
      const agent=installed.get(initial.id)||initial;
      const connection = store[agent.id];
      if (!connection) return agent;
      const workEvidence = readWorkEvidence()[agent.id];
      return connectionStatusUpdate(agent, connection, workEvidence);
    });
    }finally{release();}
  });
  maintenanceQueue = job.catch(() => {});
  return job;
}
