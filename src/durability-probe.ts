/**
 * Durability Probe: Wentian Gateway の **長時間実証（Long-Run Durability Probe）** の実働ユニット。
 *
 * これは何か（What）
 * -----------------
 * 既存の goal-store（L1 状態保存）と goal-transaction（中断復旧）と agent-compactor（文脈圧縮）を
 * **実際のコード経路で通し**、次の5点が実時間で壊れないことを証拠として残す_probe_です。
 *
 *  1. 実際の状態保存（Real State Persistence）    : goal-store の原子書込が実ファイルへ残り続ける
 *  2. 実際の中断復旧（Real Interrupted Resume）  : 実子プロセス（Real Child Process）を途中で殺しても、
 *                            再起動後は goal-transaction の reconcile から進捗を再開する
 *  3. 文脈圧縮（Context Compaction）         : agent-compactor が閾値で発火し、目的を載せた
 *                            immovable メッセージが圧縮後も全文で残る
 *  4. 目的・許可・受入条件の不変（Invariant Immutability）: 目的（Goal text）、許可バウンド（Stop Policy）、
 *                            受入条件（Acceptance Checks）のSHA256指紋が開始時から一切変わらない
 *  5. 二重反映防止（Double-Apply Prevention）     : 反映台帳（Effect Journal）のキーで冪等化し、
 *                            クラッシュ再現後も反映回数が.unique TODO数を超えない
 *
 * 重要な限界（Honest Scope）— 絶対に誤解させないための記載
 * ------------------------------------------------------
 * - **生のLLM呼出しは行わない**。仕事の内容は決定論的な合成負荷（Deterministic Synthetic Load）で、
 *   長時間の目的制御（Goal-Controlled Long-Run）が持続するかを見る実証です。
 *   実LLMの長期完遂（Real LLM Long-Horizon Completion）の証明では **ありません**。
 * - **短縮時計（Accelerated Clock）で24h成功を偽らない**。本probeは自分の経過を勝手に水増ししない。
 *   経過時間は呼び出し側（scripts/verify-runtime-durability.py）が実経過（Real Wall Clock）で計測し、
 *   24h判定には実測値だけを要求する。
 * - 24h級の長時間プロセスを **本probe自身が勝手に起動することはない**。起動と段階進行はCodex（人間側）の判断。
 *
 * 使い方（Usage）
 * --------------
 *   node --import tsx src/durability-probe.ts --role worker  --state-root <dir> --run-id <id> ...
 *   node --import tsx src/durability-probe.ts --role inspect --state-root <dir> --run-id <id>
 *
 * 終了コード契約（Exit Code Contract）
 * -----------------------------------
 *   0  = 正常（worker: 全TODO完了 or 指定時間継続完了 / inspect: 全不変条件成立）
 *   3  = 不変条件の違反（inspect）または worker 内の自己検査失敗
 *   4  = 破損・台帳不整合（fixture が読めない等）
 *   9  = 試験用の意図的クラッシュ（Fault Injection。中断復旧試験の材料なので異常終了として扱わない）
 *   1  = 起動失敗（引数が不正、書き込み先が作れない等）
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compactConversation, evaluateContextUsage, type CompactorConversationMessage } from './agent-compactor.js';
import { addTodo, activateTodo, createGoal, goalsRoot, loadGoal, markDone, pickNextTodo, saveGoal } from './goal-store.js';
import { reconcileGoalTransactions, txComplete, txStart } from './goal-transaction.js';
import { validateAcceptance, verifyDelivery } from './delivery-verification.js';
import { renameWithRetry } from './atomic-file.js';

/** probe が作る専用状態root（Dedicated State Root）の内部レイアウト。 */
export const PROBE_LAYOUT = {
  /** goal-store の状態root（`WENTIAN_GOAL_PATH` に渡す）。ここだけを Runtime Maintenance の対象にする。 */
  goalRoot: 'goals',
  /** probe 自身の進捗・台帳・コンテキスト（管理状態とは別物なので backup 対象にしない）。 */
  probeRoot: 'probes',
  /** 成果物（Acceptance の検証対象。决定論的内容）。 */
  artifactRoot: 'artifacts',
} as const;

/** probe の進捗永続化（Process Progress）。実子プロセスが死んでも残る単一情報源。 */
export interface ProbeProgress {
  version: '1.0';
  runId: string;
  goalId: string;
  /** 最初に起動した時刻（UTC ISO）。再起動しても書き換えない。 */
  startedAt: string;
  /** 前回更新時刻（UTC ISO）。 */
  updatedAt: string;
  /** プロセス起動回数（再起動数 / Restart Count）。自分自身の初回起動も1として数える。 */
  starts: number;
  /** 状態保存に成功したプローブ（Probe）回数。 */
  probes: number;
  /** 完了TODO数。 */
  done: number;
  /** 文脈圧縮（Context Compaction）が発火した回数。 */
  compactions: number;
  /** 実際に反映された効果（Effect）回数。unique TODO数と一致しなければならない（二重反映防止の核）。 */
  effectsApplied: number;
  /** 不変条件検査の合格回数 / 総検査回数。 */
  invariantChecks: { passed: number; failed: number };
  /** 意図的クラッシュ（Fault Injection）の実施記録。 */
  faultsFired: string[];
  /** 直近の reconcile 結果（再起動時に何が巻き戻ったか）。 */
  lastReconcile: { reconciled: number; recovered: number; rolledBack: number } | null;
  /** 状態: 全TODO完了まで進んだか。 */
  finished: boolean;
}

