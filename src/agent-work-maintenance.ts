import { redactTrainingText } from './training-data.js';
import { MAINTENANCE_EXECUTION } from './maintenance-execution.js';
import { MaintenanceResourcePause } from './maintenance-resources.js';
import { loadAcceptancePlan as loadTrustedAcceptancePlan } from './acceptance-verification.js';
import { ExecutionDenied } from './execution-governance.js';
import { MaintenanceModelDeferred } from './maintenance-model-admission.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { buildExternalAgentCommand, isAgentExecuting, orchestrateExternalTask, runExternalCommand } from './external-orchestrator.js';
import { resolveAgentExecutable } from './agent-marketplace.js';
import { validateAgentPlan } from './agent-planner.js';
import { loadAgentSelectionConfig } from './agent-selection.js';
import { captureArtifactSnapshot, compareArtifactSnapshots } from './artifact-evidence.js';
import { renameWithRetry } from './atomic-file.js';
import { redactCommandArguments } from './agent-command-line.js';
import type { ExternalAgentStatus } from './external-agents.js';
import { WORK_VERIFICATION_PROBE, classifyWorkFailure, readWorkEvidence, workCachePath, workFailureRetryAt, workIdentity, WORK_ATTENTION_THRESHOLD, type AgentWorkEvidence, type WorkFailureKind } from './agent-work-policy.js';

