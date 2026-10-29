import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { existsSync, readFileSync, renameSync, writeFileSync,mkdirSync } from 'node:fs';
import path from 'node:path';
import { AGENT_CATALOG, probeAgentCli } from './agent-marketplace.js';
import { buildExternalAgentCommand, isAgentExecuting } from './external-orchestrator.js';
import { loadAgentSelectionConfig } from './agent-selection.js';
import { readWorkEvidence, workCachePath, workIdentity, type AgentWorkEvidence } from './agent-work-policy.js';
import { redactCommandArguments } from './agent-command-line.js';
import { connectionStatusUpdate } from './agent-connection-maintenance.js';
import { readAgentConnections, connectionStorePath } from './agent-connection-policy.js';
import { agentModelChoices, readModelPreferences, saveModelPreference, manualModelPreference, setManualModelSelection } from './agent-model-selection.js';
import { agentRegistered, readAgentExclusionsSync, setAgentExclusion, setAgentRegistration } from './agent-exclusion-policy.js';
import { registerManualAgent, deleteManualAgent, loadManualAgents } from './manual-agent-registry.js';
import {archiveAgent,restoreAgent,deleteArchivedAgent,readAgentManagement,orderAgents,moveAgentPriority,setForcedAgent} from './agent-management.js';
import {prepareAgentUninstall,executeAgentUninstall} from './agent-uninstall.js';
import {isAgentInstalling,cancelAgentInstallation} from './agent-install-maintenance.js';
import { managedAgentIds } from './agent-connection-policy.js';
import type { ExternalAgentSnapshot, ExternalAgentStatus } from './external-agents.js';
import { performanceScore } from './agent-performance.js';
import { executionAccessSummary } from './execution-governance.js';

/** PowerShell（パワーシェル / PowerShell）の単一引用符で、CLI名を安全にそのまま実行します。 */
export function agentHealthCheckCommand(cli: string): string {
  return `& '${cli.replace(/'/g, "''")}' --version`;
}

/** 旧形式の失敗記録にCLI引数がない場合は、当時の証跡を直接確認するコマンドを示します。 */
function agentFailureEvidenceCommand(directory: string): string {
  const literal = `'${directory.replace(/'/g, "''")}'`;
  return `$evidence = ${literal}; Get-Content -LiteralPath (Join-Path $evidence 'failure.json') -Raw -Encoding UTF8; Get-ChildItem -LiteralPath $evidence -Recurse -File | Select-Object FullName`;
}