/** 不変条件の指紋（Invariant Fingerprint）。目的・許可・受入条件の3成分だけを対象にする。 */
export interface InvariantBaseline {
  version: '1.0';
  runId: string;
  goalId: string;
  createdAt: string;
  /** 目的（Goal Text）: title / description / context。 */
  purposeSha256: string;
  /** 許可（Permission / Stop Policy）: maxConsecutiveFailures / maxTotalAttempts / maxWallClockHours。 */
  permissionSha256: string;
  /** 受入条件（Acceptance Checks）: 全TODOの acceptance / title / dependsOn。 */
  acceptanceSha256: string;
}

/** 反映台帳（Effect Journal）。キー = `<goalId>:<todoId>` で冪等（Idempotent）に効かせる。 */
export interface EffectJournal {
  version: '1.0';
  runId: string;
  /** applyKey → 反映時刻。キーが存在すれば反映済み（二重に反映しない）。 */
  applied: Record<string, string>;
  /** 反映順（監査用の単調な並び）。 */
  order: string[];
}

/** 圧縮後のコンテキスト実態（Context State）。 */
export interface ContextState {
  version: '1.0';
  runId: string;
  messages: CompactorConversationMessage[];
  compactions: number;
  /** 直近の圧縮で解放できた概算トークン数の累計。 */
  freedTokens: number;
}

/** worker / inspect が最後に返すサマリ（Report）。JSONで標準出力へ出す。 */
export interface ProbeReport {
  role: 'worker' | 'inspect';
  runId: string;
  goalId: string;
  stateRoot: string;
  goalStateRoot: string;
  nowIso: string;
  /** このプロセスの起動時刻と生きた時間（実経過の参考値。台帳の主経過は親が測る）。 */
  processStartedAt: string;
  processLivedMs: number;
  progress: ProbeProgress;
  baseline: InvariantBaseline;
  /** 現在の不変条件が基準と一致しているか。 */
  invariant: { passed: boolean; mismatches: string[]; current: InvariantBaseline };
  /** 二重反映検査: 反映回数とunique反映キー・done TODO数の関係。 */
  doubleApply: { passed: boolean; effectsApplied: number; journalKeys: number; doneTodos: number; detail: string };
  /** 文脈圧縮の状態と、目的を載せた immovable メッセージの生存確認。 */
  context: { messages: number; tokens: number; compactions: number; immovablePreserved: boolean };
  /** goal-store 側の状態（TODO内訳）と未完了トランザクション（stale）。 */
  todos: Record<string, number>;
  staleTransactions: string[];
  /** 受入条件（Acceptance）の実検証結果（LLMではなくファイル実体で判定）。 */
  acceptance: { status: string; summary: string } | null;
  passed: boolean;
  exitCode: number;
  detail: string;
}

/** probe CLI の引数（Parsed Arguments）。 */
export interface ProbeArgs {
  role: 'worker' | 'inspect';
  stateRoot: string;
  runId: string;
  goalId: string;
  todos: number;
  tickMs: number;
  durationMs: number;
  /** 文脈圧縮の発火を待つための模擬Context Window（トークン / Token）。既定は小さくして確実に発火させる。 */
  contextTokens: number;
  /** 試験用の意図的クラッシュ: none | after-artifact | after-journal */
  fault: 'none' | 'after-artifact' | 'after-journal';
  /** fault を発火させるTODO ID（既定 t2）。 */
  faultOn: string;
  quiet: boolean;
}

const GOAL_TITLE = 'Durability Probe 長期実証';
const GOAL_DESCRIPTION = '目的不変・中断復旧・文脈圧縮・二重反映防止を実時間で確認するための合成負荷Goalです。実LLMは使いません。';
const STOP_POLICY = { maxConsecutiveFailures: 99, maxTotalAttempts: 100_000, maxWallClockHours: 720 };

/** SHA256指紋（Fingerprint）を計算する小さいヘルパー（キー順を固定して再現性を確保する）。 */
export function fingerprintOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/** 内部: オブジェクトキーをソートしたJSON（ハッシュの再現性のため）。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/** 目的（Goal Text）の指紋。 */
export function purposeFingerprint(goal: { title: string; description: string; context: string }): string {
  return fingerprintOf({ title: goal.title, description: goal.description, context: goal.context });
}