type Run = typeof runExternalCommand;
/** マーカーの区切り空白は許容し、ホストが用意した入力値との完全一致を検査します。 */
export function hasWorkReadReceipt(output:string,nonce:string):boolean{
  return output.split(/\r?\n/).some(line=>{const value=line.trim();return value.startsWith('WENTIAN_WORK_READ:')&&value.slice('WENTIAN_WORK_READ:'.length).trim()===nonce;});
}
/** Wentianツール対応Agentは、自己申告マーカーではなくホストの実読取記録を検収します。 */
export async function hasHostedWorkReadReceipt(workspace: string, agent: string, role: string, nonce: string): Promise<boolean> {
  const directory=path.join(workspace,'.wentian','hosted-agent');
  for(const name of await readdir(directory).catch(()=>[] as string[])) {
    if(!name.endsWith(`-${role}.json`))continue;
    try {
      const value=JSON.parse(await readFile(path.join(directory,name),'utf8'));
      if(value.agent!==agent||value.role!==role||!Array.isArray(value.history))continue;
      if(value.history.some((entry:any)=>entry.decision?.kind==='tool'&&entry.decision.name==='read_file'
        &&typeof entry.decision.arguments?.path==='string'&&path.resolve(workspace,entry.decision.arguments.path)===path.resolve(workspace,'input.txt')&&entry.result===nonce))return true;
    } catch { /* 不正な記録を実読取として採用しません。 */ }
  }
  return false;
}
/** PowerShellの単一引用符で囲み、失敗したCLI呼出しをそのまま再現できる形にします。 */
function quotePowerShell(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function manualCommand(executable: string, args: string[], cwd: string): string {
  return `Set-Location -LiteralPath ${quotePowerShell(cwd)}; & ${[executable, ...redactCommandArguments(args)].map(quotePowerShell).join(' ')}`;
}
/** 同一の設定識別子で過去にホスト検収を通過した単体試験を、Wentian側再試験へ引き継ぎます。 */
async function reusableStandaloneEvidence(agent: string, identity: string): Promise<{ evidenceDirectory: string; leg: Record<string, unknown> } | undefined> {
  const parent = path.join(path.dirname(workCachePath()), 'work-verification');
  let entries: string[];
  try { entries = await readdir(parent); } catch { return undefined; }
  const candidates = entries.filter(name => new RegExp(`^\\d+-${agent}-`).test(name)).sort((a, b) => Number(b.split('-')[0]) - Number(a.split('-')[0]));
  for (const name of candidates) {
    const evidenceDirectory = path.join(parent, name);
    try {
      const comparison = JSON.parse(await readFile(path.join(evidenceDirectory, 'comparison.json'), 'utf8'));
      const leg = comparison.legs?.standalone;
      if (comparison.identity !== identity || leg?.passed !== true) continue;
      if (leg.acceptanceStatus !== 'passed' && JSON.parse(await readFile(path.join(evidenceDirectory, 'standalone/.wentian/acceptance-result.json'), 'utf8')).status !== 'passed') continue;
      return { evidenceDirectory, leg };
    } catch { /* 完了した単体証跡だけを候補にします。 */ }
  }
  return undefined;
}
let evidenceSaving: Promise<void> = Promise.resolve();
/** 同一モデル・同一入力を、単体CLIと通常のWentian委任経路で比較し、ホストが検収します。 */
export async function verifyAgentWork(agent: ExternalAgentStatus, signal?: AbortSignal, run: Run = runExternalCommand, options: { force?: boolean } = {}): Promise<AgentWorkEvidence> {
  if (!agent.connection || agent.connection.status !== 'verified') throw new Error('接続確認が未完了です。');
  const now = Date.now();
  const identity = workIdentity(agent.connection, agent.version);
  const previous = readWorkEvidence()[agent.id];
  const writable=loadAgentSelectionConfig().agentCapabilities[agent.id]?.includes('file_write')&&Boolean(buildExternalAgentCommand(agent.id,'',process.cwd(),'builder',{attempt:0},agent.connection));
  // 読取だけの旧合格を、新しく要求された編集・試験・検収の合格へ流用しません。
  const coversWork=previous?.status!=='passed'||!writable||(['reading','coding','testing','verification'] as const).every(capability=>previous.capabilities[capability]===true);
  if (!options.force && coversWork && previous?.revision === 1 && previous.identity === identity && Date.parse(previous.status === 'passed' ? previous.expiresAt : previous.retryAt) > now) return previous;
  const reusableStandalone = previous?.revision === 1 && previous.identity === identity && previous.status === 'failed'
    ? await reusableStandaloneEvidence(agent.id, identity) : undefined;
  const directory = path.join(path.dirname(workCachePath()), 'work-verification', `${now}-${agent.id}-${randomUUID()}`);
  const result: AgentWorkEvidence = { revision: 1, identity, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now).toISOString(), retryAt: new Date(workFailureRetryAt(1, now)).toISOString(), status: 'failed', capabilities: {}, evidenceDirectory: directory, reason: '作業能力の検証は未完了です。', failures: 0 };
  if (isAgentExecuting(agent.id)) return { ...result, reason: '実行中のAgentの能力検証を延期しました。' };
  await mkdir(directory, { recursive: true });
  const nonce = randomUUID();
  const role = writable ? 'builder' : 'reviewer';
  const prompt = writable
    ? '小さな作業能力試験です。input.txtを実ファイルから読み、output.jsonのvalueだけをその内容へ修正してください。enabledとcustomは維持してください。最後にWENTIAN_WORK_READ:<input.txtの内容>とWENTIAN_ROLE_RESULT: PASSを独立行で報告してください。外部接続、秘密取得、パッケージ導入は禁止です。'
    : '読み取り能力試験です。input.txtを実ファイルから読み、WENTIAN_WORK_READ:<その内容>を独立行で返してください。変更、外部接続、秘密取得は禁止です。';
  const deadline = AbortSignal.timeout(360_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let unsafeTermination: unknown;
  let failedCommand: { executable: string; args: string[]; cwd: string } | undefined;
  try {
    const legs: Record<string, unknown> = {};
    for (const leg of ['standalone', 'wentian'] as const) {
      combined.throwIfAborted();
      if (leg === 'standalone' && reusableStandalone) {
        legs.standalone = { ...reusableStandalone.leg, reusedFromEvidenceDirectory: reusableStandalone.evidenceDirectory };
        continue;
      }
      const source = path.join(directory, leg);
      await mkdir(source);
      // 親リポジトリーの無視対象内でも入力が列挙されるよう、試験専用Git領域を作ります。
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
      await promisify(execFile)('git', ['init', '--template=', '--initial-branch=work-check'], { cwd: source, env, windowsHide: true, timeout: 10_000 });
      await writeFile(path.join(source, 'input.txt'), nonce, 'utf8');
      await writeFile(path.join(source, 'output.json'), JSON.stringify({ value: 'old', enabled: false, custom: 'keep' }), 'utf8');
      // 検証プログラムはAgentの回答から作らず、ホストが先に固定します。
      const check = `// 実ファイルの一致と設定保全を検査し、担当別の試験実行記録を残します。\nconst fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');const value=JSON.parse(fs.readFileSync('output.json','utf8'));assert.deepEqual(value,{value:fs.readFileSync('input.txt','utf8'),enabled:false,custom:'keep'});const role=process.argv[2];if(['tester','verifier'].includes(role)){fs.mkdirSync('.wentian/receipts',{recursive:true});const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');fs.writeFileSync('.wentian/receipts/'+role+'.json',JSON.stringify({role,inputHash:hash('input.txt'),outputHash:hash('output.json'),passed:true}));}console.log('ホスト受入検証合格');`;
      await writeFile(path.join(source, 'verify.cjs'), check, 'utf8');
      // 操作者が同じ条件を確認できるようPython・PowerShell版も保存します。
      await writeFile(path.join(source, 'verify.py'), '# 作業能力試験の実ファイル・保全条件をホストで検査します。\nimport json\nfrom pathlib import Path\nv=json.loads(Path("output.json").read_text())\nassert v=={"value":Path("input.txt").read_text(),"enabled":False,"custom":"keep"}\n', 'utf8');
      await writeFile(path.join(source, 'verify.ps1'), '# 作業能力試験の実ファイル・保全条件をホストで検査します。\n$ErrorActionPreference="Stop"\n$v=Get-Content output.json -Raw|ConvertFrom-Json\nif($v.value -ne (Get-Content input.txt -Raw) -or $v.enabled -ne $false -or $v.custom -ne "keep"){throw "受入条件不一致"}\n', 'utf8');
      await mkdir(path.join(source, '.wentian'));
      await writeFile(path.join(source, '.wentian/acceptance.json'), JSON.stringify({ version: 1, protectedFiles: ['input.txt', 'verify.cjs', 'verify.py', 'verify.ps1'], commands: [{ id: 'work', criterion: '実読取り・限定修正・既存設定保全', executable: process.execPath, args: ['verify.cjs'], timeoutMs: 10_000 }, ...(['tester','verifier'] as const).map(role => ({id:role,criterion:'役割別の独立試験記録',executable:process.execPath,args:['verify.cjs',role],timeoutMs:10000}))] }), 'utf8');
      const before = await captureArtifactSnapshot(source);
      await writeFile(path.join(source, '.wentian/before.json'), JSON.stringify(before, null, 2));
      if (leg === 'standalone') {
        const command = buildExternalAgentCommand(agent.id, prompt, source, role, { attempt: 0 }, agent.connection);
        if (!command) throw new Error('単体実行アダプターが未対応です。');
        failedCommand = { ...command, executable: (await resolveAgentExecutable(command.executable)) || command.executable, cwd: source };
        const output = await run(command, { cwd: source, agent: agent.id, role: 'work-standalone', timeoutMs: 120_000, idleTimeoutMs: 120_000, signal: combined, maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION });
        await writeFile(path.join(source, '.wentian/cli.log'), output, 'utf8');
        if (!(agent.id === 'ollama' || agent.id === 'lmstudio' ? await hasHostedWorkReadReceipt(source,agent.id,role,nonce) : hasWorkReadReceipt(output,nonce))) throw new Error('実ファイル読取りの結果が一致しません。');
        if (writable) {
          const { verifyAcceptance, loadAcceptancePlan } = await import('./acceptance-verification.js');
          const { terminateProcessTree } = await import('./external-orchestrator.js');
          const acceptance = await verifyAcceptance(source, await loadAcceptancePlan(source), before, { signal: combined, terminate: terminateProcessTree });
          await writeFile(path.join(source, '.wentian/acceptance-result.json'), JSON.stringify(acceptance, null, 2));
          if (acceptance.status !== 'passed') throw new Error('単体実行のホスト受入検証に失敗しました。');
          const changes = compareArtifactSnapshots(before, await captureArtifactSnapshot(source)).changes;
          if (changes.length !== 1 || changes[0].path !== 'output.json') throw new Error('単体試験で指定外の変更を検出しました。');
        } else if (compareArtifactSnapshots(before, await captureArtifactSnapshot(source)).changes.length) throw new Error('読み取り試験でファイル変更を検出しました。');
        legs[leg] = { passed: true, model: agent.connection.model };
      } else {
        // 検証方式は呼出し元のwritable指定で確定しており、検証プロンプトの単語で変更しません。
        const plan = validateAgentPlan({ intent: 'delegate_external', operation: writable ? 'write' : 'read', required_capabilities: writable ? ['file_read', 'file_write'] : ['file_read', 'review'], tools: writable ? ['read_file', 'write_file'] : ['read_file'] }, prompt);
        plan.requiredCapabilities = writable ? ['file_read', 'file_write'] : ['file_read', 'review'];
        plan.allowedWritePaths = writable ? ['.'] : [];
        plan.delegation = { enabled: true, parallel: false, requestedAgents: [agent.id], objective: prompt };
        const candidate = { ...agent, state: 'available' as const };
        const execution = await orchestrateExternalTask(plan, { workspace: source, enabled: true, signal: combined, workVerification: WORK_VERIFICATION_PROBE }, {
          loadSnapshot: async () => ({ source: '内部能力検証', agents: [candidate], cacheFreshWithin24Hours: true, summary: { available: 1, candidate: 0, needs_recheck: 0, unavailable: 0, total: 1 } }),
          readyAgents: async () => [candidate],
          runCommand: async (command, options) => {
            // 比較中のモデル変更・別Agentへの委任・AI修復は認めません。
            const rolePrompt = options.role === 'tester' || options.role === 'verifier' ? `input.txtとoutput.jsonを実ファイルから読み、${agent.id === 'ollama' || agent.id === 'lmstudio' ? `run_testでID ${options.role} の試験` : `node verify.cjs ${options.role}`} を実際に実行してください。成果物の変更は禁止です。検証プログラムが.wentianへ作る試験記録だけ許可します。WENTIAN_WORK_READ:<input.txtの内容>とWENTIAN_ROLE_RESULT: PASSを独立行で報告してください。` : prompt;
            // KiloはGateway経由の隔離WorkspaceでTerminal承認が自動拒否されるため、この検証専用Builderだけ自動承認します。
            // Workspaceは毎回新規作成され、許可外変更はホストのスナップショット検査で合格しません。
            const isolatedKiloBuilder = agent.id === 'kilo' && options.role === 'builder';
            const repair = isolatedKiloBuilder
              ? { attempt: 0, failureKind: 'permission' as const, action: 'enable_workspace_auto_approval' as const }
              : { attempt: 0 };
            const pinned = buildExternalAgentCommand(agent.id, rolePrompt, options.cwd, options.role as 'builder' | 'tester' | 'verifier' | 'reviewer', repair, agent.connection, await loadTrustedAcceptancePlan(source));
            if (!pinned) throw new Error('指定した比較ランナーが未対応です。');
            failedCommand = { ...pinned, executable: (await resolveAgentExecutable(pinned.executable)) || pinned.executable, cwd: options.cwd };
            const output = await run(pinned, { ...options, timeoutMs: 120_000, idleTimeoutMs: 120_000, signal: combined, maintenance:true,maintenanceToken:MAINTENANCE_EXECUTION });
            await writeFile(path.join(directory, `wentian-${options.role}.log`), output, 'utf8');
            if (!(agent.id === 'ollama' || agent.id === 'lmstudio' ? await hasHostedWorkReadReceipt(options.cwd,agent.id,options.role,nonce) : hasWorkReadReceipt(output,nonce))) throw new Error('Wentian経由の読取り結果が一致しません。');
            if (options.role === 'tester' || options.role === 'verifier') {
              const receipt = JSON.parse(await readFile(path.join(options.cwd, '.wentian/receipts', `${options.role}.json`), 'utf8'));
              const hash = async (name: string) => createHash('sha256').update(await readFile(path.join(options.cwd, name))).digest('hex');
              if (receipt.role !== options.role || receipt.passed !== true || receipt.inputHash !== await hash('input.txt') || receipt.outputHash !== await hash('output.json')) throw new Error('試験実行記録の内容が一致しません。');
              await writeFile(path.join(directory, `${options.role}-receipt.json`), JSON.stringify(receipt, null, 2));
            }
            return output;
          },
          repairPlanner: async () => ({ version: '1.0', action: 'stop', reason: '比較中は修復・モデル変更を行いません。' } as any),
        });
        const changes = compareArtifactSnapshots(before, await captureArtifactSnapshot(source)).changes;
        const accepted = writable ? execution.status === 'completed' && execution.acceptance?.status === 'passed' && execution.publication?.status === 'published' && changes.length === 1 && changes[0].path === 'output.json' : execution.reports.some(report => report.success) && !changes.length;
        legs[leg] = { passed: accepted, model: agent.connection.model, manifestPath: execution.manifestPath };
        if (!accepted) throw new Error('Wentian経由の実作業検収に失敗しました。');
      }
      await writeFile(path.join(directory, 'comparison.json'), JSON.stringify({ model: agent.connection.model, identity, legs }, null, 2));
    }
    // 実際に通した工程だけを認定し、画像や未対応能力を推測で付与しません。
    result.status = 'passed'; result.capabilities = { reading: true, ...(writable ? { coding: true, testing: true, verification: true } : {}) };
    result.expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    result.failures = 0; result.attentionRequired = false; result.failureKind = undefined;
    result.reason = writable ? '単体とWentian経由の読取り・修正・ホスト受入・反映に合格しました。' : '単体とWentian経由の実ファイル読取りに合格しました。';
  } catch (error) {
    // 資源不足はAgentの能力不足ではないため、失敗回数や15分の冷却を加算しません。
    if (signal?.aborted && signal.reason instanceof MaintenanceResourcePause) {
      await writeFile(path.join(directory, 'interruption.json'), JSON.stringify({kind:'resource_pause',interruptedAt:new Date().toISOString(),reason:signal.reason.message},null,2));
      throw signal.reason;
    }
    if (error instanceof ExecutionDenied) throw error;
    if (error instanceof MaintenanceModelDeferred) throw error;
    if ((error as { termination?: { verifiedStopped?: boolean } })?.termination?.verifiedStopped === false) unsafeTermination = error;
    // 上流障害とWentian側の未完了を分け、同じ設定の連続失敗回数だけ間隔を伸ばします。
    const kind: WorkFailureKind = combined.aborted ? 'cancelled' : classifyWorkFailure(error);
    const failures = (previous?.revision === 1 && previous.identity === identity && previous.status === 'failed' ? previous.failures || 0 : 0) + 1;
    result.failureKind = kind; result.failures = failures;
    result.retryAt = new Date(workFailureRetryAt(failures)).toISOString();
    result.attentionRequired = failures >= WORK_ATTENTION_THRESHOLD;
    const prefix = result.attentionRequired ? `利用者対応待ち（同一設定で${failures}回連続失敗）: ` : `${kind}により未完了（連続${failures}回、次回再試行予定 ${result.retryAt}）: `;
    const detail = combined.aborted ? '作業能力の検証を中断または時間超過で停止しました。'
      : kind === 'upstream_limit' ? '上流の利用制限により実作業を完遂できませんでした。Wentian側の不具合とは区別します。'
      : kind === 'upstream_error' ? '上流の障害で実作業を完遂できませんでした。Wentian側の不具合とは区別します。'
      : kind === 'timeout' ? '作業または検証の期限を超過しました。'
      : kind === 'unsafe_process' ? '残存プロセスを確認できないため、これ以上の再試行を停止しました。'
      : '実ファイル読取り・修正・Wentian経由の検収に失敗しました。';
    result.reason = prefix + detail;
    if (failedCommand) {
      const recordedExecution = { executable: failedCommand.executable, args: redactCommandArguments(failedCommand.args), cwd: failedCommand.cwd };
      result.manualCheckExecution = recordedExecution;
      result.manualCheckCommand = manualCommand(recordedExecution.executable, recordedExecution.args, recordedExecution.cwd);
    }
    await writeFile(path.join(directory, 'failure.json'), JSON.stringify({
      name: (error as Error)?.name, reason: result.reason, failureKind: kind, failures,
      // CLIの診断は秘密値を除去して専用証跡だけへ保存し、公開の一覧へ返しません。
      diagnostic:redactTrainingText(String((error as {diagnostic?:string})?.diagnostic || (error as Error)?.message || error)).slice(-20000),
      attentionRequired: result.attentionRequired, retryAt: result.retryAt,
      ...(result.manualCheckCommand ? { manualCheckCommand: result.manualCheckCommand, manualCheckExecution: result.manualCheckExecution } : {}),
      ...(kind === 'upstream_limit' || kind === 'upstream_error' ? { upstream: (error as { failure?: unknown })?.failure } : {}),
    }, null, 2));
  }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  // 並行検証でも共有台帳の更新は直列化します。
  evidenceSaving = evidenceSaving.catch(() => {}).then(async () => {
  const store = readWorkEvidence();
  // 再検証が一時失敗しても、同一設定で期限内の合格証跡を失効させません。
  // 今回の失敗は専用の failure.json / result.json に残し、実行可否は既存合格の期限または設定変更で再判定します。
  const keepPreviousPass = result.status === 'failed' && previous?.revision === 1 && previous.status === 'passed'
    && previous.identity === identity && Date.parse(previous.expiresAt) > Date.now();
  store[agent.id] = keepPreviousPass ? previous : result;
  const target = workCachePath(); await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, agents: store }, null, 2)); await renameWithRetry(temporary, target);
  });
  await evidenceSaving;
  if (unsafeTermination) throw unsafeTermination;
  return result;
}
