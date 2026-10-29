/**
 * P1 並列ワークフローエンジン（Parallel Workflow Engine）
 *
 * 目的: 構造化タスクグラフ（Structured Task Graph）を共通基準（Common Baseline）から
 * 隔離コピー（Isolated Copy）して独立ノードを並列実行（Parallel Execution）し、
 * 差分収集（Diff Collection）・競合拒否（Conflict Rejection）・統合領域の固定検証
 * （Fixed Verification in Integration Area）後に原本へ反映（Publish）します。
 * 失敗ノードと依存ノードだけ部分再実行（Partial Re-run）し、成功結果は入力ハッシュ
 * （Input Hash）一致で再利用（Reuse）します。副作用（Side Effect）あるノードは無条件再実行しません。
 *
 * 設計上の安全制約:
 * - 実行本体はコールバック（NodeExecutor / IntegrationVerifier）としてプロセス内からだけ注入します。
 *   HTTP API など外部入力から任意JavaScript（Arbitrary JS）・コマンド（Command）は一切受け取りません。
 * - 状態（State）は専用root（dedicated root）へ原子的（Atomic: 一時ファイル→rename）に保存し、
 *   楽観的バージョン（Optimistic Version）で競合（Conflict）を検出します。
 * - 本エンジンは原本のGit状態を一切変更しません（原本での commit/reset/stash/push なし）。
 *   隔離コピー内のGit操作は task-workspace.ts の既存設計（専用リポジトリ内のみ）に従います。
 */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureArtifactSnapshot, compareArtifactSnapshots, type ArtifactSnapshot } from './artifact-evidence.js';
import { createTaskWorkspace, publishTaskWorkspace, type TaskWorkspace } from './task-workspace.js';
import { renameWithRetry } from './atomic-file.js';
import { assertOrdinaryPath } from './safe-file.js';

/* ------------------------------------------------------------------ */
/* 型定義（Type Definitions）                                          */
/* ------------------------------------------------------------------ */

/** 構造化ノード定義（Structured Node Definition）。外部から受け取る純データです。 */
export interface WorkflowNode {
  id: string;                     // ノード識別子（Node ID）
  dependencies: string[];         // 前提ノードID（Dependency IDs）
  allowedWritePaths: string[];    // 書込みを許可する相対Path（Allowed Write Paths）
  inputs: string[];               // 読み取り入力ファイル（Read-only Inputs）
  acceptance: string;             // 受入条件（Acceptance Criteria）の人間可読説明
  sideEffect: boolean;            // 副作用（Side Effect）があるため無条件再実行不可か
}

export type NodeStatus = 'pending' | 'running' | 'success' | 'reused' | 'failed' | 'blocked' | 'needs_confirmation';
export type WorkflowStatus = 'draft' | 'running' | 'completed' | 'failed' | 'verification_failed' | 'conflict' | 'needs_confirmation';

export interface NodeChange { path: string; kind: 'added' | 'modified' | 'deleted'; beforeHash?: string; afterHash?: string }

/** 台帳へ保存するノード状態（Persisted Node State）。 */
export interface NodeState extends WorkflowNode {
  status: NodeStatus;
  attempts: number;               // 実行試行回数（Attempt Count）
  inputHash?: string;             // 完走時の入力ハッシュ（再利用判定用 / Reuse Key）
  reusedByHash?: boolean;         // 今回、入力ハッシュ一致で再利用したか
  reusedSideEffect?: boolean;     // 副作用ノードを保護のため再実行せず再利用したか
  error?: string;                 // 直近失敗理由（秘密情報は含めない前提・送信時切詰め）
  changes?: NodeChange[];         // 収集した差分（Collected Diff）
  startedAt?: string;
  finishedAt?: string;
}

export interface WorkflowState {
  version: number;                // 楽観的ロック用バージョン（Optimistic Lock Version）
  id: string;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  source?: string;                // 原本ディレクトリ（公開ビューでは隠す / Hidden in Public View）
  workspaceDirectory?: string;    // task-workspace の隔離作業場所（公開ビューでは隠す）
  baselineSha?: string;           // 共通基準コミットのSHA（公開ビューでは隠す）
  baselineSnapshot?: ArtifactSnapshot; // 再試行でも初回の比較基準を維持します。
  integrationDirectory?: string;  // 統合領域ディレクトリ（公開ビューでは隠す）
  maxConcurrency: number;
  nodes: NodeState[];
  merge?: { status: 'pending' | 'verified' | 'no_verifier' | 'failed' | 'published' | 'conflict' | 'no_changes'; note?: string; files?: string[]; at: string };
  history: Array<{ at: string; event: string; nodeId?: string; note?: string }>;
}

/** 実装入力（Executor Input）。ディレクトリ境界はこのcontext.directoryだけです。 */
export interface NodeExecutionContext {
  workflowId: string;
  node: WorkflowNode;
  directory: string;              // このノード専用の隔離コピー（Node-isolated Copy）
  attempt: number;                // 今回の試行番号（1開始）
}
export type NodeExecutor = (context: NodeExecutionContext) => Promise<void>;