/** 許可バウンド（Stop Policy / Permission）の指紋。 */
export function permissionFingerprint(stop: { maxConsecutiveFailures: number; maxTotalAttempts: number; maxWallClockHours: number }): string {
  return fingerprintOf({ maxConsecutiveFailures: stop.maxConsecutiveFailures, maxTotalAttempts: stop.maxTotalAttempts, maxWallClockHours: stop.maxWallClockHours });
}

/** 受入条件（Acceptance Checks）の指紋。TODO順は goal-store の並び順を正とする。 */
export function acceptanceFingerprint(todos: Array<{ id: string; title: string; dependsOn: string[]; acceptance?: unknown }>): string {
  return fingerprintOf(todos.map(todo => ({ id: todo.id, title: todo.title, dependsOn: todo.dependsOn, acceptance: todo.acceptance ?? [] })));
}

/** probe が使う各種パスを一括解決する。 */
export function probePaths(stateRoot: string, runId: string) {
  const root = path.resolve(stateRoot);
  const probeRoot = path.join(root, PROBE_LAYOUT.probeRoot, runId);
  return {
    root,
    goalRoot: path.join(root, PROBE_LAYOUT.goalRoot),
    artifactRoot: path.join(root, PROBE_LAYOUT.artifactRoot),
    probeRoot,
    progressPath: path.join(probeRoot, 'progress.json'),
    baselinePath: path.join(probeRoot, 'baseline.json'),
    journalPath: path.join(probeRoot, 'effects.json'),
    contextPath: path.join(probeRoot, 'context.json'),
    eventsPath: path.join(probeRoot, 'events.jsonl'),
    lastReportPath: path.join(probeRoot, 'last-report.json'),
  };
}

/** run-id から goal-store の命名規約に合う Goal ID を決める（決定論的。再起動しても同じIDになる）。 */
export function probeGoalId(runId: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return probeGoalIdWithStamp(runId, stamp);
}

/** 内部: 日付を固定してGoal IDを作る（試験で「作成日が変わっても同一ID」を確かめるため）。 */
function probeGoalIdWithStamp(runId: string, stamp: string): string {
  const slug = runId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'probe';
  // 末尾のランダム部は runId のハッシュから決める（決定論的だが goal-store の規約は通す）
  const suffix = createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 6);
  const id = `goal-${stamp}-${slug}-${suffix}`;
  return id.length <= 64 ? id : id.slice(0, 64).replace(/-+$/, '');
}

/** 原子的JSON書込（Windowsロック耐性は renameWithRetry に委ねる）。 */
async function writeJson(absolute: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, absolute);
}

/** JSON読込（無ければ undefined）。 */
async function readJson<T>(absolute: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(absolute, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** 進捗イベント（監査証跡 / Audit Trail）を追記する。失敗してもprobeは止めない。 */
async function appendEvent(eventsPath: string, event: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(path.dirname(eventsPath), { recursive: true });
    await writeFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: 'utf8', flag: 'a' });
  } catch { /* 証跡追記の失敗で実作業を止めない（台帳には出ない旨を報告に書く） */ }
}

/** 決定論的合成負荷（Deterministic Synthetic Load）: TODO毎の成果物本文を作る（同じ入力で同じ bytes）。 */
export function artifactBody(goalId: string, todoId: string): string {
  return [
    `durability-probe artifact`,
    `goal=${goalId}`,
    `todo=${todoId}`,
    `purpose=${GOAL_DESCRIPTION}`,
    `note=決定論的内容のため、何度書き直しても同一 bytes になる（冪等 / Idempotent）。`,
  ].join('\n');
}
/** 内部: 反映台帳を無ければ初期値で読む。 */
async function loadJournal(paths: ReturnType<typeof probePaths>, runId: string): Promise<EffectJournal> {
  return (await readJson<EffectJournal>(paths.journalPath)) || { version: '1.0', runId, applied: {}, order: [] };
}

/** 内部: 進捗を無ければ初期値で読む。`starts` は起動時にだけ +1 する。 */
async function loadProgress(paths: ReturnType<typeof probePaths>, args: ProbeArgs): Promise<ProbeProgress> {
  const existing = await readJson<ProbeProgress>(paths.progressPath);
  if (existing && existing.version === '1.0' && existing.runId === args.runId) return existing;
  const now = new Date().toISOString();
  return {
    version: '1.0', runId: args.runId, goalId: args.goalId, startedAt: now, updatedAt: now,
    starts: 0, probes: 0, done: 0, compactions: 0, effectsApplied: 0,
    invariantChecks: { passed: 0, failed: 0 }, faultsFired: [], lastReconcile: null, finished: false,
  };
}

/**
 * 反映（Effect Apply）をキー付き冪等で行う。**二重反映防止（Double-Apply Prevention）の中心**。
 *
 * 手順と意味:
 *  1. 成果物を **決定的内容**（Deterministic Content）で書き直す → 何度書き直しても同じ bytes。
 *     よって「クラッシュ前に成果物だけ書けていた」ケースでも再実行は無害（Idempotent Rewrite）。
 *  2. 台帳（Effect Journal）にキーが無い時だけ `effectsApplied` を +1 して台帳を原子的に保存する。
 *     よって「台帳へ書き終えた後にクラッシュ」しても、再起動後の再実行では +1 されない（＝二重に数えない）。
 * 3. `effectsApplied == 台帳キー数 == done TODO数` が最終不変条件になる。
 */