/** 同一のモデル・接続設定である旧証跡に限り、固定済み入力から再実行引数を補完して永続化します。 */
function recoverLegacyWorkCommand(agent: ExternalAgentStatus): AgentWorkEvidence | undefined {
  const evidence = agent.workEvidence;
  const connection = agent.connection;
  if (!evidence?.attentionRequired || evidence.manualCheckCommand || !connection || connection.status !== 'verified'
    || workIdentity(connection, agent.version) !== evidence.identity || !evidence.evidenceDirectory) return evidence;
  const source = path.join(evidence.evidenceDirectory, 'standalone');
  const inputPath = path.join(source, 'input.txt');
  const failurePath = path.join(evidence.evidenceDirectory, 'failure.json');
  if (!existsSync(inputPath) || !existsSync(failurePath)) return evidence;

  const writable = loadAgentSelectionConfig().agentCapabilities[agent.id]?.includes('file_write')
    && Boolean(buildExternalAgentCommand(agent.id, '', source, 'builder', { attempt: 0 }, connection));
  const role = writable ? 'builder' : 'reviewer';
  const prompt = writable
    ? '小さな作業能力試験です。input.txtを実ファイルから読み、output.jsonのvalueだけをその内容へ修正してください。enabledとcustomは維持してください。最後にWENTIAN_WORK_READ:<input.txtの内容>とWENTIAN_ROLE_RESULT: PASSを独立行で報告してください。外部接続、秘密取得、パッケージ導入は禁止です。'
    : '読み取り能力試験です。input.txtを実ファイルから読み、WENTIAN_WORK_READ:<その内容>を独立行で返してください。変更、外部接続、秘密取得は禁止です。';
  const command = buildExternalAgentCommand(agent.id, prompt, source, role, { attempt: 0 }, connection);
  if (!command) return evidence;
  const execution = { executable: command.executable, args: redactCommandArguments(command.args), cwd: source };
  const manualCheckCommand = `$ErrorActionPreference = 'Stop'; Set-Location -LiteralPath '${source.replace(/'/g, "''")}'; & '${execution.executable.replace(/'/g, "''")}' ${execution.args.map(value => `'${value.replace(/'/g, "''")}'`).join(' ')}`;
  const recovered = { ...evidence, manualCheckExecution: execution, manualCheckCommand };
  const mergeFile = (target: string, extra: Record<string, unknown>) => {
    if (!existsSync(target)) return;
    try { writeFileSync(target, JSON.stringify({ ...JSON.parse(readFileSync(target, 'utf8')), ...extra }, null, 2) + '\n', 'utf8'); } catch { /* 不正な既存証跡は上書きしません。 */ }
  };
  mergeFile(failurePath, { manualCheckExecution: execution, manualCheckCommand });
  mergeFile(path.join(evidence.evidenceDirectory, 'result.json'), { manualCheckExecution: execution, manualCheckCommand });
  try {
    const current = readWorkEvidence();
    const temporary = `${workCachePath()}.${process.pid}.recovery.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, agents: { ...current, [agent.id]: recovered } }, null, 2) + '\n', 'utf8');
    renameSync(temporary, workCachePath());
  } catch { /* キャッシュ更新に失敗しても、証跡ファイルの追記結果は保持します。 */ }
  return recovered;
}

/** 永続的な使用禁止は、古いスナップショット（Snapshot）の表示より常に優先します。 */
export function decorateAgentSnapshot<T extends ExternalAgentSnapshot>(snapshot: T): T {
  const exclusions = readAgentExclusionsSync();
  const savedConnections = readAgentConnections();
  const savedWork = readWorkEvidence();
  const forcedAgent = readAgentManagement().forcedAgent;
  let access:ReturnType<typeof executionAccessSummary>|undefined;
  try{access=executionAccessSummary();}catch{/* 不正な台帳は既定許可と表示しません。 */}
  const agents = orderAgents(snapshot.agents.filter(agent => agentRegistered(agent.id))).map((agent,index) => {
    const excluded = Boolean(exclusions[agent.id]);
    const score = performanceScore(agent.id, 'conversation');
    // 別プロセスの wentian agents verify が更新した保存証跡を、サーバーの古いメモリー上のSnapshotより優先します。
    const connection = savedConnections[agent.id] || agent.connection;
    const persistedEvidence = savedWork[agent.id] || agent.workEvidence;
    const current = connection
      ? connectionStatusUpdate({ ...agent, connection }, connection, persistedEvidence)
      : managedAgentIds.includes(agent.id) ? { ...agent, workEvidence:persistedEvidence, state:'needs_recheck' as const, stateLabel:'接続確認待ち', note:'CLIの起動確認とモデルの実応答検証は別です。モデルの接続確認は未完了です。' } : { ...agent, workEvidence: persistedEvidence };
    const workEvidence = recoverLegacyWorkCommand(current);
    const manualWorkCheck = Boolean(workEvidence?.attentionRequired);
    const failureCommand = manualWorkCheck
      ? workEvidence?.manualCheckCommand || agentFailureEvidenceCommand(workEvidence?.evidenceDirectory || '')
      : undefined;
    return { ...current, executionAccess:{maintenance:Boolean(access?.maintenanceDefault&&!access.revokedAgents.includes(agent.id)),revoked:Boolean(access?.revokedAgents.includes(agent.id)),policyError:!access}, manualModel:Boolean(manualModelPreference(agent.id)), priority:index+1, excluded, forceUse: agent.id === forcedAgent, currentScore: Number.isFinite(score) ? score : null, scoreCoolingDown: score === Number.NEGATIVE_INFINITY,
      ...(workEvidence ? { workEvidence } : {}),
      healthCheckCommand: failureCommand || agentHealthCheckCommand(agent.cli || agent.id),
      healthCheckLabel: manualWorkCheck
        ? workEvidence?.manualCheckCommand ? '失敗した実行ファイル・CLI引数を含む再実行コマンド（認証情報は伏字）' : '失敗当時のCLI引数は未記録です。保存済みの失敗証跡を確認するコマンド'
        : 'PowerShell 状態確認コマンド（CLI生存確認）',
      stateLabel: excluded ? '一時停止' : current.stateLabel,
      note: excluded ? `一時停止により自動接続保守・作業検証を停止しています。直近の結果: ${current.note}` : current.note };
  });
  const summary = { available: 0, candidate: 0, needs_recheck: 0, unavailable: 0, total: agents.length };
  for (const agent of agents) summary[agent.state]++;
  // 原因は自由記述のキーワードで推測せず、実測状態と検証台帳の構造から集計します。
  const availabilityBlockers = {paused:0,cli:0,permission:0,model:0,connection:0,work:0};
  for(const agent of agents) {
    if(agent.excluded) availabilityBlockers.paused++;
    else if(agent.liveState !== 'healthy') availabilityBlockers.cli++;
    else if(agent.connection?.maintenanceDeferredKind === 'permission') availabilityBlockers.permission++;
    else if(agent.connection?.maintenanceDeferredKind === 'model') availabilityBlockers.model++;
    else if(agent.connection?.status !== 'verified' || Date.parse(agent.connection.expiresAt) <= Date.now()) availabilityBlockers.connection++;
    else if(agent.state !== 'available') availabilityBlockers.work++;
  }
  return { ...snapshot, agents, summary, availabilityBlockers };
}

/** 指定行だけのCLI生存確認です。モデル応答・実作業の合格記録は変更しません。 */
export async function recheckAgent(agent: ExternalAgentStatus, probe = probeAgentCli): Promise<ExternalAgentStatus> {
  const live = await probe({ cli: agent.cli || agent.id });
  const state = live.liveState === 'healthy' ? 'available' : live.liveState === 'not_installed' ? 'unavailable' : 'needs_recheck';
  return { ...agent, state, stateLabel: state === 'available' ? '利用可能' : state === 'unavailable' ? 'CLI未検出' : '要再確認',
    liveState: live.liveState, version: live.version, latencyMs: live.latencyMs, probeError: live.probeError,
    lastObservedAt: live.checkedAt, ageHours: 0, freshWithin24Hours: true,
    note: live.liveState === 'healthy' ? 'CLIの生存確認に成功しました。モデル応答・実作業能力は別途確認が必要です。' : live.probeError || 'CLIを検出できませんでした。',
    evidence: `CLI --version: ${live.liveState}`, healthCheckCommand: agentHealthCheckCommand(agent.cli || agent.id) };
}

/** 管理者が行単位で確認・使用可否を変更するAPI（エーピーアイ / API）です。 */
export function registerAgentRowControls(app: FastifyInstance, options: {
  snapshot: () => Promise<ExternalAgentSnapshot>;
  update: (agent: ExternalAgentStatus) => Promise<void>;
  authorize: (req: FastifyRequest, reply: FastifyReply) => string | undefined;
  probe?: typeof probeAgentCli;
  models?: () => Promise<Array<{ id: string; name?: string }>>;
  gatewayUrl?: () => string;
  maintain?: (agentId: string) => void;
  cancelMaintenance?: (agentId: string) => void;
  modelChoices?: typeof agentModelChoices;
}) {
  // 同時の変更を直列化し、使用禁止設定を相互に上書きしないようにします。
  let pending = Promise.resolve();
  app.post('/v1/manager/external-agents/:id/model-selection',async(req,reply)=>{
    if(!options.authorize(req,reply))return reply;
    const id=String((req.params as {id:string}).id),manual=(req.body as {manual?:unknown}|null)?.manual;
    if(typeof manual!=='boolean')return reply.code(400).send({error:{message:'モデル固定の有効・無効を指定してください。'}});
    const agent=(await options.snapshot()).agents.find(item=>item.id===id&&agentRegistered(id));
    if(!agent||!managedAgentIds.includes(id))return reply.code(404).send({error:{message:'モデル選択に対応するAgentが見つかりません。'}});
    const result=pending.then(async()=>{
      if(isAgentExecuting(id)||isAgentInstalling(id)||!agentRegistered(id))return reply.code(409).send({error:{message:'Agentが処理中です。処理終了後に切り替えてください。'}});
      options.cancelMaintenance?.(id);
      setManualModelSelection(id,manual);
      // 方針変更時に旧モデルの認定を使い回さず、最新の方針で一通り確認します。
      const store=readAgentConnections(),previous=store[id]||agent.connection;
      if(previous){const connection={...previous,status:'pending' as const,expiresAt:new Date().toISOString(),policyHash:'',reason:manual?'指定モデルの検証を待っています。':'実在する候補からモデルを自動選択し、接続・実作業を検証します。'};store[id]=connection;
        const target=connectionStorePath(),temporary=`${target}.${process.pid}.selection.tmp`;mkdirSync(path.dirname(target),{recursive:true});writeFileSync(temporary,JSON.stringify({version:'1.0',agents:store},null,2)+'\n','utf8');renameSync(temporary,target);await options.update(connectionStatusUpdate(agent,connection));}
      options.maintain?.(id);
      return decorateAgentSnapshot(await options.snapshot());
    });
    pending=result.then(()=>undefined,()=>undefined);return result;
  });
  app.get('/v1/manager/external-agents/:id/models', async (req, reply) => {
    const id = String((req.params as { id: string }).id);
    const agent = (await options.snapshot()).agents.find(item => item.id === id && agentRegistered(id));
    if (!agent || !managedAgentIds.includes(id)) return reply.code(404).send({ error: { message: 'モデル選択に対応する登録済みエージェントが見つかりません。' } });
    const available = await (options.modelChoices || agentModelChoices)(id, await options.models?.().catch(()=>[]) || [], (req.query as {refresh?:string})?.refresh==='true');
    return { ...available, current: readAgentConnections()[id]?.model || agent.connection?.model, selected: readModelPreferences()[id] };
  });
  app.post('/v1/manager/external-agents/:id/models', async (req, reply) => {
    if (!options.authorize(req, reply)) return reply;
    const id = String((req.params as { id: string }).id);
    const agent = (await options.snapshot()).agents.find(item => item.id === id && agentRegistered(id));
    if (!agent || !managedAgentIds.includes(id)) return reply.code(404).send({ error: { message: '登録されたエージェントが見つかりません。' } });
    if(!manualModelPreference(id))return reply.code(409).send({error:{message:'モデル固定を有効にしてからモデルを変更してください。'}});
    if (isAgentExecuting(id) || isAgentInstalling(id)) return reply.code(409).send({ error: { message: 'Agentが処理中です。処理終了後にモデルを変更してください。' } });
    const body=req.body as {choice?:string;nativeModel?:string;provider?:string};
    const available = body?.nativeModel?{choices:[]}:await (options.modelChoices || agentModelChoices)(id, await options.models?.().catch(()=>[]) || []);
    const manual=typeof body?.nativeModel==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]{0,255}$/.test(body.nativeModel)
      &&(body.provider===undefined||body.provider===''||/^[a-zA-Z0-9_.-]{1,128}$/.test(body.provider));
    const choice = body?.nativeModel ? manual?{id:'other:'+body.nativeModel,source:'other' as const,mode:'native' as const,model:body.nativeModel,label:body.nativeModel,...(body.provider?{provider:body.provider}:{})}:undefined
      : available.choices.find(value => value.id === body?.choice);
    if (!choice) return reply.code(400).send({ error: { message: '現在の選択候補からモデルを選んでください。' } });
    const result = pending.then(async () => {
      if (isAgentExecuting(id) || !agentRegistered(id)||!manualModelPreference(id)) throw new Error('Agentの状態が変わりました。処理終了後に再選択してください。');
      saveModelPreference(id, { manual:true, source: choice.source, mode: choice.mode, model: choice.model, ...(choice.provider?{provider:choice.provider}:{}),
        ...(id === 'lmstudio' && readModelPreferences()[id]?.baseUrl ? {baseUrl:readModelPreferences()[id].baseUrl} : {}),
        ...(choice.source === 'wentian' ? { baseUrl: (options.gatewayUrl?.() || 'http://127.0.0.1:8787') + '/v1' } : {}), selectedAt: new Date().toISOString() });
      // 新しい設定で接続・能力を確認するまで、旧モデルの合格記録を引き継ぎません。
      const store = readAgentConnections();
      const connection = { ...store[id], mode: choice.mode, model: choice.model, provider: choice.provider, status: 'pending' as const,
        checkedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), fingerprint: '', policyHash: '', reason: '選択したモデルの接続・実作業を検証します。' };
      store[id] = connection;
      const target = connectionStorePath();
      const temporary = `${target}.${process.pid}.model.tmp`;
      mkdirSync(path.dirname(target),{recursive:true});
      writeFileSync(temporary, JSON.stringify({ version: '1.0', agents: store }, null, 2) + '\n', 'utf8');
      renameSync(temporary, target);
      await options.update(connectionStatusUpdate(agent, connection));
      options.maintain?.(id);
      return decorateAgentSnapshot(await options.snapshot());
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  });
  app.post('/v1/manager/agent-marketplace/:id/registration', async (req, reply) => {
    if (!options.authorize(req, reply)) return reply;
    const id = String((req.params as { id: string }).id);
    const action = (req.body as { action?: string } | null)?.action;
    const definition = readAgentManagement().uninstalled[id] || AGENT_CATALOG.find(agent => agent.id === id);
    if (!definition) return reply.code(404).send({ error: { message: '候補一覧に存在しないエージェントです。' } });
    if (!['add','remove','delete'].includes(action||'')) return reply.code(400).send({ error: { message: '操作は add / remove / delete を指定してください。' } });
    if(action==='delete'&&(agentRegistered(id)||!readAgentManagement().uninstalled[id]))return reply.code(409).send({error:{message:'解除済みの登録情報だけを削除できます。'}});
    const result = pending.then(async () => {
      if (action === 'add') {
        // 候補はサーバー内のカタログ（Catalog）から取得し、任意の実行コマンドを受け付けません。
        await registerManualAgent({ id: definition.id, name: definition.name, cli: definition.cli, repository: definition.repository, note: definition.note });
        await setAgentRegistration(id, true);
        await restoreAgent(id);
        const previous = (await options.snapshot()).agents.find(agent => agent.id === id);
        await options.update(previous || { id, name: definition.name, cli: definition.cli, state: 'needs_recheck', stateLabel: '要再確認', note: '一覧へ追加しました。CLIの状態を再確認してください。', freshWithin24Hours: false, registration: managedAgentIds.includes(id) ? 'built_in' : 'manual' });
      } else if(action==='delete'){await deleteArchivedAgent(id);await deleteManualAgent(id);}
      else {await archiveAgent(definition);await setAgentRegistration(id, false);}
      return { id, registered: action === 'add', snapshot: decorateAgentSnapshot(await options.snapshot()) };
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  });
  app.post('/v1/manager/external-agents/:id/uninstall-plan',async(req,reply)=>{
    const actor=options.authorize(req,reply);if(!actor)return reply;
    const id=String((req.params as {id:string}).id);
    if(!(await options.snapshot()).agents.some(agent=>agent.id===id&&agentRegistered(id)))return reply.code(404).send({error:{message:'登録されたエージェントが見つかりません。'}});
    return prepareAgentUninstall(id,actor);
  });
  app.post('/v1/manager/external-agents/:id/control', async (req, reply) => {
    const actor = options.authorize(req, reply);
    if (!actor) return reply;
    const id = String((req.params as { id: string }).id);
    const action = (req.body as { action?: string } | null)?.action;
    if (!['recheck', 'prohibit', 'allow','pause','resume','up','down','uninstall','force','unforce'].includes(action || '')) return reply.code(400).send({ error: { message: '不明な操作です。' } });
    const agent = (await options.snapshot()).agents.find(item => item.id === id && agentRegistered(id));
    if (!agent) return reply.code(404).send({ error: { message: '登録されたエージェントが見つかりません。' } });
    const perform = async () => {
      if(!agentRegistered(id))throw new Error('登録が解除されています。');
      if (action === 'recheck') {
        await options.update(await recheckAgent(agent, options.probe));
        if (managedAgentIds.includes(id) && !readAgentExclusionsSync()[id]) options.maintain?.(id);
      }
      else if(action==='force'||action==='unforce')await setForcedAgent(id,action==='force');
      else if(action==='up'||action==='down')await moveAgentPriority(id,action,decorateAgentSnapshot(await options.snapshot()).agents.map(item=>item.id));
      else if(action==='uninstall'){
        if(isAgentExecuting(id)||isAgentInstalling(id))throw new Error('エージェントは実行または導入中です。一時停止し、処理終了後に解除してください。');
        const body=req.body as {scope?:string;token?:string};
        if(!['wentian','cli'].includes(body.scope||''))throw new Error('削除範囲を選択してください。');
        if(body.scope==='cli')await executeAgentUninstall(id,actor,String(body.token||''));
        const definition=(await loadManualAgents()).find(item=>item.id===id)||AGENT_CATALOG.find(item=>item.id===id)||{id,name:agent.name,cli:agent.cli||id};
        await archiveAgent(definition);await setAgentRegistration(id,false);
      }
      else {
        const paused = action === 'prohibit'||action==='pause';
        await setAgentExclusion(id, paused, actor);
        if(paused){cancelAgentInstallation(id);options.cancelMaintenance?.(id);}
        else if(managedAgentIds.includes(id))options.maintain?.(id);
      }
      return decorateAgentSnapshot(await options.snapshot());
    };
    const result = pending.then(perform);
    pending = result.then(() => undefined, () => undefined);
    return result;
  });
}
