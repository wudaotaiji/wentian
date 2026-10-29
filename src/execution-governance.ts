import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { machineConfigDirectory, agentNotExcluded } from './agent-exclusion-policy.js';
import { atomicOrdinaryWrite, assertOrdinaryPath } from './safe-file.js';
import { readAgentConnections } from './agent-connection-policy.js';
import { maintenanceControlStatus } from './maintenance-controls.js';
import { MAINTENANCE_EXECUTION } from './maintenance-execution.js';

export const governedAgents = ['ollama','lmstudio','goose','crush','kilo','opencode','hermes','claude','openclaw','cline','codex'];
export type ExecutionBoundary = 'sandbox-read' | 'sandbox-write' | 'tools-disabled' | 'host-account';
export interface ExecutionGrant { agent: string; root: string; shareContext: true; allowHostAccount: boolean; expiresAt: string; revision: string; actor: string; connectionDigest:string }
export interface ProjectExecutionGrant { id:string; root:string; shareContext:true; allowHostAccount:boolean; targets:Record<string,string>; revision:string; actor:string; createdAt:string }
interface ExecutionAccess { maintenance:boolean; revokedAgents:string[]; projects:ProjectExecutionGrant[] }
interface GrantStore { version: 1; grants: ExecutionGrant[]; access?:ExecutionAccess }
export interface ExecutionDisclosure { agent: string; boundary: ExecutionBoundary; destination: string; model?: string; inputBytes: number; requestDigest: string; rootDigest: string; additionalFileAccess: boolean }