/** 統合領域の固定検証（Fixed Verification）。失敗時はErrorをthrowしてください。 */
export interface IntegrationVerificationContext { workflowId: string; directory: string; changedFiles: string[] }
export type IntegrationVerifier = (context: IntegrationVerificationContext) => Promise<void>;

export interface WorkflowRunDeps {
  workspace: string;                        // 原本ディレクトリ（Source / Original Files）
  executeNode: NodeExecutor;                // プロセス内注入の実行コールバック
  verifyIntegration?: IntegrationVerifier;  // 反映前の固定検証（省略時は no_verifier として正直に記録）
  maxConcurrency?: number;                  // 既定2・最大8
}

export class WorkflowStateConflictError extends Error {}
export class WorkflowBusyError extends Error {}

/* ------------------------------------------------------------------ */
/* Path安全性とプラン検証（Plan Validation）                            */
/* ------------------------------------------------------------------ */

const FORBIDDEN_SEGMENTS = new Set(['.git', '.wentian', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_NODES = 64;
const MAX_ACCEPTANCE_LENGTH = 500;

/** 相対Path（Relative Path）だけを通し、脱出・絶対Path・管理領域・依存物を拒否します。 */
function normalizeWorkflowPath(value: unknown, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error(`${label}が空または不正です。`);
  if (raw.length > 200) throw new Error(`${label}が長すぎます（200文字以内）。`);
  const normalized = raw.replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) throw new Error(`${label}は相対Pathのみ指定できます: ${raw}`);
  const parts = normalized.split('/');
  if (parts.some(part => part === '..' || part === '.')) throw new Error(`${label}に '.' / '..' は使えません: ${raw}`);
  if (parts.some(part => FORBIDDEN_SEGMENTS.has(part.toLowerCase()))) throw new Error(`${label}に管理用・依存物パスは使えません: ${raw}`);
  return parts.join('/');
}

/** 書込み宣言の重なり（Write Overlap）を判定します。同一ファイルと親ディレクトリ包含を見ます。 */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** 外部入力（API本文など）からWorkflowNode[]を検証・正規化します。未知キーは拒否します。 */
export function validateWorkflowPlan(input: unknown): WorkflowNode[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('nodesは1件以上の配列で指定してください。');
  if (input.length > MAX_NODES) throw new Error(`nodesは${MAX_NODES}件以内です。`);
  const nodes: WorkflowNode[] = input.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`nodes[${index}]はオブジェクトで指定してください。`);
    const record = item as Record<string, unknown>;
    const allowedKeys = ['id', 'dependencies', 'allowedWritePaths', 'inputs', 'acceptance', 'sideEffect'];
    const unknown = Object.keys(record).filter(key => !allowedKeys.includes(key));
    if (unknown.length) throw new Error(`nodes[${index}]に未知のフィールドがあります: ${unknown.join(', ')}。コマンドやコードの指定はできません。`);
    if (typeof record.id !== 'string' || !NODE_ID_PATTERN.test(record.id)) throw new Error(`nodes[${index}].idは ${NODE_ID_PATTERN.source} の形式で指定してください。`);
    const listOfPaths = (field: string, required: boolean): string[] => {
      const value = record[field];
      if (value === undefined && !required) return [];
      if (!Array.isArray(value)) throw new Error(`nodes[${index}].${field}は文字列配列で指定してください。`);
      if (value.length > 64) throw new Error(`nodes[${index}].${field}は64件以内です。`);
      return [...new Set(value.map(entry => normalizeWorkflowPath(entry, `nodes[${index}].${field}`)))];
    };
    const dependencies = listOfPaths('dependencies', true);
    const allowedWritePaths = listOfPaths('allowedWritePaths', true);
    const inputs = listOfPaths('inputs', true);
    if (typeof record.acceptance !== 'string' || !record.acceptance.trim()) throw new Error(`nodes[${index}].acceptanceに受入条件を記載してください。`);
    if (record.acceptance.length > MAX_ACCEPTANCE_LENGTH) throw new Error(`nodes[${index}].acceptanceは${MAX_ACCEPTANCE_LENGTH}文字以内です。`);
    if (record.sideEffect !== undefined && typeof record.sideEffect !== 'boolean') throw new Error(`nodes[${index}].sideEffectは true / false のみです。`);
    return { id: record.id, dependencies, allowedWritePaths, inputs, acceptance: record.acceptance.trim(), sideEffect: record.sideEffect === true };
  });
  const byId = new Map<string, WorkflowNode>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new Error(`ノードIDが重複しています: ${node.id}`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (dependency === node.id) throw new Error(`ノード ${node.id} は自分自身に依存できません。`);
      if (!byId.has(dependency)) throw new Error(`ノード ${node.id} の依存 ${dependency} がグラフに存在しません。`);
    }
  }
  // Kahnのトポロジカルソート（Topological Sort）で循環参照（Cycle）を検出します。
  const indegree = new Map<string, number>(nodes.map(node => [node.id, node.dependencies.length]));
  const children = new Map<string, string[]>(nodes.map(node => [node.id, []]));
  for (const node of nodes) for (const dependency of node.dependencies) children.get(dependency)!.push(node.id);
  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const child of children.get(id)!) if (indegree.set(child, indegree.get(child)! - 1) && indegree.get(child) === 0) queue.push(child);
  }
  if (visited !== nodes.length) throw new Error('依存グラフに循環（Cycle）があります。環を解消してください。');
  // 書込み宣言の重複（Write Overlap）は全ノード間（依存関係があっても）で拒否します。
  for (let i = 0; i < nodes.length; i += 1) for (let j = i + 1; j < nodes.length; j += 1) {
    for (const a of nodes[i].allowedWritePaths) for (const b of nodes[j].allowedWritePaths) {
      if (pathsOverlap(a, b)) throw new Error(`ノード ${nodes[i].id} と ${nodes[j].id} の書込み範囲が重なっています: ${a} ⇄ ${b}`);
    }
  }
  return nodes;
}

