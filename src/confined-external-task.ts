/**
 * 限定外部エージェント実行（Confined External Task / 限定外部タスク）— P0
 *
 * 目的: 現在の外部CLI（goose・crush・Kilo・OpenCode・Hermes・Cline・OpenClaw）は
 * 「書き込み許可パスの部分制限」をCLI側で強制できず、Gatewayは起動を拒否してきた
 * （external-orchestrator.ts の file_write + 限定範囲 で blocked になる既存動作）。
 * Claude だけがローカルhelpで確認済みの旗（Flag）により「全Tool無効・子Agent無効・
 * MCP無効・Hook無効・スラッシュコマンド無効・非対話1ターン」で起動できるため、
 * 次の限定モードだけをこのモジュールで実装する。
 *
 *   1. ホスト（Wentian本体）だけが許可された通常ファイルの入力を読み、依頼文へ添える。
 *   2. Claudeには Read/Write/Bash/子Agent/MCP/Hook/Skill を一切渡さない。
 *      返答は JSON `{"changes":[{"path":"...","content":"..."}]}` の変更提案のみ。
 *   3. 外部CLIは「変更提案を作るだけ」。実ファイルへの適用・受入試験・原本反映は
 *      すべてホスト側で行う: JSON検査 → executeAgentTool(write_file) で隔離作業場所へ
 *      適用 → runDirectTask の隔離・ホスト固定受入（acceptance）→ 合格分だけ原本へ反映。
 *
 * 正直な境界（OSサンドボックス偽装の禁止）:
 *  - これはOSのサンドボックス（Sandbox）ではなく、CLIの旗とホスト側検証による約束（Contract）です。
 *  - 対応版は claude CLI 2.1.287 でローカル `claude --help`（2026-10-04 実測・非通信）で
 *    確認した旗のみ使用。`--permission-prompts none` は 2.1.287 のhelpに存在しないため不使用
 *    （`--permission-mode dontAsk` で代替）。想定外CLI・未確認版にはこの起動形式を保証しません。
 *  - WindowsのCreateProcessコマンド行上限（約32,767文字）に収められない依頼は起動前に拒否します。
 *
 * 禁止の強制点（多層防御）:
 *  - 依頼本文・入力添付・変更提案の全パスで秘密名（.env/key/password/認証台帳等）を拒否。
 *  - 許可書込みパスは具体ファイルのみ（ディレクトリ・全体「.」・ワイルドカード拒否）。
 *  - 変更提案に run_command 等の未知キーがあっても記録して無視。ホストは決して実行しない。
 *  - 受入条件（acceptanceChecks / プロジェクトの受入設定）が未設定ならCLIを起動せず needs_review。
 *  - 依頼生データ（prompt）・Claude応答生データは台帳・API応答・返値へ載せない。
 */
import { existsSync, lstatSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runExternalCommand } from './external-orchestrator.js';
import { executeAgentTool, resolveWorkspacePath } from './agent-tools.js';
import { normalizeWritePaths } from './execution-policy.js';
import { runDirectTask } from './direct-task.js';
import { loadAcceptancePlan } from './acceptance-verification.js';
import { validateAcceptance, type AcceptanceCheck } from './delivery-verification.js';
import { taskOutcome, type TaskOutcome } from './task-outcome.js';
import type { AgentPlan } from './agent-planner.js';

/** 旗の対応を確認したCLIバージョン。これ以外への対応は未検証（保証しない）。 */
export const CONFINED_CLAUDE_VERSION_VERIFIED = '2.1.287';

/** 未確認のCLI版では、安全用の旗（Flag）が有効とは判定せず起動を拒否する。 */
export function assertVerifiedClaudeVersion(output: string): void {
  if (!new RegExp(`^${CONFINED_CLAUDE_VERSION_VERIFIED.replaceAll('.', '\\.')}(?:\\s|$)`).test(output.trim())) throw new Error('限定実行に対応確認済みのClaude CLI版ではありません。旗の再検証が必要です。');
}

