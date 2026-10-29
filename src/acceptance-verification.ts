import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactSnapshot } from './artifact-evidence.js';

export interface AcceptancePlan {
  version: 1;
  commands: Array<{ id: string; criterion: string; executable: string; args: string[]; timeoutMs: number }>;
  protectedFiles: string[];
}

export interface AcceptanceResult {
  status: 'passed' | 'failed' | 'not_configured' | 'blocked';
  plan?: AcceptancePlan;
  startedAt: string;
  finishedAt: string;
  commands: Array<{ id: string; executable: string; args: string[]; cwd: string; exitCode: number | null; stdout: string; stderr: string; reason?: string }>;
  note: string;
}

/**
 * 操作者が原本の.wentian/acceptance.jsonへ設定した受入条件を制作開始前に読みます。
 * 外部Agentが制作場所へ生成した設定は読まず、未設定なら検証未実施として扱います。
 * 実行ファイルは絶対パス、作業場所は専用リポジトリ固定、シェル展開は使用しません。
 */
export async function loadAcceptancePlan(source: string): Promise<AcceptancePlan | undefined> {
  let raw: string;
  try { raw = await readFile(path.join(source, '.wentian', 'acceptance.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('受入設定は64KiB以下にしてください。');
  const value = JSON.parse(raw);
  if (value.version !== 1 || !Array.isArray(value.commands) || !value.commands.length || value.commands.length > 8
    || !Array.isArray(value.protectedFiles) || !value.protectedFiles.length || value.protectedFiles.length > 100) throw new Error('受入設定の形式が不正です。');
  const ids = new Set<string>();
  const commands = value.commands.map((command: any) => {
    if (!command || typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(command.id) || ids.has(command.id)
      || typeof command.criterion !== 'string' || !command.criterion.trim() || command.criterion.length > 2000
      || typeof command.executable !== 'string' || !path.isAbsolute(command.executable) || /[\r\n\0]/.test(command.executable)
      || !Array.isArray(command.args) || command.args.length > 64 || !command.args.every((arg: unknown) => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0'))
      || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 300_000) throw new Error('受入コマンドの形式が不正です。');
    ids.add(command.id);
    return { id: command.id, criterion: command.criterion, executable: command.executable, args: [...command.args], timeoutMs: command.timeoutMs };
  });
  const protectedFiles = value.protectedFiles.map((name: unknown) => {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.isAbsolute(name)
      || name.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('検証用保護ファイルのパスが不正です。');
    return name;
  });
  return { version: 1, commands, protectedFiles };
}

/** 検証用ファイルの削除・すり替えによる見かけの合格を防ぎます。依存関係全体の保証ではありません。 */
export async function assertProtectedFiles(workspace: string, plan: AcceptancePlan, baseline: ArtifactSnapshot): Promise<void> {
  for (const name of plan.protectedFiles) {
    if (!baseline.files[name]) throw new Error(`検証用ファイルが開始時点にありません: ${name}`);
    const resolved = await realpath(path.resolve(workspace, name));
    const relative = path.relative(await realpath(workspace), resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`検証用ファイルが作業場所外です: ${name}`);
    const hash = createHash('sha256').update(await readFile(resolved)).digest('hex');
    if (hash !== baseline.files[name]) throw new Error(`検証用ファイルが変更されました: ${name}`);
  }
}

/** Wentianが子プロセスを直接実行し、失敗・中断・時間超過を実測結果として記録します。 */
async function runCheck(command: AcceptancePlan['commands'][number], cwd: string, options: {
  signal?: AbortSignal;
  terminate: (pid: number) => Promise<{ verifiedStopped: boolean }>;
}): Promise<AcceptanceResult['commands'][number]> {
  return new Promise(resolve => {
    const result: AcceptanceResult['commands'][number] = { id: command.id, executable: command.executable, args: command.args, cwd, exitCode: null, stdout: '', stderr: '' };
    if (options.signal?.aborted) { resolve({ ...result, reason: '中断済み' }); return; }
    const child = spawn(command.executable, command.args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stopping: Promise<void> | undefined;
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      await stopping;
      // 停止確認に失敗しても無期限に待たず、その事実を記録して後続検証を止めます。
      if (result.reason) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      resolve(result);
    };
    const stop = (reason: string) => {
      if (stopping) return;
      result.reason = reason;
      stopping = Promise.resolve().then(async () => {
        try {
          if (child.pid && !(await options.terminate(child.pid)).verifiedStopped) result.reason += '・プロセス停止未確認';
        } catch { result.reason += '・プロセス停止失敗'; }
      });
      void stopping.then(finish);
    };
    let bytes = 0;
    for (const stream of ['stdout', 'stderr'] as const) child[stream].setEncoding('utf8').on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      // 記録量を抑え、上限を超えた検証を合格扱いにしません。
      if (bytes > 1024 * 1024) { stop('出力上限超過'); return; }
      result[stream] += chunk;
    });
    const timer = setTimeout(() => stop('時間超過'), command.timeoutMs);
    const abort = () => stop('中断');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('error', error => { result.reason = error.message; });
    child.once('close', code => {
      result.exitCode = code;
      void finish();
    });
  });
}

/** 計画どおりの検証結果を返します。passedも設定された条件の合格であり、製品全体の完了ではありません。 */
export async function verifyAcceptance(workspace: string, plan: AcceptancePlan | undefined, baseline: ArtifactSnapshot, options: {
  signal?: AbortSignal;
  terminate: (pid: number) => Promise<{ verifiedStopped: boolean }>;
  emit?: (text: string) => void;
}): Promise<AcceptanceResult> {
  const result: AcceptanceResult = { status: 'not_configured', plan, startedAt: new Date().toISOString(), finishedAt: '', commands: [], note: '受入設定がないため未検証です。' };
  try {
    if (plan) {
      result.status = 'blocked';
      if (!baseline.complete) throw new Error('開始時点のファイル記録が不完全です。');
      await assertProtectedFiles(workspace, plan, baseline);
      result.status = 'passed';
      result.note = '設定された検証条件が合格しました。成果物全体は引き続き要検収です。';
      for (const command of plan.commands) {
        if (options.signal?.aborted) throw new Error('検証が中断されました。');
        options.emit?.(`• 受入検証: ${command.id}\n  └ ${command.criterion}`);
        const check = await runCheck(command, workspace, options);
        result.commands.push(check);
        if (check.exitCode !== 0 || check.reason) { result.status = 'failed'; result.note = `検証失敗: ${command.id} (${check.reason || `exit=${check.exitCode}`})`; break; }
        await assertProtectedFiles(workspace, plan, baseline);
      }
    }
  } catch (error) { result.status = 'blocked'; result.note = error instanceof Error ? error.message : String(error); }
  result.finishedAt = new Date().toISOString();
  return result;
}