/** 循環のないノード順（トポロジカル順 / Topological Order）を返します。 */
function topologicalOrder(nodes: NodeState[]): NodeState[] {
  const remaining = [...nodes];
  const done = new Set<string>();
  const order: NodeState[] = [];
  while (remaining.length) {
    const ready = remaining.filter(node => node.dependencies.every(dependency => done.has(dependency)));
    if (!ready.length) throw new Error('依存グラフが循環しています（台帳が不整合です）。');
    for (const node of ready) { order.push(node); done.add(node.id); }
    for (const node of ready) remaining.splice(remaining.indexOf(node), 1);
  }
  return order;
}

/* ------------------------------------------------------------------ */
/* ハッシュ・ファイルユーティリティ（Hash / File Utilities）            */
/* ------------------------------------------------------------------ */

const sha256 = (buffer: Buffer | string) => createHash('sha256').update(buffer).digest('hex');

/** 起動中のrun鍵集合（In-process Run Lock）。二重実行（Double Start）をAPI層で拒否します。 */
const runningKeys = new Set<string>();
export function beginWorkflowRun(key: string): boolean { if (runningKeys.has(key)) return false; runningKeys.add(key); return true; }
export function endWorkflowRun(key: string): void { runningKeys.delete(key); }

async function collectFiles(root: string): Promise<string[]> {
  const names: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) names.push(path.relative(root, full).replaceAll('\\', '/'));
    }
  };
  await walk(root);
  return names.sort();
}

/* ------------------------------------------------------------------ */
/* 状態ストア（State Store: 専用root・原子的保存・楽観ロック）          */
/* ------------------------------------------------------------------ */

export class WorkflowStore {
  constructor(readonly root: string) {}

  /** 台帳ID（Workflow ID）から状態ファイルの絶対Pathを作ります。IDは[a-z0-9-]のみ許可します。 */
  filePath(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`不正なワークフローIDです: ${id}`);
    return path.join(path.resolve(this.root), `${id}.json`);
  }

  /** 新規台帳を原子的（wx旗で既存上書きなし）に作成します。 */
  async create(state: WorkflowState): Promise<void> {
    await assertOrdinaryPath(this.filePath(state.id));
    await mkdir(path.resolve(this.root), { recursive: true });
    const file = this.filePath(state.id);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    try { await renameWithRetry(temporary, file); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  async load(id: string): Promise<WorkflowState> {
    await assertOrdinaryPath(this.filePath(id));
    const state = JSON.parse(await readFile(this.filePath(id), 'utf8')) as WorkflowState;
    if (typeof state.version !== 'number' || typeof state.id !== 'string' || !Array.isArray(state.nodes)) throw new Error('ワークフロー台帳が破損しています。');
    return state;
  }

  /**
   * 楽観的ロック（Optimistic Lock）付き原子的保存。
   * ディスク上のversionが期待値と違う場合（他プロセスが先に保存済み）は
   * WorkflowStateConflictErrorで止め、上書きによる台帳破壊（Lost Update）を防ぎます。
   */
  async save(state: WorkflowState, expectedVersion: number): Promise<WorkflowState> {
    const file = this.filePath(state.id);
    await assertOrdinaryPath(file);
    let diskVersion = -1;
    try { diskVersion = (JSON.parse(await readFile(file, 'utf8')) as WorkflowState).version; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`台帳の再読込に失敗しました: ${error instanceof Error ? error.message : String(error)}`); }
    if (diskVersion !== expectedVersion) throw new WorkflowStateConflictError(`ワークフロー台帳が別経路で更新されました（期待version ${expectedVersion} / 実際 ${diskVersion}）。台帳を再読込してからやり直してください。`);
    const next: WorkflowState = { ...state, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2));
    try { await renameWithRetry(temporary, file); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    return next;
  }

  /** 一覧用: 破損・読込不能な台帳はスキップして読み取れる分だけ返します。 */
  async list(): Promise<Array<{ state?: WorkflowState; file: string; issue?: string }>> {
    let files: string[] = [];
    try { files = (await readdir(path.resolve(this.root))).filter(name => name.endsWith('.json')); } catch { return []; }
    const results: Array<{ state?: WorkflowState; file: string; issue?: string }> = [];
    for (const name of files.sort()) {
      const file = path.join(path.resolve(this.root), name);
      try { await assertOrdinaryPath(file); results.push({ state: JSON.parse(await readFile(file, 'utf8')) as WorkflowState, file }); }
      catch (error) { results.push({ file, issue: error instanceof Error ? error.message.slice(0, 200) : String(error) }); }
    }
    return results;
  }
}