/** 認証情報や依頼本文を保存しない、端末単位の実行許可台帳です。 */
export function executionPolicyPath(): string { return process.env.WENTIAN_EXECUTION_POLICY_FILE || path.join(machineConfigDirectory(), 'execution-grants.json'); }
export function executionAuditPath(): string { return process.env.WENTIAN_EXECUTION_AUDIT_FILE || path.join(machineConfigDirectory(), 'execution-audit.jsonl'); }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(directory: string): string { const result=realpathSync(path.resolve(directory));if(!statSync(result).isDirectory())throw new Error('作業場所はディレクトリーを指定してください。');return result; }
function connectionDigest(agent:string):string {const c=readAgentConnections()[agent];return hash(JSON.stringify(c?{model:c.model,provider:c.provider,baseUrl:c.baseUrl}:null));}
function within(root: string, directory: string): boolean { const relative = path.relative(root, directory); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }
function validGrant(value: unknown): value is ExecutionGrant {
  const g = value as ExecutionGrant;
  return !!g && governedAgents.includes(g.agent) && typeof g.root === 'string' && path.isAbsolute(g.root) && g.shareContext === true && typeof g.allowHostAccount === 'boolean' && Number.isFinite(Date.parse(g.expiresAt)) && typeof g.revision === 'string' && typeof g.actor === 'string' && typeof g.connectionDigest==='string';
}
/** 旧台帳の明示取消を既定許可で復活させません。未移行時だけ監査履歴から復元します。 */
function legacyRevocations():string[] {
  const revoked = new Set<string>();
  if(existsSync(executionAuditPath()))for(const line of readFileSync(executionAuditPath(),'utf8').split('\n')){
    if(!line.trim())continue;
    let row:any;try{row=JSON.parse(line);}catch{continue;}
    if(!governedAgents.includes(row.agent))continue;
    if(row.event==='revoke')revoked.add(row.agent);
    if(row.event==='grant_requested')revoked.delete(row.agent);
  }
  return [...revoked];
}
function readPolicy():GrantStore & {access:ExecutionAccess} {
  const file = executionPolicyPath();
  const defaults=():ExecutionAccess=>({maintenance:true,revokedAgents:legacyRevocations(),projects:[]});
  if (!existsSync(file)) return {version:1,grants:[],access:defaults()};
  // 破損した台帳を「許可なし」へ黙って書き換えず、起動側も管理側も失敗させます。
  const data = JSON.parse(readFileSync(file, 'utf8')) as GrantStore;
  if (data.version !== 1 || !Array.isArray(data.grants) || !data.grants.every(validGrant)) throw new Error('実行許可台帳を確認できません。');
  const access=data.access===undefined?defaults():data.access;
  if(!access||typeof access!=='object'||Array.isArray(access)||typeof access.maintenance!=='boolean'||!Array.isArray(access.revokedAgents)||access.revokedAgents.some(id=>!governedAgents.includes(id))||!Array.isArray(access.projects)
    ||access.projects.some(project=>!project||typeof project.id!=='string'||typeof project.root!=='string'||!path.isAbsolute(project.root)||project.shareContext!==true||typeof project.allowHostAccount!=='boolean'||typeof project.revision!=='string'||typeof project.actor!=='string'||!Number.isFinite(Date.parse(project.createdAt))||!project.targets||Array.isArray(project.targets)||typeof project.targets!=='object'||Object.entries(project.targets).some(([id,digest])=>!governedAgents.includes(id)||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))))throw new Error('実行許可台帳を確認できません。');
  return {...data,access};
}
export function readExecutionGrants():ExecutionGrant[]{return readPolicy().grants;}
/** 起動時に旧形式を一度だけ移行し、取消履歴と期限付き許可をそのまま保持します。 */
export async function initializeExecutionAccess():Promise<void>{
  await serialized(async()=>{
    const policy=readPolicy();
    if(existsSync(executionPolicyPath())&&JSON.parse(readFileSync(executionPolicyPath(),'utf8')).access!==undefined)return;
    await audit('access_migrated',{maintenance:policy.access.maintenance,revokedAgents:policy.access.revokedAgents});await store(policy.grants,policy.access);
  });
}
let mutation = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const locked=async()=>{
    const lock=executionPolicyPath()+'.lock';await assertOrdinaryPath(lock);await mkdir(path.dirname(lock),{recursive:true});
    // 別Gateway・CLIとの同時更新でも、取消済み許可を古い書込みで復活させません。
    // 異常終了の残留ロックは自動削除せず、安全側で管理操作を停止します。
    const handle=await open(lock,'wx',0o600);
    try{return await work();}finally{await handle.close();await unlink(lock);}
  };
  const result = mutation.then(locked, locked); mutation = result.then(()=>{},()=>{}); return result;
}
async function audit(event: string, detail: Record<string, unknown>): Promise<void> {
  const file = executionAuditPath();await assertOrdinaryPath(file); await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ at: new Date().toISOString(), event, ...detail })+'\n', { encoding:'utf8', mode:0o600 });
}
async function store(grants: ExecutionGrant[],access=readPolicy().access): Promise<void> {
  await atomicOrdinaryWrite(executionPolicyPath(),JSON.stringify({version:1,grants,access})+'\n');
}
export async function grantExecution(input: { agent: string; root: string; shareContext: boolean; allowHostAccount: boolean; hours: number; expectedConnectionDigest?:string; expiresAt?:string }, actor: string): Promise<ExecutionGrant> {
  if (!governedAgents.includes(input.agent) || input.shareContext !== true || typeof input.allowHostAccount !== 'boolean' || !Number.isInteger(input.hours) || input.hours < 1 || input.hours > 24 || !actor) throw new Error('実行許可の入力が不正です。');
  // 再検証中のモデル選択でも、利用者が承認した元の期限を延長しないための上限です。
  const expiry = Math.min(Date.now()+input.hours*3600000,input.expiresAt===undefined?Infinity:Date.parse(input.expiresAt));
  if(!Number.isFinite(expiry)||expiry<=Date.now())throw new Error('実行許可の入力が不正です。');
  const root = canonical(input.root);
  return serialized(async()=>{
    if(input.expectedConnectionDigest!==undefined&&input.expectedConnectionDigest!==connectionDigest(input.agent))throw new Error('接続設定が変更されました。再確認してください。');
    const grant: ExecutionGrant = { agent:input.agent, root, shareContext:true, allowHostAccount:input.allowHostAccount, expiresAt:new Date(expiry).toISOString(), revision:randomUUID(), actor, connectionDigest:connectionDigest(input.agent) };
    const grants = readExecutionGrants().filter(g=>g.agent!==grant.agent || g.root!==root);
    await audit('grant_requested', { agent:grant.agent, rootDigest:hash(root), actor, expiresAt:grant.expiresAt, allowHostAccount:grant.allowHostAccount });
    await store([...grants,grant]); return grant;
  });
}
const active = new Map<string, Set<AbortController>>();
export async function revokeExecution(agent: string, actor: string): Promise<void> {
  if (!governedAgents.includes(agent)) throw new Error('実行許可の入力が不正です。');
  await serialized(async()=>{const policy=readPolicy();policy.access.revokedAgents=[...new Set([...policy.access.revokedAgents,agent])];await store(policy.grants.filter(g=>g.agent!==agent),policy.access);for(const controller of active.get(agent)||[])controller.abort(new Error('実行許可が取り消されました。'));await audit('revoke',{agent,actor});});
}