/* ---- 上限（Limits）。入力は「20件・合計100KiB程度」、提案はUTF-8サイズ合計検査。 ---- */
export const CONFINED_LIMITS = {
  /** 入力添付ファイルの最大個数。 */
  maxInputFiles: 20,
  /** 入力添付ファイルの合計バイト上限（100KiB）。 */
  maxInputTotalBytes: 100 * 1024,
  /** 入力添付1ファイルのバイト上限（Windowsコマンド行上限との両立のため100KiB未満に絞る）。 */
  maxInputFileBytes: 32 * 1024,
  /** 依頼本文（prompt）の文字数上限。 */
  maxPromptChars: 20_000,
  /** CLI引数（プロンプト全体）のコマンド行予算。Windowsの32,767文字上限より安全側に絞る。 */
  maxCommandLineChars: 30_000,
  /** 変更提案の最大件数。 */
  maxChanges: 20,
  /** 変更1件のcontentバイト上限。 */
  maxChangeItemBytes: 128 * 1024,
  /** 変更提案の合計バイト上限。 */
  maxChangeTotalBytes: 256 * 1024,
  /** 許可書込みパスの最大個数。 */
  maxAllowedPaths: 20,
  /** 外部CLI既定Timeout（ミリ秒）。 */
  defaultTimeoutMs: 600_000,
} as const;

/** 秘密ファイル名パタン（入力・許可パス・提案パス共通）。.env鍵・認証台帳・個人鍵等を拒否。 */
const SECRET_NAME = /(?:^|[\\/])\.env(?:$|[.\\/])|[.]env$|secret|credential|password|passwd|api[-_]?key|access[-_]?token|id_rsa|authorized_keys|[.](pem|pfx|p12|key|keystore)$/i;
/** 認証台帳など管理ファイル（ファイル名の一部文字列で拒否）。 */
const SECRET_LEDGER = /(?:control[-_]?(?:center[-_]?)?users|agent[-_]?registry|wentian[-_]?users|session[-_]?token|認証台帳|認証情報|資格情報)/i;
/** 作業場所でも触らせない管理用ディレクトリ区間。 */
const FORBIDDEN_SEGMENT = /(?:^|[/\\])(?:\.git|\.wentian|node_modules|dist|build|__pycache__|\.venv|venv)(?:$|[/\\])/i;

/** 秘密名・管理区間を含むパスを拒否する（fail-closed: 怪しければ常に拒否）。 */
function assertNotSecretPath(requested: string, label: string): void {
  const normalized = requested.replaceAll('\\', '/');
  if (SECRET_NAME.test(normalized) || SECRET_LEDGER.test(normalized)) throw new Error(`${label}に秘密情報・認証台帳らしきパスを指定できません: ${normalized}`);
  if (FORBIDDEN_SEGMENT.test(normalized)) throw new Error(`${label}に管理用領域を指定できません: ${normalized}`);
}

/** npm実体（node_modules配下の本体）を優先解決する。無ければPATH上のCLI名へ落とす。 */
function npmPackageEntry(packageName: string, relativeEntry: string): string | undefined {
  const npmRoot = process.env['npm_config_prefix'] || (process.env['APPDATA'] ? path.join(process.env['APPDATA'] ?? '', 'npm') : undefined);
  const entry = npmRoot ? path.join(npmRoot, 'node_modules', ...packageName.split('/'), ...relativeEntry.split('/')) : undefined;
  return entry && existsSync(entry) ? entry : undefined;
}

/** 限定モードの依頼プラン（AgentPlan）を明示生成する。入力は添付（attachments）経由のみ。 */
export function buildConfinedPlan(prompt: string, allowedWritePaths: string[]): AgentPlan {
  return {
    version: '1.0', intent: 'delegate_external', language: 'ja', text: prompt,
    attachments: [], requiredCapabilities: ['file_write'], tools: ['write_file'],
    delegation: { enabled: false, parallel: false, requestedAgents: ['claude'], objective: prompt },
    source: 'explicit', allowedWritePaths,
  };
}

/** 許可書込みパスを「具体ファイルのみ」へ検証・正規化する。ディレクトリ・全体・ワイルドカード拒否。 */
export function assertConfinedAllowedWritePaths(workspace: string, paths: string[]): string[] {
  if (!Array.isArray(paths) || !paths.length) throw new Error('書き込み許可パスを1件以上指定してください。');
  if (paths.length > CONFINED_LIMITS.maxAllowedPaths) throw new Error(`書き込み許可パスは${CONFINED_LIMITS.maxAllowedPaths}件以内にしてください。`);
  // normalizeWritePaths がワイルドカード・絶対パス・範囲外・.git を先に拒否する（既存境界の再利用）。
  const normalized = normalizeWritePaths(workspace, paths);
  for (const value of normalized) {
    if (value === '.' || value.endsWith('/')) throw new Error(`書き込み許可は具体ファイルのみです（ディレクトリ・全体指定は不可）: ${value}`);
    assertNotSecretPath(value, '書き込み許可パス');
    // ディレクトリを「ファイル名なしのファイル」として通さないため、実在ディレクトリは明示拒否する。
    // リンク（Symbolic Link）経由の脱出も同期lstatで弾く（書込み時の検査は executeAgentTool 側にもある）。
    const resolved = path.resolve(workspace, value);
    if (existsSync(resolved)) {
      const info = lstatSync(resolved);
      if (info.isSymbolicLink()) throw new Error(`書き込み許可パスにリンクを経由できません: ${value}`);
      if (info.isDirectory()) throw new Error(`書き込み許可パスがディレクトリです。具体ファイルを指定してください: ${value}`);
    }
  }
  return normalized;
}