/* ------------------------------------------------------------------ */
/* 公開ビュー（Public View: 絶対Path・基準SHAを隠し、誤文は切詰め）      */
/* ------------------------------------------------------------------ */

const truncate = (value: string | undefined) => (value === undefined ? undefined : value.slice(0, 300));

/** API応答用の秘匿化ビュー（Sanitized View）。絶対Path・作業場所・基準SHA・成果物本文を含めません。 */
export function publicWorkflowView(state: WorkflowState) {
  return {
    id: state.id,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    maxConcurrency: state.maxConcurrency,
    merge: state.merge ? { status: state.merge.status, ...(state.merge.note ? { note: truncate(state.merge.note) } : {}), files: state.merge.files, at: state.merge.at } : undefined,
    nodes: state.nodes.map(node => ({
      id: node.id, dependencies: node.dependencies, allowedWritePaths: node.allowedWritePaths, inputs: node.inputs,
      acceptance: node.acceptance, sideEffect: node.sideEffect, status: node.status, attempts: node.attempts,
      reusedByHash: node.reusedByHash, reusedSideEffect: node.reusedSideEffect, error: truncate(node.error),
      changes: node.changes?.map(change => ({ path: change.path, kind: change.kind, afterHash: change.afterHash })),
      startedAt: node.startedAt, finishedAt: node.finishedAt,
    })),
    history: state.history.slice(-20),
  };
}

/* ------------------------------------------------------------------ */
/* ワークフロー作成（Create）                                          */
/* ------------------------------------------------------------------ */

export async function createWorkflow(store: WorkflowStore, nodes: WorkflowNode[], maxConcurrency = 2): Promise<WorkflowState> {
  const plan = validateWorkflowPlan(nodes);
  const now = new Date().toISOString();
  const state: WorkflowState = {
    version: 0,
    id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    status: 'draft',
    createdAt: now, updatedAt: now,
    maxConcurrency: Math.max(1, Math.min(8, Math.floor(maxConcurrency))),
    nodes: plan.map(node => ({ ...node, status: 'pending' as NodeStatus, attempts: 0 })),
    history: [{ at: now, event: 'created', note: `${plan.length}ノードのプランを検証しました。` }],
  };
  await store.create(state);
  return state;
}

/* ------------------------------------------------------------------ */
/* 実行エンジン（Run Engine）                                          */
/* ------------------------------------------------------------------ */

/** ノードに完走時の入力ハッシュ（Reuse Key）を計算します。ノード定義と入力ファイル実内容から見ます。 */
function computeInputHash(node: WorkflowNode, baselineSha: string, effective: Map<string, Buffer>): string {
  const inputs = node.inputs.map(input => [input, effective.has(input) ? sha256(effective.get(input)!) : null] as [string, string | null]).sort((a, b) => a[0].localeCompare(b[0]));
  return sha256(JSON.stringify({ id: node.id, dependencies: node.dependencies, allowedWritePaths: node.allowedWritePaths, inputs, acceptance: node.acceptance, sideEffect: node.sideEffect, baselineSha, effectiveInputs: inputs }));
}

/** 完走済みノードの成果物（Artifact）保存先: <root>/<id>/artifacts/<nodeId>/ */
const nodeArtifactDir = (store: WorkflowStore, workflowId: string, nodeId: string) => path.join(path.resolve(store.root), workflowId, 'artifacts', nodeId);