/** プロジェクト全体の登録は一度だけ行い、既存接続先内のモデル変更では再承認を求めません。 */
function targetDigest(connection:{provider?:string;baseUrl?:string;mode?:string}|undefined):string{return hash(JSON.stringify(connection?{provider:connection.provider||'',baseUrl:connection.baseUrl||'',mode:connection.mode||''}:null));}
export function executionTargetsDigest():string{return hash(JSON.stringify(Object.entries(readAgentConnections()).filter(([id])=>governedAgents.includes(id)).sort(([a],[b])=>a.localeCompare(b)).map(([id,c])=>[id,targetDigest(c)])));}
export async function grantProjectExecution(input:{root:string;shareContext:boolean;allowHostAccount:boolean;expectedTargetsDigest:string},actor:string):Promise<ProjectExecutionGrant>{
  if(!actor||input.shareContext!==true||typeof input.allowHostAccount!=='boolean'||typeof input.expectedTargetsDigest!=='string')throw new Error('実行許可の入力が不正です。');
  const root=canonical(input.root);
  return serialized(async()=>{
    if(input.expectedTargetsDigest!==executionTargetsDigest())throw new Error('接続設定が変更されました。再確認してください。');
    const targets=Object.fromEntries(Object.entries(readAgentConnections()).filter(([id])=>governedAgents.includes(id)).map(([id,c])=>[id,targetDigest(c)]));
    if(!Object.keys(targets).length)throw new Error('実行許可の入力が不正です。');
    const policy=readPolicy(),grant:ProjectExecutionGrant={id:hash(root),root,shareContext:true,allowHostAccount:input.allowHostAccount,targets,revision:randomUUID(),actor,createdAt:new Date().toISOString()};
    policy.access.projects=[...policy.access.projects.filter(p=>p.id!==grant.id),grant];
    await audit('project_grant_requested',{project:grant.id,agents:Object.keys(targets),actor,allowHostAccount:grant.allowHostAccount});await store(policy.grants,policy.access);return grant;
  });
}
export async function revokeProjectExecution(id:string,actor:string):Promise<void>{
  if(!actor||!/^[a-f0-9]{64}$/.test(id))throw new Error('実行許可の入力が不正です。');
  await serialized(async()=>{const policy=readPolicy();policy.access.projects=policy.access.projects.filter(p=>p.id!==id);await store(policy.grants,policy.access);await audit('project_revoke',{project:id,actor});});
}
export async function configureDefaultExecution(input:{maintenance?:boolean;agent?:string;restore?:boolean},actor:string):Promise<void>{
  if(!actor||(!Object.hasOwn(input,'maintenance')&&!input.agent)||(input.maintenance!==undefined&&typeof input.maintenance!=='boolean')||(input.agent!==undefined&&(!governedAgents.includes(input.agent)||input.restore!==true)))throw new Error('実行許可の入力が不正です。');
  await serialized(async()=>{const policy=readPolicy();if(input.maintenance!==undefined)policy.access.maintenance=input.maintenance;if(input.agent)policy.access.revokedAgents=policy.access.revokedAgents.filter(id=>id!==input.agent);await store(policy.grants,policy.access);await audit('defaults_updated',{maintenance:policy.access.maintenance,agent:input.agent,actor});});
}
const projectCopies=new WeakMap<object,{source:string;directory:string}>();
/** コピー元との対応はホストのメモリーにだけ保持し、JSONのパス指定では制作領域の許可を継承させません。 */
export function createProjectExecutionScope(source:string,directory:string):object{const scope={};projectCopies.set(scope,{source:canonical(source),directory:canonical(directory)});return scope;}
export function executionAccessSummary():{maintenanceDefault:boolean;maintenanceConfigured:boolean;maintenanceEnvironmentBlocked:boolean;revokedAgents:string[];projects:ProjectExecutionGrant[];targetsDigest:string}{
  const access=readPolicy().access,blocked=process.env.WENTIAN_DEFAULT_MAINTENANCE_ACCESS==='false';
  return {maintenanceDefault:access.maintenance&&!blocked&&maintenanceControlStatus().connection.allowed,maintenanceConfigured:access.maintenance,maintenanceEnvironmentBlocked:blocked,revokedAgents:access.revokedAgents,projects:access.projects,targetsDigest:executionTargetsDigest()};
}