/** 限定Claude起動コマンド（固定）。executable/argsは呼び出し側から受け取らない。 */
export function buildConfinedClaudeCommand(options: { model: string; prompt: string }): { executable: string; args: string[] } {
  const model = String(options.model || '').trim();
  // 管理済みモデルIDのみ受理。空白・引用・制御文字を含まない既定形のIDだけを通す（注入面の排除）。
  if (!/^[\w][\w./:@+=,-]{0,199}$/.test(model)) throw new Error('管理済みモデルIDの形式が不正です。ホスト設定のモデルIDのみ使用できます。');
  const prompt = String(options.prompt || '');
  if (!prompt.trim()) throw new Error('依頼文が空です。');
  if (prompt.length > CONFINED_LIMITS.maxPromptChars) throw new Error(`依頼文（入力込み）は${CONFINED_LIMITS.maxPromptChars}文字以内にしてください。`);
  if (prompt.length > CONFINED_LIMITS.maxCommandLineChars) throw new Error('依頼文がWindowsコマンド行予算を超えています。入力を削減してください。');
  const executable = npmPackageEntry('@anthropic-ai/claude-code', 'bin/claude.exe') || 'claude';
  // 2.1.287 のローカルhelpで対応確認済みの旗のみ。execFileのargs配列で空文字 '' を --tools の値として正しく渡す。
  // --permission-prompts none はhelp未掲載（未対応）のため不使用 → --permission-mode dontAsk で代替。
  const args = [
    '-p', prompt,
    '--tools', '',                                   // 全Tool（Read/Write/Bash/子Agent/MCP/_hook/Skill）を無効化
    '--safe-mode',                                   // 設定・キー・キーチェーンの読み込みを抑制
    '--strict-mcp-config',                           // プロジェクト側のMCP設定を読み込ませない
    '--mcp-config', '{"mcpServers":{}}',             // MCPサーバーを明示的に空集合へ固定
    '--settings', '{"disableAllHooks":true}',        // Hook（フック / Hook）を無効化
    '--disable-slash-commands',                      // スラッシュコマンド（Slash Command）を無効化
    '--permission-mode', 'dontAsk',                  // 承認ダイアログを出さず、Toolがないため変更提案のみ返す
    '--no-session-persistence',                      // セッション永続化（Session Persistence）を無効化
    '--max-turns', '1',                              // 1ターンで終了（往復による再委任・拡張を禁止）
    '--output-format', 'text',                       // 生テキスト応答（JSONは本文契約で要求）
    '--model', model,                                // ホスト固定の管理済みモデルのみ
  ];
  return { executable, args };
}

/** 提案1件（ホストが受理した形）。path は作業場所からのスラ区切り相対へ正規化済み。 */
export interface ConfinedChangeProposal { path: string; content: string; }
export interface ConfinedProposalParse { changes: ConfinedChangeProposal[]; ignoredFields: string[]; }

/**
 * Claude応答から変更提案JSONを厳格抽出する。
 * 自己申告文（「成功しました」等）は成功とみなさない。JSON本文だけを信じ、
 * run_command 等の未知キーは「実行せず記録」して無視する。
 */