/** 隔離コピー（mkdtemp）に共通基準を敷き、再実行対象の前提完走ノードの成果物を適用します。 */
async function buildNodeCopy(store: WorkflowStore, state: WorkflowState, baselineFiles: Map<string, Buffer>, node: NodeState, done: Map<string, NodeState>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'wentian-pw-'));
  for (const [name, content] of baselineFiles) {
    const output = path.resolve(directory, name);
    const relative = path.relative(directory, output);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`基準ファイルのPathが範囲外です: ${name}`);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, content);
  }
  // 完了済み依存ノード（依存のうち再利用・成功したもの）の差分を基準之上へ適用します。
  for (const dependency of node.dependencies) {
    const source = done.get(dependency);
    if (!source?.changes) continue;
    for (const change of source.changes) {
      if (change.kind === 'deleted') continue; // 削除はどのみち反映しない
      const content = await readFile(path.join(nodeArtifactDir(store, state.id, dependency), change.path));
      const output = path.resolve(directory, change.path);
      if (!path.relative(directory, output).startsWith('..')) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, content); }
    }
  }
  return directory;
}

/** 実行ツリー（baseline+完了差分）での入力実内容マップを作ります。 */
function effectiveTree(baselineFiles: Map<string, Buffer>, done: Map<string, NodeState>, node: NodeState, artifacts: Map<string, Map<string, Buffer>>): Map<string, Buffer> {
  const tree = new Map(baselineFiles);
  for (const dependency of node.dependencies) {
    const files = artifacts.get(dependency);
    if (!files) continue;
    for (const [name, content] of files) tree.set(name, content);
  }
  return tree;
}

async function loadArtifactFiles(store: WorkflowStore, state: WorkflowState, node: NodeState): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  for (const change of node.changes ?? []) {
    if (change.kind === 'deleted') continue;
    const content = await readFile(path.join(nodeArtifactDir(store, state.id, node.id), change.path));
    if (change.afterHash !== sha256(content)) throw new Error('保存済み成果物のハッシュが一致しません。');
    map.set(change.path, content);
  }
  return map;
}

type RunMode = 'run' | 'retry';
interface RetryOptions { confirmSideEffectRerun?: boolean }