/** 固定CLI旗だけを解釈します。依頼本文の単語で利用者の意図を分類しません。 */
export function executionDisclosure(command: { args: string[]; connection?: { model: string; baseUrl?: string } }, options: { agent: string; cwd: string; input?: string }): ExecutionDisclosure {
  const args=command.args;
  const flag=(name:string)=>args[args.indexOf(name)+1];
  const sandbox=args.includes('--sandbox')?flag('--sandbox'):undefined;
  const bypass=args.some(a=>['--dangerously-bypass-approvals-and-sandbox','--yolo','bypassPermissions'].includes(a));
  const boundary:ExecutionBoundary = options.agent==='codex'&&!bypass&&sandbox==='read-only'?'sandbox-read':options.agent==='codex'&&!bypass&&sandbox==='workspace-write'?'sandbox-write':options.agent==='claude'&&!bypass&&args.includes('--tools')&&flag('--tools')===''?'tools-disabled':'host-account';
  let destination='provider-managed';
  if(command.connection?.baseUrl) { try { const url=new URL(command.connection.baseUrl); destination=url.origin; } catch { destination='unknown'; } }
  const serialized=JSON.stringify(args)+(options.input||'');
  return { agent:options.agent, boundary, destination, model:command.connection?.model || (args.includes('--model')?flag('--model'):undefined), inputBytes:Buffer.byteLength(serialized), requestDigest:hash(serialized), rootDigest:hash(path.resolve(options.cwd)), additionalFileAccess:boundary!=='tools-disabled' };
}
export class ExecutionDenied extends Error { readonly code='execution_grant_required'; constructor(){super('外部Agentの実行許可がありません。Agent画面から保守の既定権限・プロジェクト範囲・取消状態を確認してください。');} }