export function parseConfinedProposal(output: string, context: { root: string; allowedPaths: string[]; protectedFiles: string[] }): ConfinedProposalParse {
  const raw = String(output || '').trim();
  let payload: unknown;
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const braceStart = raw.indexOf('{'); const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) candidates.push(raw.slice(braceStart, braceEnd + 1));
  let parsed = false;
  for (const candidate of candidates) {
    try { payload = JSON.parse(candidate); parsed = true; break; } catch { /* 次候補 */ }
  }
  if (!parsed || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Claude応答に変更提案JSON({"changes":[...]}) を検出できません。偽成功・不正JSONとして拒否します。');
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.changes)) throw new Error('提案JSONの changes が配列ではありません。不正形式として拒否します。');
  // 「成功」の申告だけで changes が空の偽成功は失敗として扱う（空反映を成功にしない）。
  if (!record.changes.length) throw new Error('提案された変更が0件です。偽成功または対象なしとして拒否します。');
  if (record.changes.length > CONFINED_LIMITS.maxChanges) throw new Error(`変更提案は${CONFINED_LIMITS.maxChanges}件以内にしてください。`);
  const ignoredFields = new Set<string>();
  const changes: ConfinedChangeProposal[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const protectedResolved = context.protectedFiles.map(value => path.resolve(context.root, value).toLowerCase());
  for (const item of record.changes) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('変更提案の各要素は {"path","content"} のオブジェクトである必要があります。');
    const entry = item as Record<string, unknown>;
    // run_command 等の未知キー: 実行対象ではなく「無視するキー」として記録する（ホストは決して実行しない）。
    for (const key of Object.keys(entry)) if (key !== 'path' && key !== 'content') ignoredFields.add(key);
    if (typeof entry.path !== 'string' || typeof entry.content !== 'string') throw new Error('変更提案の path・content は文字列必須です。');
    const relative = path.relative(path.resolve(context.root), resolveWorkspacePath(context.root, entry.path)).replaceAll('\\', '/');
    if (!relative || relative.startsWith('..')) throw new Error(`提案パスが作業場所外です: ${entry.path}`);
    assertNotSecretPath(relative, '提案パス');
    if (relative.split('/').some(part => part.toLowerCase() === '.git')) throw new Error(`Git管理用パスは提案できません: ${relative}`);
    // 重複パス（Windowsの大文字小文字差を含む）は後の書き込みで上書き事故になるため拒否。
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    if (seen.has(key)) throw new Error(`同一パスへの重複提案です: ${relative}`);
    seen.add(key);
    // 許可リストは具体ファイルの完全一致のみ。部分一致・ディレクトリ配下の包括は許可しない。
    const match = context.allowedPaths.some(value => (process.platform === 'win32' ? value.toLowerCase() : value) === key);
    if (!match) throw new Error(`書き込み許可範囲外のため提案を拒否しました: ${relative}`);
    if (protectedResolved.includes(path.resolve(context.root, relative).toLowerCase())) throw new Error(`受入検証の保護ファイルへの変更提案は拒否しました: ${relative}`);
    const bytes = Buffer.byteLength(entry.content, 'utf8');
    if (bytes > CONFINED_LIMITS.maxChangeItemBytes) throw new Error(`提案1件は${CONFINED_LIMITS.maxChangeItemBytes}バイト以内です: ${relative}`);
    totalBytes += bytes;
    changes.push({ path: relative, content: entry.content });
  }
  if (totalBytes > CONFINED_LIMITS.maxChangeTotalBytes) throw new Error(`変更提案の合計が${CONFINED_LIMITS.maxChangeTotalBytes}バイトを超えています。`);
  return { changes, ignoredFields: [...ignoredFields] };
}

/** 入力添付として読み取り可能なパスかを名前で事前検証する（内容は隔離場所の実物を読む）。 */
function assertConfinedInputPath(requested: string): void {
  if (!requested.trim() || requested.includes('\0')) throw new Error('入力添付パスが不正です。');
  if (path.isAbsolute(requested)) throw new Error(`入力添付は相対パスで指定してください: ${requested}`);
  const relative = requested.replaceAll('\\', '/');
  if (relative.split('/').includes('..')) throw new Error(`入力添付に親階層への参照は使えません: ${relative}`);
  assertNotSecretPath(relative, '入力添付');
}