/** run（初回）と retry（部分再実行）共通のコア。mode と reuse判定だけ変えて渡します。 */
async function executeWorkflow(store: WorkflowStore, id: string, deps: WorkflowRunDeps, mode: RunMode, retryOptions: RetryOptions = {}): Promise<WorkflowState> {
  let state = await store.load(id);
  const expectedBaseline = state.version;
  const pushHistory = (event: string, nodeId: string | undefined, note: string) => {
    state.history.push({ at: new Date().toISOString(), event, ...(nodeId ? { nodeId } : {}), note: note.slice(0, 300) });
    if (state.history.length > 60) state.history.splice(0, state.history.length - 60);
  };
  let saveQueue = Promise.resolve();
  // 並列ノードの終了保存も直列化し、同じversionからの二重保存を防ぎます。
  const serializedSave = () => {
    const save = saveQueue.then(async () => { state = await store.save(state, state.version); });
    saveQueue = save.catch(() => undefined); return save;
  };
  const persist = async (nextStatus: WorkflowStatus, event?: string, nodeId?: string, note?: string): Promise<void> => {
    state = { ...state, status: nextStatus, ...(event ? {} : {}) };
    if (event) pushHistory(event, nodeId, note ?? '');
    await serializedSave();
  };

  // 実行前ステータス検証（初回: draft / 再実行: 失敗系・要確認）。running中の再入は拒否します。
  if (mode === 'run' && state.status !== 'draft') throw new WorkflowBusyError(`初回実行はdraft状態のみです（現在: ${state.status}）。`);
  if (mode === 'retry') {
    if (state.status === 'running') throw new WorkflowBusyError('実行中のため再試行できません。');
    if (state.status === 'draft' || state.status === 'completed') throw new WorkflowBusyError(`この状態からは再試行できません（現在: ${state.status}）。`);
  }

  // 共通基準（Common Baseline）: 初回は task-workspace で隔離コピーを作り、以降は同じ基準を使い続けます。
  let workspace: TaskWorkspace;
  if (!state.workspaceDirectory || !state.baselineSha) {
    workspace = await createTaskWorkspace(deps.workspace);
    state = { ...state, source: workspace.source, workspaceDirectory: workspace.directory, baselineSha: workspace.baselineSha, baselineSnapshot: workspace.baseline };
    for (const name of Object.keys(workspace.baseline.files)) {
      const target = path.join(store.root, state.id, 'baseline', name);
      await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(workspace.directory, name), target);
    }
  } else {
    if (!state.baselineSnapshot) throw new Error('初回の比較基準が保存されていません。');
    workspace = { source: state.source!, directory: state.workspaceDirectory!, baselineSha: state.baselineSha, baseline: state.baselineSnapshot };
    if (!workspace.baseline.complete) throw new Error('既存の隔離作業場所が壊れています。統合反映前に作業場所を確認してください。');
  }
  const baselineFiles = new Map<string, Buffer>();
  for (const [name, hash] of Object.entries(workspace.baseline.files)) {
    const content = await readFile(path.join(store.root, state.id, 'baseline', name));
    if (sha256(content) !== hash) throw new Error(`共通基準のコピーが変更されています: ${name}`);
    baselineFiles.set(name, content);
  }

  /* ---- 再実行計画（Re-run Plan）: 失敗・ blocked・ハッシュ不一致だけ再実行する ---- */
  const done = new Map<string, NodeState>();      // 再利用する完走ノード
  const artifacts = new Map<string, Map<string, Buffer>>();
  const toRerun = new Set<string>();
  if (mode === 'retry') {
    const order = topologicalOrder(state.nodes);
    for (const node of order) {
      if (node.status === 'failed' || node.status === 'blocked' || node.status === 'needs_confirmation') { toRerun.add(node.id); continue; }
      if (node.status !== 'success' && node.status !== 'reused') { toRerun.add(node.id); continue; }
      // 上流（推移的依存）のいずれか再実行なら、このノードの入力は古くなるため再実行対象です。
      const upstreamRerun = await transitiveDependencyRerun(node, state, toRerun);
      if (upstreamRerun) { toRerun.add(node.id); continue; }
      const tree = effectiveTree(baselineFiles, done, node, artifacts);
      const inputHash = computeInputHash(node, state.baselineSha!, tree);
      if (inputHash === node.inputHash) {
        done.set(node.id, node);
        artifacts.set(node.id, await loadArtifactFiles(store, state, node));
      } else if (node.sideEffect) {
        // 副作用ノードは入力変更時も無条件再実行せず、人間の確認（明示retry）を要求します。
        toRerun.add(node.id);
      } else toRerun.add(node.id);
    }
    // 副作用ノードの再実行には明示確認（confirmSideEffectRerun）が必須です。
    const sideEffectRerun = [...toRerun].filter(nodeId => state.nodes.find(node => node.id === nodeId)?.sideEffect);
    if (sideEffectRerun.length && retryOptions.confirmSideEffectRerun !== true) {
      state = { ...state, nodes: state.nodes.map(node => toRerun.has(node.id) && node.sideEffect ? { ...node, status: 'needs_confirmation', error: '副作用のあるノードの再実行には confirmSideEffectRerun=true の明示確認が必要です。' } : node) };
      await persist('needs_confirmation', 'retry_held', undefined, `副作用ノード ${sideEffectRerun.join(', ')} の再実行確認待ちです。`);
      return state;
    }
    // 再実行ノードを pending に戻し、再利用ノードには印を付けます。
    state = { ...state, nodes: state.nodes.map(node => {
      if (toRerun.has(node.id)) return { ...node, status: 'pending' as NodeStatus, error: undefined };
      if (done.has(node.id)) return { ...node, status: 'reused' as NodeStatus, reusedByHash: !node.sideEffect, reusedSideEffect: node.sideEffect };
      return node;
    }) };
    await persist('running', 'retry_started', undefined, `再実行 ${toRerun.size}ノード / 再利用 ${done.size}ノード。`);
  } else {
    await persist('running', 'run_started', undefined, `${state.nodes.length}ノードの実行を開始します。`);
  }

  /* ---- ノード実行（Node Execution）: 依存満了ノードを並列プールで回す ---- */
  const statuses = () => new Map(state.nodes.map(node => [node.id, node]));
  const maxConcurrency = state.maxConcurrency;
  for (;;) {
    const byId = statuses();
    const failed = new Set([...byId.values()].filter(node => node.status === 'failed' || node.status === 'needs_confirmation').map(node => node.id));
    // 失敗・要確認ノードの下流（推移的）は blocked に確定します。
    let blockedNew = false;
    for (const node of state.nodes) {
      if (node.status !== 'pending') continue;
      if (await transitiveDependencyRerun({ ...node } as NodeState, { ...state, nodes: state.nodes.map(n => failed.has(n.id) ? { ...n, status: 'failed' } : n) }, failed)) {
        node.status = 'blocked'; blockedNew = true;
      }
    }
    if (blockedNew) await persist('running', 'nodes_blocked', undefined, `${state.nodes.filter(node => node.status === 'blocked').length}ノードを依存失敗でblockedにしました。`);
    const ready = state.nodes.filter(node => node.status === 'pending' && node.dependencies.every(dependency => done.has(dependency)));
    if (!ready.length) break;
    const wave = ready.slice(0, Math.max(1, maxConcurrency));
    await Promise.all(wave.map(async node => {
      node.status = 'running'; node.attempts += 1; node.startedAt = new Date().toISOString();
      const directory = await buildNodeCopy(store, state, baselineFiles, node, done);
      try {
        const before = await captureArtifactSnapshot(directory); // 基準適用直後の状態（実質 baseline+完了差分）
        if (!before.complete) throw new Error(`隔離コピーの取得が不完全です: ${before.issues.join('; ')}`);
        await deps.executeNode({ workflowId: state.id, node: { id: node.id, dependencies: node.dependencies, allowedWritePaths: node.allowedWritePaths, inputs: node.inputs, acceptance: node.acceptance, sideEffect: node.sideEffect }, directory, attempt: node.attempts });
        const after = await captureArtifactSnapshot(directory);
        if (!after.complete) throw new Error(`制作後の取得が不完全です: ${after.issues.join('; ')}`);
        const changes = compareArtifactSnapshots(before, after).changes;
        // 書込み境界（Write Boundary）: allowedWritePaths外の編集・削除はそのノードを失敗にします。
        for (const change of changes) {
          if (change.kind === 'deleted') throw new Error(`削除は反映できないため失敗とします: ${change.path}`);
          if (!node.allowedWritePaths.some(allowed => pathsOverlap(allowed, change.path))) throw new Error(`許可外のPathを変更しました: ${change.path}（許可: ${node.allowedWritePaths.join(', ') || 'なし'}）`);
        }
        // 成果物を専用rootへ保存（再利用と部分再実行のマテリアル）。一時renameで原子的に置換します。
        const artifactDir = nodeArtifactDir(store, state.id, node.id);
        await rm(artifactDir, { recursive: true, force: true });
        await mkdir(artifactDir, { recursive: true });
        for (const change of changes) {
          const content = await readFile(path.resolve(directory, change.path));
          const output = path.resolve(artifactDir, change.path);
          await mkdir(path.dirname(output), { recursive: true });
          await writeFile(output, content);
        }
        node.changes = changes.map(change => ({ path: change.path, kind: change.kind, beforeHash: change.beforeHash, afterHash: change.afterHash }));
        node.inputHash = computeInputHash(node, state.baselineSha!, effectiveTree(baselineFiles, done, node, artifacts));
        done.set(node.id, node);
        artifacts.set(node.id, await loadArtifactFiles(store, state, node));
        node.status = 'success'; node.error = undefined; node.finishedAt = new Date().toISOString();
        pushHistory('node_success', node.id, `${changes.length}件の差分を収集しました。`);
      } catch (error) {
        node.status = 'failed'; node.finishedAt = new Date().toISOString();
        node.error = error instanceof Error ? error.message : String(error);
        pushHistory('node_failed', node.id, node.error);
      } finally {
        // 試行ごとの確定台帳（Crash-safe Ledger）: ここで落ちても再試行で回収できます。
        const snapshotNodes = state.nodes;
        state = { ...state, nodes: snapshotNodes }; await serializedSave();
        // save後はstateが差し替わるため、以後の参照は新stateの同じidノードへ写し直す。
        const fresh = state.nodes.find(fresh => fresh.id === node.id)!;
        Object.assign(node, { status: fresh.status, attempts: fresh.attempts, changes: fresh.changes, inputHash: fresh.inputHash, error: fresh.error });
      }
    }));
  }

  const unresolved = state.nodes.filter(node => node.status !== 'success' && node.status !== 'reused');
  if (unresolved.length) {
    const needsConfirmation = unresolved.some(node => node.status === 'needs_confirmation');
    await persist(needsConfirmation ? 'needs_confirmation' : 'failed', 'run_unresolved', undefined, `未完了ノード: ${unresolved.map(node => `${node.id}(${node.status})`).join(', ')}`);
    return state;
  }

  /* ---- 統合（Integration）: 全完走差分を1ツリーへ合わせ、競合は拒否、固定検証後に反映 ---- */
  const merged = new Map<string, Buffer>(baselineFiles);
  const touched = new Map<string, string>(); // path -> 最初に触れたノード
  const mergeChanges: Array<{ path: string; content: Buffer; kind: 'added' | 'modified' }> = [];
  for (const node of topologicalOrder(state.nodes)) {
    for (const [name, content] of artifacts.get(node.id) ?? []) {
      const previousOwner = touched.get(name);
      if (previousOwner && previousOwner !== node.id) {
        await persist('conflict', 'merge_conflict', node.id, `統合競合: ${name} を ${previousOwner} と ${node.id} が同時に編集しました。原本は変更していません。`);
        return state;
      }
      touched.set(name, node.id);
      mergeChanges.push({ path: name, content, kind: baselineFiles.has(name) ? 'modified' : 'added' });
      merged.set(name, content);
    }
  }
  const integrationDirectory = path.join(path.resolve(store.root), state.id, 'integration');
  await rm(integrationDirectory, { recursive: true, force: true });
  await mkdir(integrationDirectory, { recursive: true });
  for (const [name, content] of merged) {
    const output = path.resolve(integrationDirectory, name);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, content);
  }
  const changedFiles = mergeChanges.map(change => change.path).sort();
  try {
    if (deps.verifyIntegration) {
      await deps.verifyIntegration({ workflowId: state.id, directory: integrationDirectory, changedFiles });
      state.merge = { status: 'verified', note: `統合領域で固定検証を通過しました（${changedFiles.length}件の変更）。`, files: changedFiles, at: new Date().toISOString() };
      pushHistory('integration_verified', undefined, state.merge.note!);
    } else {
      state.merge = { status: 'no_verifier', note: '固定検証が未設定のため、原本への反映を停止しました。', files: changedFiles, at: new Date().toISOString() };
      pushHistory('integration_no_verifier', undefined, state.merge.note!);
      await persist('verification_failed'); return state;
    }
  } catch (error) {
    state.merge = { status: 'failed', note: `統合検証に失敗しました（原本は変更していません）。: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`, files: changedFiles, at: new Date().toISOString() };
    await persist('verification_failed', 'integration_failed', undefined, state.merge.note);
    return state;
  }
  // 統合済み差分を隔離Stagingへ書き、publishTaskWorkspace の競合検査（原本が制作中に動いていれば拒否）を通します。
  for (const change of mergeChanges) {
    const output = path.resolve(workspace.directory, change.path);
    if (!path.relative(workspace.directory, output).startsWith('..')) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, change.content); }
  }
  const staging = await captureArtifactSnapshot(workspace.directory);
  if (!staging.complete) { await persist('conflict', 'staging_incomplete', undefined, 'Stagingの再取得が不完全です。'); return state; }
  const evidence = compareArtifactSnapshots(workspace.baseline, staging);
  const published = await publishTaskWorkspace(workspace, evidence.changes);
  if (published.status === 'conflict') {
    state.merge = { ...state.merge!, status: 'conflict', note: `反映先の競合または反映中の異常で停止しました。: ${published.note}` };
    await persist('conflict', 'publish_conflict', undefined, published.note);
    return state;
  }
  state.merge = { ...state.merge!, status: published.status === 'published' ? 'published' : 'no_changes', note: published.note, files: changedFiles };
  await persist('completed', 'workflow_completed', undefined, published.note);
  return state;
}