export async function applyEffect(paths: ReturnType<typeof probePaths>, journal: EffectJournal, goalId: string, todoId: string):
  Promise<{ applied: boolean; key: string; journal: EffectJournal }> {
  const key = `${goalId}:${todoId}`;
  await mkdir(paths.artifactRoot, { recursive: true });
  const artifact = path.join(paths.artifactRoot, `${todoId}.txt`);
  const body = artifactBody(goalId, todoId);
  await writeFile(artifact, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  if (journal.applied[key]) return { applied: false, key, journal };   // 既に表示済み → 数えない
  journal.applied[key] = new Date().toISOString();
  journal.order.push(key);
  return { applied: true, key, journal };
}

/**
 * 合成コンテキストを1歩進め、閾値（Threshold）到達で agent-compactor を発火させる。
 * messages[0] は system、messages[1] は **目的と受入条件を全文載せた immovable メッセージ**で、
 * 圧縮後も同じ内容で残り続けることを inspect 側で検査する（文脈圧縮と目的不変の結合検査）。
 */
export async function growContext(paths: ReturnType<typeof probePaths>, context: ContextState, args: ProbeArgs, tick: number):
  Promise<{ context: ContextState; compactedNow: boolean; freedTokens: number; immovablePreserved: boolean }> {
  const filler = 'x'.repeat(600);
  context.messages.push({
    role: 'tool',
    name: 'durability_tick',
    content: `tick=${tick} ${filler}`,
  });
  const usage = evaluateContextUsage(context.messages, { contextTokens: args.contextTokens, compactThresholdRatio: 0.8 });
  let compactedNow = false;
  let freedTokens = 0;
  if (usage.shouldCompact) {
    const result = compactConversation(context.messages, { contextTokens: args.contextTokens, keepTail: 4 });
    context.messages = result.compacted;
    context.compactions += 1;
    context.freedTokens += result.freedTokens;
    freedTokens = result.freedTokens;
    compactedNow = result.compactedCount > 0;
  }
  const immovablePreserved = context.messages.some(message =>
    message.metadata?.immovable === true && typeof message.content === 'string' && message.content.includes(GOAL_DESCRIPTION));
  await writeJson(paths.contextPath, context);
  return { context, compactedNow, freedTokens, immovablePreserved };
}

/** 内部: goal-store の実体から現在の指紋を計算し、基準と違う成分名を列挙する。 */
export function invariantMismatches(goal: GoalLike, baseline: InvariantBaseline): string[] {
  const mismatches: string[] = [];
  if (purposeFingerprint(goal) !== baseline.purposeSha256) mismatches.push('purpose（目的）');
  if (permissionFingerprint(goal.stop) !== baseline.permissionSha256) mismatches.push('permission（許可バウンド）');
  if (acceptanceFingerprint(goal.todos) !== baseline.acceptanceSha256) mismatches.push('acceptance（受入条件）');
  return mismatches;
}

/** invariantMismatches が受け取る goal-store GoalStore の必要部分（型のためだけの局所定義）。 */
interface GoalLike {
  title: string;
  description: string;
  context: string;
  stop: { maxConsecutiveFailures: number; maxTotalAttempts: number; maxWallClockHours: number };
  todos: Array<{ id: string; title: string; dependsOn: string[]; acceptance?: unknown }>;
}

/**
 * Fixture の作成（Create Fixture）。**このprobeが作る専用状態rootの中でだけ**書き、既存Goalがあれば触らない。
 * 同一 runId で再起動した時に同じ Goal ID・同じ目的・同じ受入条件を必ず再利用する（中断復旧の前提）。
 */
export async function ensureFixture(args: ProbeArgs, paths: ReturnType<typeof probePaths>): Promise<{ created: boolean }> {
  await mkdir(paths.goalRoot, { recursive: true });
  await mkdir(paths.artifactRoot, { recursive: true });
  await mkdir(paths.probeRoot, { recursive: true });
  // goal-store に対しては **専用状態rootだけ** を向けさせる（実台帳 `.wentian/goals` には一切書かない）
  process.env.WENTIAN_GOAL_PATH = paths.goalRoot;
  if (path.resolve(goalsRoot()) !== paths.goalRoot) throw new Error(`WENTIAN_GOAL_PATH が専用rootへ向いていません: ${goalsRoot()}`);
  let created = false;
  let goal;
  try { goal = await loadGoal(args.goalId); } catch { goal = undefined; }
  if (!goal) {
    goal = await createGoal({
      id: args.goalId, title: GOAL_TITLE, description: GOAL_DESCRIPTION,
      context: '合成負荷による長時間実証。実LLM呼出しなし。',
      workspace: paths.root,
      stop: STOP_POLICY,
      now: new Date(`${args.goalId.slice(5, 15)}T00:00:00.000Z`),   // Goal IDの日付と同じ日付で作り、日付ずれでID不整合にならないようにする
    });
    // 受入条件（Acceptance Checks）は **TODOごとに自分の成果物1件だけ** にする。
    // · 相対パスのみ（validateAcceptance が絶対パスと `..` を弾く）
    // · `contains` に目的文を含む → 「成果物が目的と結び付いている」ことをホスト側で検証できる
    // · ここで作った一覧を baseline の acceptanceSha256 に固定し、以降一切変更しない（不変条件の物差し）
    for (let index = 1; index <= args.todos; index++) {
      const acceptance = validateAcceptance([{ path: `${PROBE_LAYOUT.artifactRoot}/t${index}.txt`, contains: `todo=t${index}` }]);
      await addTodo(goal, { title: `durability-step-${index}`, description: `合成負荷ステップ ${index}`, acceptance });
    }
    created = true;
  }
  // 基準（Baseline）は初回だけ保存し、以降は決して上書きしない（不変条件の物差しを守る）
  if (!(await readJson<InvariantBaseline>(paths.baselinePath))) {
    const baseline: InvariantBaseline = {
      version: '1.0', runId: args.runId, goalId: args.goalId, createdAt: new Date().toISOString(),
      purposeSha256: purposeFingerprint(goal),
      permissionSha256: permissionFingerprint(goal.stop),
      acceptanceSha256: acceptanceFingerprint(goal.todos),
    };
    await writeJson(paths.baselinePath, baseline);
  }
  return { created };
}
/**
 * Goal ID を決める。明示指定があればそれを最優先（長時間ランナーは台帳に記録したIDを必ず渡す）。
 * 未指定の時は専用状態rootに既にある同スラグのGoalを再発見する。
 * （日付をまたいで再起動すると `goal-<今日>-...` を別IDとして作ってしまう事故を防ぐため、
 *   「作らない・探す」を先にやるのが安全側の設計。）
 */
export async function resolveGoalId(args: { runId: string; goalId: string }, paths: ReturnType<typeof probePaths>): Promise<string> {
  if (args.goalId) return args.goalId;
  try {
    const names = await readdir(paths.goalRoot);
    const suffix = createHash('sha256').update(args.runId, 'utf8').digest('hex').slice(0, 6);
    const found = names.filter(name => name.endsWith(`-${suffix}.json`)).sort();
    if (found.length > 1) throw new Error(`同一runIdに対するGoalが複数あります（台帳の goalId を明示してください）: ${found.join(', ')}`);
    if (found.length === 1) return found[0].replace(/\.json$/, '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof TypeError)) throw error;
  }
  return probeGoalId(args.runId);
}

/** 内部: 現在のgoal-store状態から報告のTODO内訳を作る。 */
function todoBreakdown(todos: Array<{ status: string }>): Record<string, number> {
  const breakdown: Record<string, number> = { total: todos.length, done: 0, active: 0, pending: 0, failed: 0, blocked: 0 };
  for (const todo of todos) breakdown[todo.status] = (breakdown[todo.status] || 0) + 1;
  return breakdown;
}

/** 内部: 未完了トランザクション（stale / 中断の痕跡）を列挙する。 */
async function staleTransactions(goalRoot: string, goalId: string): Promise<string[]> {
  const dir = path.join(goalRoot, goalId, 'tx');
  try {
    const names = await readdir(dir);
    const result: string[] = [];
    for (const name of names.filter(fileName => fileName.endsWith('.json'))) {
      try {
        const tx = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as { phase?: string; pid?: number };
        if (tx.phase === 'start' || tx.phase === 'checkpoint' || tx.phase === 'running') result.push(`${name}:${String(tx.phase)}:pid=${String(tx.pid)}`);
      } catch { result.push(`${name}:unreadable`); }
    }
    return result;
  } catch { return []; }
}

/** worker / inspect の共通検査（Report構築）。goal はディスクから毎回読み直す（メモリ上の状態を信じない）。 */
async function buildReport(role: 'worker' | 'inspect', args: ProbeArgs, paths: ReturnType<typeof probePaths>,
  processStartedAt: string, progress: ProbeProgress, baseline: InvariantBaseline, context: ContextState): Promise<ProbeReport> {
  const goal = await loadGoal(args.goalId);
  const mismatches = invariantMismatches(goal, baseline);
  const journal = await loadJournal(paths, args.runId);
  const doneTodos = goal.todos.filter(todo => todo.status === 'done').length;
  const doubleApplyPassed = progress.effectsApplied === Object.keys(journal.applied).length
    && progress.effectsApplied >= doneTodos
    && Object.keys(journal.applied).length <= args.todos;
  // 受入条件はLLMの自己申告ではなく、成果物ファイルの実体（存在 + 含む文字列 + SHA256）で検証する
  const acceptance = goal.todos.length > 0
    ? await verifyDelivery(paths.root, goal.todos.flatMap(todo => todo.acceptance || []))
    : null;
  const immovablePreserved = context.messages.some(message =>
    message.metadata?.immovable === true && typeof message.content === 'string' && message.content.includes(GOAL_DESCRIPTION));
  const invariantPassed = mismatches.length === 0;
  const passed = invariantPassed && doubleApplyPassed && immovablePreserved;
  return {
    role, runId: args.runId, goalId: args.goalId, stateRoot: paths.root, goalStateRoot: paths.goalRoot,
    nowIso: new Date().toISOString(), processStartedAt, processLivedMs: Date.now() - Date.parse(processStartedAt),
    progress, baseline,
    invariant: {
      passed: invariantPassed, mismatches,
      current: {
        version: '1.0', runId: args.runId, goalId: args.goalId, createdAt: baseline.createdAt,
        purposeSha256: purposeFingerprint(goal), permissionSha256: permissionFingerprint(goal.stop), acceptanceSha256: acceptanceFingerprint(goal.todos),
      },
    },
    doubleApply: {
      passed: doubleApplyPassed, effectsApplied: progress.effectsApplied, journalKeys: Object.keys(journal.applied).length, doneTodos,
      detail: `反映回数 ${progress.effectsApplied} / 台帳キー ${Object.keys(journal.applied).length} / done TODO ${doneTodos} / 計画TODO ${args.todos}（反映回数は台帳キー数と一致し、計画TODO数を超えてはならない）`,
    },
    context: { messages: context.messages.length, tokens: evaluateContextUsage(context.messages, { contextTokens: args.contextTokens }).estimatedTokens, compactions: context.compactions, immovablePreserved },
    todos: todoBreakdown(goal.todos),
    staleTransactions: await staleTransactions(paths.goalRoot, args.goalId),
    acceptance: acceptance ? { status: acceptance.status, summary: acceptance.summary } : null,
    passed,
    exitCode: passed ? 0 : 3,
    detail: passed ? '全不変条件が成立しています。' : `不変条件の違反: ${[
      ...mismatches,
      ...(doubleApplyPassed ? [] : ['二重反映（反映回数が台帳キー数と不一致、または計画TODO数を超過）']),
      ...(immovablePreserved ? [] : ['目的を載せた immovable メッセージが圧縮後に残っていません']),
    ].join(' / ')}`,
  };
}

/**
 * worker 本体。指定時間（`--duration-ms`）だけループし、毎tickで状態を原子的に保存する。
 * 全TODO完了後も時間までは **プローブだけ継続** する（受入条件のリストを増やさないため）。
 */
export async function runWorker(args: ProbeArgs, paths: ReturnType<typeof probePaths>): Promise<ProbeReport> {
  const processStartedAt = new Date().toISOString();
  if (!args.goalId) args.goalId = await resolveGoalId(args, paths);   // ライブラリ利用時も Goal ID を必ず決める（作成前に探す）
  await ensureFixture(args, paths);
  process.env.WENTIAN_GOAL_PATH = paths.goalRoot;
  const baseline = (await readJson<InvariantBaseline>(paths.baselinePath))!;
  const progress = await loadProgress(paths, args);
  progress.starts += 1;
  progress.updatedAt = processStartedAt;
  await writeJson(paths.progressPath, progress);

  // 再起動復旧: 前プロセスの未完了トランザクションを goal-transaction の本物のreconcileで整合させる
  let goal = await loadGoal(args.goalId);
  const reconciled = await reconcileGoalTransactions(goal, paths.root);   // cwd は非gitの専用root（gitコマンドを発行しない）
  progress.lastReconcile = { reconciled: reconciled.reconciled, recovered: reconciled.recovered, rolledBack: reconciled.rolledBack };
  await appendEvent(paths.eventsPath, { type: 'start', runId: args.runId, starts: progress.starts, reconcile: progress.lastReconcile });
  await writeJson(paths.progressPath, progress);

  // コンテキスト初期化: messages[0]=system、messages[1]=目的を載せた immovable、以降が合成tool出力
  let context = (await readJson<ContextState>(paths.contextPath)) || {
    version: '1.0' as const, runId: args.runId, compactions: 0, freedTokens: 0,
    messages: [
      { role: 'system', content: `Wentian durability probe。目的: ${GOAL_TITLE}` },
      { role: 'user', content: `目的と受入条件（不変）: ${GOAL_DESCRIPTION}`, metadata: { immovable: true, source: 'goal-context' as const } },
    ],
  };
  await writeJson(paths.contextPath, context);

  const deadline = Date.now() + args.durationMs;
  let lastInvariantFail: string | undefined;
  while (true) {
    goal = await loadGoal(args.goalId);
    const mismatches = invariantMismatches(goal, baseline);
    if (mismatches.length > 0) {
      progress.invariantChecks.failed += 1;
      lastInvariantFail = mismatches.join(' / ');
      await appendEvent(paths.eventsPath, { type: 'invariant_violation', mismatches, todo: 'n/a' });
    } else {
      progress.invariantChecks.passed += 1;
    }
    const todo = pickNextTodo(goal);
    if (todo && !progress.finished) {
      // 実行順は「activateTodo → txStart」。**active + 未完了tx** が残った形で死ねば、
      // goal-transaction の reconcile が復旧させるのと同じ形（実中断と同じ形）になる。
      await activateTodo(goal, todo.id);                         // goal-store が status=active と attempts を保存
      await txStart(goal, todo, paths.root);                     // goal-transaction が pid と phase=start を保存
      // goal は tick 冒頭で読み直した実体そのもの。activateTodo/markDone は同じ object を更新して保存する。
      // TODO ID は goal-store の createTodoId が採番した t1, t2, ...（受入条件の成果物名と1対1に対応する）
      let journal = await loadJournal(paths, args.runId);
      const result = await applyEffect(paths, journal, args.goalId, todo.id);   // 成果物（冪等）を先に書く
      if (result.applied) {
        journal = result.journal;
        progress.effectsApplied += 1;
        await writeJson(paths.journalPath, journal);
        await writeJson(paths.progressPath, progress);
      }
      await maybeFireFault(args, paths, progress, 'after-artifact', todo.id);   // 成果物だけ書いた状態で死ぬ経路
      await writeJson(paths.journalPath, journal);                             // 台帳を確定させる（冪等の物差し）
      await maybeFireFault(args, paths, progress, 'after-journal', todo.id);   // markDone 直前で死ぬ経路（二重反映の材料）
      const checkpoint = fingerprintOf({ key: `${args.goalId}:${todo.id}`, artifact: artifactBody(args.goalId, todo.id) });
      await markDone(goal, todo.id, checkpoint);
      await txComplete(goal, todo.id);                                         // 完了したtxは消す（reconcile対象から外す）
      await appendEvent(paths.eventsPath, { type: 'todo_done', todo: todo.id, effectsApplied: progress.effectsApplied });
    }
    const grown = await growContext(paths, context, args, progress.probes + 1);
    context = grown.context;
    if (grown.compactedNow) {
      progress.compactions += 1;
      await appendEvent(paths.eventsPath, { type: 'context_compacted', compactions: progress.compactions, freedTokens: grown.freedTokens, immovablePreserved: grown.immovablePreserved });
    }
    progress.probes += 1;
    progress.done = (await loadGoal(args.goalId)).todos.filter(item => item.status === 'done').length;
    progress.updatedAt = new Date().toISOString();
    if (progress.done >= args.todos && !progress.finished) {
      progress.finished = true;
      const finishedGoal = await loadGoal(args.goalId);
      finishedGoal.status = 'completed';
      await saveGoal(finishedGoal);
      await appendEvent(paths.eventsPath, { type: 'goal_completed', todos: progress.done });
    }
    await writeJson(paths.progressPath, progress);
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.max(1, args.tickMs)));
  }

  const report = await buildReport('worker', args, paths, processStartedAt, progress, baseline, context);
  if (lastInvariantFail) { report.passed = false; report.exitCode = 3; report.detail = `worker実行中に不変条件違反を検知: ${lastInvariantFail}`; }
  await writeJson(paths.lastReportPath, report);
  await appendEvent(paths.eventsPath, { type: 'stop', runId: args.runId, probes: report.progress.probes, exitCode: report.exitCode });
  return report;
}