/** 隔離作業場所から許可入力（通常ファイル・サイズ上限内・UTF-8テキスト）を読み出す。 */
async function readConfinedInputs(root: string, names: string[]): Promise<Array<{ path: string; content: string }>> {
  if (names.length > CONFINED_LIMITS.maxInputFiles) throw new Error(`入力添付は${CONFINED_LIMITS.maxInputFiles}件以内です。`);
  const inputs: Array<{ path: string; content: string }> = [];
  let total = 0;
  for (const requested of names) {
    assertConfinedInputPath(requested);
    const target = resolveWorkspacePath(root, requested);
    const info = await lstat(target);
    if (!info.isFile() || info.nlink > 1) throw new Error(`入力は通常ファイルのみです（リンク不可）: ${requested}`);
    if (info.size > CONFINED_LIMITS.maxInputFileBytes) throw new Error(`入力1ファイルは${CONFINED_LIMITS.maxInputFileBytes}バイト以内です: ${requested}`);
    total += info.size;
    if (total > CONFINED_LIMITS.maxInputTotalBytes) throw new Error(`入力の合計が${CONFINED_LIMITS.maxInputTotalBytes}バイトを超えています。`);
    const content = (await readFile(target)).toString('utf8');
    if (content.includes('\u0000')) throw new Error(`入力UTF-8テキストファイルではありません: ${requested}`);
    inputs.push({ path: requested.replaceAll('\\', '/'), content });
  }
  return inputs;
}

/** 変更提案モードの依頼文を組み立てる。ホストが読んだ入力だけ添付し、秘密ファイルは要求側で拒否済み。 */
function buildConfinedPrompt(request: string, allowedPaths: string[], inputs: Array<{ path: string; content: string }>): string {
  const sections = inputs.map(input => `--- 入力ファイル: ${input.path} ---\n${input.content}`).join('\n\n');
  return [
    'あなたはWentian Gatewayの限定提案モードです。あなたはいかなるTool（Read/Write/Bash/子Agent/MCP/Hook/Skill/Web）も持っていません。使用試行も不可です。',
    '返答は次の形式のJSONオブジェクト1個だけにして、説明文・Markdown・前置きを一切付けないでください:',
    '{"changes":[{"path":"許可リストと完全一致する相対パス","content":"ファイル全文"}]}',
    `書き込み許可リスト（この完全一致のみ受理されます）: ${JSON.stringify(allowedPaths)}`,
    '既存ファイルを変更する場合は、変更後の全文をcontentに書いてください。部分編集・diff形式は不可。',
    '許可リスト外のパス、run_command等の実行要求キーを含めてはいけません（ホストは実行せず拒否します）。',
    '受入条件に合格する内容だけを提供してください。提供入力以外のファイルは読めません。推測で既存内容を欠落させないでください。',
    sections ? `提供入力ファイル:\n\n${sections}` : '提供入力ファイルはありません。',
    `依頼: ${request}`,
  ].join('\n');
}

/** ホストが適用した変更の記録。依頼文・応答生データは含まず、ハッシュとサイズだけを残す。 */
export interface ConfinedAppliedChange { path: string; bytes: number; beforeHash?: string; afterHash: string; }