/** node の推移的依存（Transitive Dependencies）の中に rerunSet 所属があるかを查めます。 */
async function transitiveDependencyRerun(node: NodeState, state: WorkflowState, rerunSet: Set<string>): Promise<boolean> {
  const byId = new Map(state.nodes.map(item => [item.id, item]));
  const seen = new Set<string>();
  const stack = [...node.dependencies];
  while (stack.length) {
    const id = stack.pop()!;
    if (rerunSet.has(id)) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of byId.get(id)?.dependencies ?? []) stack.push(next);
  }
  return false;
}

/** 初回実行（First Run）。呼び出し側で beginWorkflowRun/endWorkflowRun の鍵管理をしてください。 */
export async function runWorkflow(store: WorkflowStore, id: string, deps: WorkflowRunDeps): Promise<WorkflowState> {
  return withRunLock(store, id, async () => {
    try { return await executeWorkflow(store, id, deps, 'run'); }
    catch (error) { if (error instanceof WorkflowBusyError) throw error; return await persistEngineFailure(store, id, error); }
  });
}

/** 部分再実行（Partial Re-run）。失敗・blockedノードと、入力ハッシュ不一致ノードだけ実行し直します。 */
export async function retryWorkflow(store: WorkflowStore, id: string, deps: WorkflowRunDeps, options: RetryOptions = {}): Promise<WorkflowState> {
  return withRunLock(store, id, async () => {
    try { return await executeWorkflow(store, id, deps, 'retry', options); }
    catch (error) { if (error instanceof WorkflowBusyError) throw error; return await persistEngineFailure(store, id, error); }
  });
}