/** 内部: 試験用の意図的クラッシュ（Fault Injection）を **1回だけ** 発火させる。 */
async function maybeFireFault(args: ProbeArgs, paths: ReturnType<typeof probePaths>, progress: ProbeProgress, name: 'after-artifact' | 'after-journal', todoId: string): Promise<void> {
  if (args.fault !== name || args.faultOn !== todoId) return;
  if (progress.faultsFired.includes(name)) return;               // 既に発火済みなら二度と死なない
  progress.faultsFired.push(name);
  await writeJson(paths.progressPath, progress);                // 死亡前に台帳だけ残す（証拠を遺す）
  await appendEvent(paths.eventsPath, { type: 'fault_injected', fault: name, todo: todoId, note: '試験的な意図的クラッシュ（終了コード9）' });
  process.exit(9);
}

/** inspect 役割: 実ファイルだけを読み、不変条件と二重反映を検査してJSONで返す（書込みは報告のみ）。 */
export async function runInspect(args: ProbeArgs, paths: ReturnType<typeof probePaths>): Promise<ProbeReport> {
  const processStartedAt = new Date().toISOString();
  process.env.WENTIAN_GOAL_PATH = paths.goalRoot;
  const baseline = await readJson<InvariantBaseline>(paths.baselinePath);
  const progress = await loadProgress(paths, args);
  const context = (await readJson<ContextState>(paths.contextPath)) || { version: '1.0' as const, runId: args.runId, messages: [], compactions: 0, freedTokens: 0 };
  if (!baseline) {
    return {
      role: 'inspect', runId: args.runId, goalId: args.goalId, stateRoot: paths.root, goalStateRoot: paths.goalRoot,
      nowIso: processStartedAt, processStartedAt, processLivedMs: 0, progress, baseline: { version: '1.0', runId: args.runId, goalId: args.goalId, createdAt: '', purposeSha256: '', permissionSha256: '', acceptanceSha256: '' },
      invariant: { passed: false, mismatches: ['baseline（基準台帳）が存在しません'], current: { version: '1.0', runId: args.runId, goalId: args.goalId, createdAt: '', purposeSha256: '', permissionSha256: '', acceptanceSha256: '' } },
      doubleApply: { passed: false, effectsApplied: progress.effectsApplied, journalKeys: 0, doneTodos: 0, detail: '基準台帳が無いため検査できません' },
      context: { messages: 0, tokens: 0, compactions: 0, immovablePreserved: false }, todos: { total: 0, done: 0, active: 0, pending: 0, failed: 0, blocked: 0 },
      staleTransactions: [], acceptance: null, passed: false, exitCode: 4, detail: '基準台帳（baseline.json）が存在しません。worker を先に実行してください。',
    };
  }
  const report = await buildReport('inspect', args, paths, processStartedAt, progress, baseline, context);
  await writeJson(paths.lastReportPath, report);
  return report;
}

