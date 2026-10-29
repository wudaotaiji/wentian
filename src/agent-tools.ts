import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { truncateToolOutput } from './agent-compactor.js';
import { listSkills, loadSkill } from './skills.js';
import { assertWriteAllowed, normalizeWritePaths } from './execution-policy.js';
import { assertTaskPathIncluded } from './task-workspace.js';
import { assertOrdinaryPath, atomicOrdinaryWrite } from './safe-file.js';
import { inspectMediaCapabilities } from './media-agent-capabilities.js';
import { listSessionHistory } from './session-history-tool.js';
import { searchPublicWeb } from './agent-web-search.js';

const execFileAsync = promisify(execFile);

export type AgentToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

/** OpenAI互換APIへ渡す、Wentian CLIのローカルTool（ツール / Tool）定義です。 */
export const agentToolDefinitions = [
  { type: 'function', function: { name: 'web_search', description: '公開Web資料を検索し、見出し・抜粋・出典URL・取得時刻を取得します。秘密情報を検索語へ含めないでください。', parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 400 } }, required: ['query'], additionalProperties: false } } },
  { type:'function', function:{name:'inspect_media_capabilities',description:'Wentianの音声・動画制作能力、現在のモデル準備状態、CPU/GPU、読み上げ音声を診断します。生成・取得・変更は行いません。',parameters:{type:'object',properties:{},additionalProperties:false}} },
  { type: 'function', function: { name: 'list_skills', description: '利用可能なSkillの名前と説明を取得します。', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'load_skill', description: '必要なSkillの指示を名前で読み込みます。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } } },
  { type: 'function', function: { name: 'read_file', description: '現在のワークスペース内にあるUTF-8テキストファイルを読み取ります。', parameters: { type: 'object', properties: { path: { type: 'string', description: 'ワークスペースからの相対パス' } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'list_files', description: 'ワークスペース内のファイルを深さと件数を制限して探します。queryはファイル名・相対パスの部分一致です。', parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' }, depth: { type: 'integer', minimum: 0, maximum: 5 } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'list_agent_sessions', description: 'Wentian自身が保存した会話Sessionの依頼と応答を読み取ります。日付は利用者の地域の日付で指定できます。ほかのアプリの履歴や実作業の完了は確認できません。', parameters: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'inspect_workspace_activity', description: '現在のワークスペースのGitコミット履歴、変更ファイル一覧、差分統計を読み取り専用で取得します。変更内容そのものやGit外の作業は示さないため、必要ならlist_filesとread_fileで作業記録を調べてください。', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'inspect_kubernetes', description: 'kubectlでKubernetesの構成・CPU・メモリ使用量を読み取り専用で取得します。接続先は先にプロジェクト資料で確認してください。topは現在の使用量であり利用率にはrequests/limits等との比較が必要です。', parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['get', 'top', 'describe'] }, resource: { type: 'string', enum: ['pods', 'nodes', 'deployments', 'statefulsets', 'daemonsets', 'services', 'namespaces', 'events'] }, kubeconfig: { type: 'string' }, context: { type: 'string' }, namespace: { type: 'string' }, all_namespaces: { type: 'boolean' } }, required: ['operation', 'resource'], additionalProperties: false } } },
  { type: 'function', function: { name: 'write_file', description: '現在のワークスペース内へUTF-8テキストファイルを書き込みます。既存ファイルは置換されます。', parameters: { type: 'object', properties: { path: { type: 'string', description: 'ワークスペースからの相対パス' }, content: { type: 'string', description: '書き込む全文' } }, required: ['path', 'content'], additionalProperties: false } } },
  { type: 'function', function: { name: 'run_command', description: '現在のワークスペースで、非破壊的なPowerShellコマンドを実行します。', parameters: { type: 'object', properties: { command: { type: 'string', description: '実行するPowerShellコマンド' } }, required: ['command'], additionalProperties: false } } },
] as const;

/** シェル（Shell）を介さず固定の読み取り操作だけを組み立て、任意オプションの注入を拒否します。 */
export function kubernetesInspectionArgs(input: Record<string, unknown>): string[] {
  const operation = String(input.operation || ''); const resource = String(input.resource || '');
  if (!['get', 'top', 'describe'].includes(operation) || !['pods', 'nodes', 'deployments', 'statefulsets', 'daemonsets', 'services', 'namespaces', 'events'].includes(resource)) throw new Error('未対応の読み取り操作です。');
  if (operation === 'top' && !['pods', 'nodes'].includes(resource)) throw new Error('使用量を取得できる対象はpodsまたはnodesです。');
  const args: string[] = [];
  for (const [key, flag] of [['kubeconfig', '--kubeconfig'], ['context', '--context'], ['namespace', '--namespace']]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].startsWith('-') || /[\r\n\0]/.test(input[key])) throw new Error(`接続引数が不正です: ${key}`);
    args.push(flag, input[key]);
  }
  if (input.all_namespaces === true) args.push('--all-namespaces');
  args.push('--request-timeout=20s', operation, resource);
  // topとの比較対象を実行中Podにそろえ、完了済みジョブの大量出力で現役Podが欠落するのを防ぎます。
  if (operation === 'get' && resource === 'pods') args.push('--field-selector=status.phase=Running');
  // kubectl側で必要列だけを抽出し、大きなPod定義や環境変数を標準出力へ出しません。
  if (operation === 'get') args.push('-o', 'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.namespace}{"\\t"}{.metadata.ownerReferences[*].name}{"\\t"}{.status.phase}{"\\t"}{.spec.containers[*].resources}{.spec.template.spec.containers[*].resources}{"\\t"}{.status.capacity}{"\\t"}{.status.allocatable}{"\\n"}{end}');
  return args;
}

/** 相対パスを解決し、`..`や絶対パスによるワークスペース外アクセスを拒否します。 */
export function resolveWorkspacePath(workspace: string, requestedPath: string): string {
  if (!requestedPath.trim()) throw new Error('空のパスは指定できません。');
  const root = path.resolve(workspace);
  // モデルが絶対パスを返す場合も、解決後のパスがワークスペース内なら安全に受理します。
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ワークスペース外のパスは操作できません。');
  return resolved;
}

/** LLMの誤操作を防ぐため、削除・破壊・システム変更につながるコマンドを拒否します。 */
export function assertSafeCommand(command: string): void {
  if (!command.trim()) throw new Error('空のコマンドは実行できません。');
  const destructive = /(?:\bRemove-Item\b|\bdel(?:ete)?\b|\berase\b|\brm\b|\brmdir\b|\bformat\b|\bClear-Disk\b|\bInitialize-Disk\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bNew-Item\b|\bMove-Item\b|\bCopy-Item\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b|\bcurl(?:\.exe)?\b|\bwget\b|\bgit\s+(?:reset|clean|checkout|commit|push|pull|merge|rebase)\b|\b(?:drop|truncate|delete|update|insert|alter)\s+(?:table|database|from|into)?\b|\bkubectl\s+(?:delete|apply|patch|scale|edit|replace|create|set)\b|\brollout\s+restart\b)/i;
  if (destructive.test(command)) throw new Error('破壊的または状態変更リスクの高いコマンドは自動実行できません。');
  // 全階層の全項目を列挙すると、Tool結果だけでモデルのContext上限を超えるため、件数か深さの指定を必須にします。
  const unboundedRecursiveListing = /\bGet-ChildItem\b(?=[\s\S]*-Recurse\b)(?![\s\S]*(?:-Depth\b|\bSelect-Object\b[\s\S]*-First\b))/i;
  if (unboundedRecursiveListing.test(command)) {
    throw new Error('無制限の再帰一覧はContext超過を招くため実行できません。-Depthを指定するか、Select-Object -Firstで件数を制限してください。');
  }
}

/** 1件のローカルTool Callを安全境界内で実行し、LLMへ返す文字列を生成します。 */
export async function executeAgentTool(call: AgentToolCall, workspace = process.cwd(), signal?: AbortSignal, policy?: { allowedWritePaths: string[]; proposalOnly?: boolean; protectedFiles?: string[] }): Promise<string> {
  signal?.throwIfAborted();
  let input: Record<string, unknown>;
  try { input = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; }
  catch { throw new Error(`Tool引数がJSONではありません: ${call.function.name}`); }

  if (call.function.name === 'web_search') return JSON.stringify(await searchPublicWeb(input.query as string, signal));
  if (call.function.name === 'inspect_media_capabilities') { if(Object.keys(input).length)throw new Error('制作能力の診断に引数は不要です。');return JSON.stringify(await inspectMediaCapabilities()); }

  if (call.function.name === 'list_skills') return JSON.stringify(await listSkills(workspace));
  if (call.function.name === 'list_agent_sessions') return await listSessionHistory(input);
  if (call.function.name === 'inspect_workspace_activity') {
    if (Object.keys(input).length) throw new Error('ワークスペース作業記録の確認に引数は不要です。');
    const runGit = async (args: string[]) => {
      try {
        const result = await execFileAsync('git', ['-C', path.resolve(workspace), ...args], { cwd: workspace, timeout: 15000, maxBuffer: 512 * 1024, windowsHide: true, signal });
        return { success: true, output: truncateToolOutput(result.stdout.trim()) };
      } catch (error) {
        signal?.throwIfAborted();
        const failure = error as Error & { stderr?: string; code?: string | number };
        return { success: false, error: truncateToolOutput(failure.stderr || failure.message), code: failure.code };
      }
    };
    const [root, commits, status, diff] = await Promise.all([
      runGit(['rev-parse', '--show-toplevel']),
      runGit(['log', '-n', '40', '--date=iso-strict', '--format=%h%x09%ad%x09%s']),
      runGit(['status', '--short', '--untracked-files=normal']),
      runGit(['diff', '--stat', '--no-ext-diff']),
    ]);
    return JSON.stringify({ retrieved_at: new Date().toISOString(), workspace: path.resolve(workspace), root, commits, status, diff, guidance: 'Gitの記録はワークスペースの変更証拠です。未コミット変更の内容やGit外の作業内容は、必要に応じてlist_filesで作業記録を探しread_fileで確認してください。Git状態だけから作業完了を断定しないでください。' });
  }
  if (call.function.name === 'load_skill') return await loadSkill(String(input.name || ''), workspace);
  if (call.function.name === 'list_files') {
    const target = resolveWorkspacePath(workspace, String(input.path || '.'));
    const depth = typeof input.depth === 'number' ? input.depth : 2;
    if (!Number.isInteger(depth) || depth < 0 || depth > 5) throw new Error('探索の深さは0から5で指定してください。');
    const query = String(input.query || '').toLowerCase(); const files: string[] = []; let visited = 0;
    // リンクを辿らず、探索件数と返却件数の両方を制限して巨大な結果を防ぎます。
    async function visit(directory: string, remaining: number): Promise<void> {
      await assertOrdinaryPath(directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted();
        if (++visited > 10000 || files.length >= 200) return;
        if (entry.isSymbolicLink() || ['.git', 'node_modules', '.venv', '.wentian'].includes(entry.name)) continue;
        const full = path.join(directory, entry.name); const relative = path.relative(workspace, full);
        if (entry.isFile() && relative.toLowerCase().includes(query)) files.push(relative);
        if (entry.isDirectory() && remaining > 0) await visit(full, remaining - 1);
      }
    }
    await visit(target, depth);
    return JSON.stringify({ files, truncated: visited > 10000 || files.length >= 200 });
  }
  if (call.function.name === 'inspect_kubernetes') {
    const args = kubernetesInspectionArgs(input);
    try {
      // 指定された設定が存在しない場合は、kubectlの起動や既定接続への迂回を行いません。
      if(typeof input.kubeconfig==='string'){
        const file=await lstat(path.resolve(workspace,input.kubeconfig));
        if(!file.isFile())throw new Error('指定したkubeconfigは通常のファイルではありません。');
      }
      const result = await execFileAsync('kubectl', args, { cwd: workspace, timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal });
      const output = input.operation === 'get' ? '列: name, namespace, owner, phase, container resources, capacity, allocatable\n' + result.stdout : result.stdout;
      const limitedOutput = truncateToolOutput(output);
      return JSON.stringify({ success: true, executable: 'kubectl', args, retrieved_at: new Date().toISOString(), truncated: limitedOutput !== output, output: limitedOutput, stderr: truncateToolOutput(result.stderr) });
    } catch (error) {
      signal?.throwIfAborted();
      const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
      // 設定の内容や認証情報は読みません。既定の設定ディレクトリにある候補の名前だけを返し、選択はLLMへ委ねます。
      const configDirectory = path.join(os.homedir(), '.kube');
      const availableKubeconfigs = await readdir(configDirectory, { withFileTypes: true }).then(entries => entries.filter(entry => entry.isFile() && entry.name.startsWith('config')).slice(0, 20).map(entry => path.join(configDirectory, entry.name))).catch(() => []);
      // 接続失敗もモデルへ証拠として返し、未確認の項目と再取得条件を説明させます。
      return JSON.stringify({ success: false, executable: 'kubectl', args, code: failure.code, error: truncateToolOutput(failure.stderr || failure.message), output: truncateToolOutput(failure.stdout || ''), available_kubeconfigs: availableKubeconfigs, guidance: 'プロジェクト資料のcontext・namespaceと設定候補を照合し、適切なkubeconfigとnamespaceを明示して再試行してください。全namespaceのForbiddenは特定namespaceの権限不足を意味しません。接続設定エラーだけでネットワーク障害と断定しないでください。' });
    }
  }
  if (call.function.name === 'read_file') {
    const target = resolveWorkspacePath(workspace, String(input.path || ''));
    await assertOrdinaryPath(target);
    const content = await readFile(target, 'utf8');
    return truncateToolOutput(content);
  }
  if (call.function.name === 'write_file') {
    const target = resolveWorkspacePath(workspace, String(input.path || ''));
    if (path.relative(path.resolve(workspace), target).split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('Git管理領域への書込みは許可しません。');
    if (policy) assertWriteAllowed(workspace, target, policy.proposalOnly ? [] : policy.allowedWritePaths);
    if (policy) await assertTaskPathIncluded(workspace, String(input.path || ''));
    if (policy?.protectedFiles?.some(value => path.resolve(workspace, value).toLowerCase() === target.toLowerCase())) throw new Error('受入検証の保護ファイルは変更できません。');
    // シンボリックリンク経由で許可ファイル以外へ書き込ませません。
    for (let item = target; item !== path.resolve(workspace); item = path.dirname(item)) {
      try { if ((await lstat(item)).isSymbolicLink()) throw new Error('リンク経由の書き込みは許可しません。'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const content = String(input.content ?? '');
    await mkdir(path.dirname(target), { recursive: true });
    await atomicOrdinaryWrite(target, content);
    return `書き込みました: ${path.relative(path.resolve(workspace), target)} (${Buffer.byteLength(content, 'utf8')} bytes)`;
  }
  if (call.function.name === 'run_command') {
    // 任意のシェルからファイル制限を回避できるため、限定許可では実行しません。
    if (policy && (policy.proposalOnly || policy.protectedFiles?.length || !normalizeWritePaths(workspace, policy.allowedWritePaths).includes('.'))) throw new Error('限定書き込み・提案モードでは任意コマンドを実行できません。検証は受入設定を使用してください。');
    const command = String(input.command || '');
    assertSafeCommand(command);
    // Windowsの既定コードページに依存せず、日本語のコマンド結果をUTF-8で受け取ります。
    const utf8Command = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ' + command;
    const result = await execFileAsync('pwsh', ['-NoProfile', '-Command', utf8Command], { cwd: workspace, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal });
    const output = `${result.stdout || ''}${result.stderr ? `\n標準エラー:\n${result.stderr}` : ''}`.trim() || 'コマンドは正常終了しました（出力なし）。';
    return truncateToolOutput(output);
  }
  throw new Error(`未対応のToolです: ${call.function.name}`);
}

/**
 * LLMのTool対応状況に依存しない、対話CLIの直接Toolコマンドを実行します。
 * `:write`は「相対パス 半角スペース 本文」の形式で受け取り、本文中のスペースは保持します。
 */
export async function executeDirectAgentCommand(raw: string, workspace = process.cwd(), policy?: { allowedWritePaths: string[]; proposalOnly?: boolean }): Promise<{ handled: boolean; output?: string }> {
  const matched = raw.match(/^:(read|write|run)(?:\s+([\s\S]*))?$/i);
  if (!matched) return { handled: false };
  const operation = matched[1].toLowerCase();
  const argument = (matched[2] || '').trim();
  if (operation === 'read') return { handled: true, output: await executeAgentTool({ id: 'direct-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: argument }) } }, workspace, undefined, policy) };
  if (operation === 'run') return { handled: true, output: await executeAgentTool({ id: 'direct-run', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: argument }) } }, workspace, undefined, policy) };
  const separator = argument.search(/\s/);
  if (separator < 1) throw new Error(':writeは「:write 相対パス 本文」の形式で指定してください。');
  const requestedPath = argument.slice(0, separator);
  const content = argument.slice(separator).trimStart().replace(/\\n/g, '\n');
  return { handled: true, output: await executeAgentTool({ id: 'direct-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: requestedPath, content }) } }, workspace, undefined, policy) };
}

/** 質問に明記された代表的なプロジェクトファイルを先に読み、非Tool対応モデルにも実データを渡します。 */
export async function collectReferencedFileContext(prompt: string, workspace = process.cwd(),onRead?:(path:string)=>void): Promise<string> {
  const mentioned = [...prompt.matchAll(/(?:^|[\s「『"'])([\w./\\-]+\.(?:md|json|ya?ml|toml|ts|tsx|js|py|ps1|txt))(?:$|[\s」』"'、。,])/gi)].map(match => match[1]);
  const unique = [...new Set(mentioned)].slice(0, 5);
  const sections: string[] = [];
  for (const requestedPath of unique) {
    try {
      const content = await executeAgentTool({ id: 'prefetch', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: requestedPath }) } }, workspace);
      onRead?.(requestedPath);
      sections.push(`--- ${requestedPath} ---\n${content}`);
    } catch (error) { sections.push(`--- ${requestedPath} ---\n読取エラー: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return sections.join('\n\n');
}