/** 別プロセスからの同一台帳実行も拒否する。クラッシュ残存ロックは管理者が生存確認後に解除する。 */
async function withRunLock<T>(store: WorkflowStore, id: string, run: () => Promise<T>): Promise<T> {
  const lockPath = `${store.filePath(id)}.run.lock`;
  await assertOrdinaryPath(lockPath);
  await mkdir(path.resolve(store.root), { recursive: true });
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkflowBusyError('同じワークフローが実行中、または中断後のロック確認待ちです。'); throw error; }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await run(); }
  finally { await lock.close(); await unlink(lockPath); }
}

/** エンジンドラバ（想定外例外）も台帳へ正直に残し、running固定（Stuck Running）を避けません。 */
async function persistEngineFailure(store: WorkflowStore, id: string, error: unknown): Promise<WorkflowState> {
  try {
    const state = await store.load(id);
    if (state.status !== 'running') return state;
    state.nodes = state.nodes.map(node => node.status === 'running' ? { ...node, status: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 300) } : node);
    return await store.save({ ...state, status: 'failed', history: [...state.history, { at: new Date().toISOString(), event: 'engine_error', note: (error instanceof Error ? error.message : String(error)).slice(0, 300) }].slice(-60) }, state.version);
  } catch {
    return { version: -1, id, status: 'failed', createdAt: '', updatedAt: new Date().toISOString(), maxConcurrency: 1, nodes: [], history: [{ at: new Date().toISOString(), event: 'engine_error_unpersistable', note: (error instanceof Error ? error.message : String(error)).slice(0, 300) }] };
  }
}