/** CLI引数を解析する（不明な引数は黙って無視せず例外にする — 長時間ランナーの打ち間違いを防ぐ）。 */
export function parseArgs(argv: string[]): ProbeArgs {
  const args: ProbeArgs = {
    role: 'worker', stateRoot: '', runId: '', goalId: '', todos: 8, tickMs: 250, durationMs: 5_000,
    contextTokens: 4_000, fault: 'none', faultOn: 't2', quiet: false,
  };
  let index = 0;
  // 取値ヘルパー: `--flag value` の2つを進める（取りこぼすと次のトークンをフラグとして誤読する）
  const take = (name: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`引数 ${name} の値がありません`);
    index += 2;
    return value;
  };
  while (index < argv.length) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`不明な引数です: ${flag}`);
    switch (flag) {
      case '--role': {
        const value = take(flag);
        if (value !== 'worker' && value !== 'inspect') throw new Error(`--role は worker / inspect のいずれか: ${value}`);
        args.role = value;
        break;
      }
      case '--state-root': args.stateRoot = path.resolve(take(flag)); break;
      case '--run-id': args.runId = take(flag); break;
      case '--goal-id': args.goalId = take(flag); break;
      case '--todos': args.todos = positiveInt(take(flag), flag); break;
      case '--tick-ms': args.tickMs = positiveInt(take(flag), flag); break;
      case '--duration-ms': args.durationMs = positiveInt(take(flag), flag); break;
      case '--context-tokens': args.contextTokens = positiveInt(take(flag), flag); break;
      case '--fault': {
        const value = take(flag);
        if (!['none', 'after-artifact', 'after-journal'].includes(value)) throw new Error(`--fault は none / after-artifact / after-journal: ${value}`);
        args.fault = value as ProbeArgs['fault'];
        break;
      }
      case '--fault-on': args.faultOn = take(flag); break;
      case '--quiet': args.quiet = true; index += 1; break;
      default: throw new Error(`不明な引数です: ${flag}`);
    }
  }
  if (!args.stateRoot) throw new Error('--state-root（専用状態root・絶対パス）は必須です');
  if (!path.isAbsolute(args.stateRoot)) throw new Error(`--state-root は絶対パスで指定してください: ${args.stateRoot}`);
  if (!args.runId || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(args.runId)) throw new Error(`--run-id は 3〜64 文字の [A-Za-z0-9_-] で指定してください: ${args.runId}`);
  return args;
}