export interface ConfinedExternalTaskOptions {
  /** ホスト設定の管理済みモデルID（必須・利用者可変不可）。 */
  model: string;
  /** ホスト固定の受入検査（ファイル存在・内容一致）。未設定ならプロジェクト受入設定も要求。 */
  acceptanceChecks?: AcceptanceCheck[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ConfinedExternalTaskResult {
  outcome: TaskOutcome;
  changes: ConfinedAppliedChange[];
  /** 提案JSONへ混入していた未使用キー（run_command 等）。ホストは実行していません。 */
  ignoredProposalFields: string[];
  /** 外部CLIの起動回数。受入未設定・事前拒否では0。 */
  cliLaunchCount: number;
  inputFiles: string[];
}

/** 依存注入点（試験用）。既定は実 runExternalCommand。試験はここだけをMockし、実LLMを呼ばない。 */
export interface ConfinedDependencies { runCommand?: typeof runExternalCommand; }

/** 既存ファイルのSHA-256（変更前ハッシュ）。未作成なら undefined。 */
async function hashExisting(root: string, relative: string): Promise<string | undefined> {
  try { return createHash('sha256').update(await readFile(resolveWorkspacePath(root, relative))).digest('hex'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/**
 * 限定外部タスクの実行主体。
 * `runConfinedExternalTask(plan, workspace, {model, signal, acceptanceChecks, timeoutMs}, dependencies?)`
 *
 * 手順: 事前検証 → runDirectTask（隔離）→ 隔離場所内: 入力読込 → 固定Claude起動（提案のみ）
 *       → ホストJSON検査 → executeAgentTool(write_file) で隔離場所へ適用
 *       → ホスト固定受入（acceptance + acceptanceChecks）→ 合格分だけ原本へ反映。
 * 依頼文・応答生データは返値にも台帳（manifest）にも載せません。
 */
export async function runConfinedExternalTask(
  plan: AgentPlan,
  workspace: string,
  options: ConfinedExternalTaskOptions,
  dependencies: ConfinedDependencies = {},
): Promise<ConfinedExternalTaskResult> {
  const runCommand = dependencies.runCommand || runExternalCommand;
  const model = String(options.model || '').trim();
  if (!model) throw new Error('限定外部タスクにはホスト設定の管理済みモデルが必須です（未設定では実行しません）。');
  const prompt = String(plan.text || '');
  if (!prompt.trim() || prompt.length > CONFINED_LIMITS.maxPromptChars) throw new Error(`依頼文は1文字以上${CONFINED_LIMITS.maxPromptChars}文字以内で指定してください。`);
  const allowedPaths = assertConfinedAllowedWritePaths(workspace, plan.allowedWritePaths || []);
  // 入力添付はここで「名前」を検証する（実体は隔離場所のコピーを読む。原本を作業中に触らせない）。
  const inputNames = (plan.attachments || []).map(attachment => {
    if (attachment.type !== 'local_file') throw new Error('限定モードの入力はローカルファイル添付のみです。');
    return attachment.path;
  });
  inputNames.forEach(assertConfinedInputPath);
  const checks = validateAcceptance(options.acceptanceChecks ?? []);
  // 「受入試験未設定なら反映せず needs_review」: CLI起動（Tokens消費）の前段で止める。
  const acceptancePlan = await loadAcceptancePlan(workspace);
  if (!checks.length && !acceptancePlan?.commands.length) {
    return {
      outcome: taskOutcome('needs_review', { executionMode: 'direct', reason: '受入条件（acceptanceChecks・プロジェクト受入設定）が未設定のため、Claudeを起動せず反映もしません。受入条件を指定して再実行してください。' }),
      changes: [], ignoredProposalFields: [], cliLaunchCount: 0, inputFiles: inputNames,
    };
  }

  let cliLaunchCount = 0;
  const ignoredFields = new Set<string>();
  let applied: ConfinedAppliedChange[] = [];

  // 隔離・受入・原本反映は runDirectTask の既存境界へ完全に乗せる（自前反映は作らない）。
  const direct = await runDirectTask(plan, workspace, async (stage, protectedFiles) => {
    const inputs = await readConfinedInputs(stage, inputNames);
    const command = buildConfinedClaudeCommand({ model, prompt: buildConfinedPrompt(prompt, allowedPaths, inputs) });
    if (!dependencies.runCommand) {
      // 実起動時は同じ実行ファイルの版を確認する。依存注入された試験は実CLIを起動しない。
      const version = await runExternalCommand({ executable: command.executable, args: ['--version'] }, { cwd: stage, timeoutMs: 10000, signal: options.signal, role: 'version-check', agent: 'claude' });
      assertVerifiedClaudeVersion(version);
    }
    cliLaunchCount += 1;
    // shell=false の execFile 起動（runExternalCommand の既存境界）。cwd は専用隔離作業場所。
    const output = await runCommand(command, {
      cwd: stage, timeoutMs: options.timeoutMs ?? CONFINED_LIMITS.defaultTimeoutMs,
      signal: options.signal, role: 'confined-proposer', agent: 'claude',
    });
    // 応答生データは解析の域を出さない。検査を通過した path/content のみがホスト適用される。
    const proposal = parseConfinedProposal(output, { root: stage, allowedPaths, protectedFiles });
    proposal.ignoredFields.forEach(field => ignoredFields.add(field));
    const records: ConfinedAppliedChange[] = [];
    for (const change of proposal.changes) {
      // 変更前ハッシュを反映前に記録（原本競合の追跡用。publish側の競合検査とは別目的）。
      const beforeHash = await hashExisting(stage, change.path);
      // ホストだけが executeAgentTool write_file で隔離場所へ適用する（権限・リンク・保護ファイル検査は既存実装）。
      await executeAgentTool({ id: 'confined-host-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: change.path, content: change.content }) } },
        stage, options.signal, { allowedWritePaths: plan.allowedWritePaths || [], protectedFiles });
      records.push({ path: change.path, bytes: Buffer.byteLength(change.content, 'utf8'), beforeHash, afterHash: await hashExisting(stage, change.path) as string });
    }
    applied = records;
    return `限定提案を隔離作業場所へ適用しました（${records.length}件）。`;
  }, options.signal, checks, { model, agent: 'claude' });

  return {
    outcome: direct.outcome,
    changes: applied,
    ignoredProposalFields: [...ignoredFields],
    cliLaunchCount,
    inputFiles: inputNames,
  };
}