/** 起動直前に再確認し、取消・期限切れ・台帳破損を実行中にも検出します。 */
export async function beginGovernedExecution(command: { args: string[]; connection?: {model:string;baseUrl?:string;provider?:string;mode?:string} }, options: { agent: string; cwd: string; input?: string; signal?: AbortSignal; maintenanceToken?:typeof MAINTENANCE_EXECUTION; projectScope?:object }): Promise<{ signal?: AbortSignal; complete: (success:boolean)=>Promise<void> }> {
  if (!governedAgents.includes(options.agent)) throw new ExecutionDenied();
  if (command.args.length===1&&command.args[0]==='--version') return { signal:options.signal, complete:async()=>{} };
  const disclosure=executionDisclosure(command,options), directory=canonical(options.cwd);
  const actualConnection=command.connection?hash(JSON.stringify({model:command.connection.model,provider:(command.connection as {provider?:string}).provider,baseUrl:command.connection.baseUrl})):undefined;
  const find=():{revision:string;source:'temporary'|'maintenance'|'project'}|undefined=>{
    const policy=readPolicy();
    if(!agentNotExcluded({id:options.agent}))return;
    // 明示的な期限付き許可（実行権限画面で設定）を優先して適用します。
    const grant=policy.grants.filter(g=>g.agent===options.agent&&g.connectionDigest===connectionDigest(options.agent)&&(!actualConnection||actualConnection===g.connectionDigest)&&Date.parse(g.expiresAt)>Date.now()&&within(canonical(g.root),directory)&&(!['host-account','tools-disabled'].includes(disclosure.boundary)||g.allowHostAccount)).sort((a,b)=>b.root.length-a.root.length)[0];
    if(grant)return {revision:grant.revision,source:'temporary'};
    if(policy.access.revokedAgents.includes(options.agent))return;
    // 既定許可が有効な場合、登録済みAgentは追加条件なしで実行を許可します。
    if(policy.access.maintenance&&process.env.WENTIAN_DEFAULT_MAINTENANCE_ACCESS!=='false'&&maintenanceControlStatus().connection.allowed){
      return {revision:'default:maintenance',source:'maintenance'};
    }
    // 既定許可が無効な場合のみ、プロジェクト範囲の明示的許可を確認します。
    let projectDirectory=directory;
    if(options.projectScope){const copy=projectCopies.get(options.projectScope);if(!copy||canonical(copy.directory)!==copy.directory||!within(copy.directory,directory))return;projectDirectory=copy.source;}
    const selected=readAgentConnections()[options.agent],target=targetDigest(selected);
    if(command.connection&&targetDigest(command.connection)!==target)return;
    for(const project of policy.access.projects){if(project.targets[options.agent]===target&&within(canonical(project.root),projectDirectory)&&(!['host-account','tools-disabled'].includes(disclosure.boundary)||project.allowHostAccount))return {revision:project.revision,source:'project'};}
  };
  let grant:ReturnType<typeof find>;
  try { grant=find(); } catch { /* 不正な台帳・リンク・保存先を既定許可で迂回しません。 */ }
  if(!grant){await audit('denied',disclosure as unknown as Record<string,unknown>);throw new ExecutionDenied();}
  options.signal?.throwIfAborted();
  const controller=new AbortController(), revision=grant.revision, executionId=randomUUID(), startedAt=Date.now();
  const controllers=active.get(options.agent)||new Set<AbortController>();controllers.add(controller);active.set(options.agent,controllers);
  const timer=setInterval(()=>{try{if(find()?.revision!==revision)controller.abort(new Error('実行許可が失効しました。'));}catch{controller.abort(new Error('実行許可台帳を確認できません。'));}},500);timer.unref();
  try { await audit('started',{...disclosure,authorization:grant.source,executionId});if(find()?.revision!==revision)controller.abort(new Error('実行許可が失効しました。')); } catch(error){clearInterval(timer);controllers.delete(controller);throw error;}
  return { signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal, complete:async(success)=>{clearInterval(timer);controllers.delete(controller);if(!controllers.size)active.delete(options.agent);await audit('finished',{agent:options.agent,executionId,success,aborted:controller.signal.aborted,durationMs:Date.now()-startedAt});} };
}
export function executionSummary(): unknown {
  const grants=readExecutionGrants(); const counts:Record<string,{started:number;failed:number;denied:number;durationMs:number}>={};const recent:Record<string,unknown>[]=[];
  const file=executionAuditPath(); if(existsSync(file)) for(const line of readFileSync(file,'utf8').split('\n').filter(Boolean).slice(-2000)) {try{const row=JSON.parse(line);if(!governedAgents.includes(row.agent))continue;const c=counts[row.agent]||={started:0,failed:0,denied:0,durationMs:0};if(row.event==='started'||row.event==='denied')recent.push(row);if(row.event==='started')c.started++;if(row.event==='denied')c.denied++;if(row.event==='finished'){if(!row.success)c.failed++;c.durationMs+=row.durationMs||0;}}catch{/* 不完全な末尾行は集計しません。 */}}
  const connections=readAgentConnections();
  return { grants, access:executionAccessSummary(), agents:governedAgents.map(agent=>{const info=executionDisclosure({args:[],connection:connections[agent]},{agent,cwd:process.cwd()});return {agent,projectEligible:Boolean(connections[agent]),connectionDigest:connectionDigest(agent),model:info.model||null,destination:info.destination,active:active.get(agent)?.size||0,metrics:counts[agent]||{started:0,failed:0,denied:0,durationMs:0}};}), recent:recent.slice(-30).reverse(),auditContainsContent:false, metricsLimit:2000 };
}