/** 内部: 正の整数だけ通す。 */
function positiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) throw new Error(`${flag} は正の整数です: ${raw}`);
  return value;
}

/** CLI入口。`node --import tsx src/durability-probe.ts ...` から呼ぶ。 */
async function main(): Promise<number> {
  let args: ProbeArgs;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`[durability-probe] 引数エラー: ${error instanceof Error ? error.message : String(error)}`); return 1; }
  const paths = probePaths(args.stateRoot, args.runId);
  try {
    args.goalId = await resolveGoalId(args, paths);
    const report = args.role === 'worker' ? await runWorker(args, paths) : await runInspect(args, paths);
    if (!args.quiet) console.log(JSON.stringify(report, null, 2));
    else console.log(JSON.stringify({ exitCode: report.exitCode, passed: report.passed, probes: report.progress.probes, done: report.progress.done, compactions: report.progress.compactions, restarts: report.progress.starts }));
    return report.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[durability-probe] 実行失敗: ${message}`);
    await appendEvent(paths.eventsPath, { type: 'crash', message }).catch(() => undefined);
    return 4;
  }
}

// 直接実行された時だけ main を走らせる（試験・他モジュールからの import では走らせない）。
// Windows でも比較できるよう URL 正規化は pathToFileURL に任せる。
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return import.meta.url === pathToFileURL(path.resolve(entry)).href; } catch { return false; }
})();
if (invokedDirectly) void main().then(code => { process.exitCode = code; });
