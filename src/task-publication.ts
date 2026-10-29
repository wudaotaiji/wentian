/** 成果物反映の排他・台帳・巻戻し（Publication Transaction）。外部サービスは操作しない。 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, mkdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { TaskWorkspace, PublishResult } from './task-workspace.js';
import { assertOrdinaryPath, atomicOrdinaryWrite } from './safe-file.js';

export interface PublicationOptions { beforeApply?: (index: number) => Promise<void> }
interface Entry { path: string; beforeHash?: string; afterHash: string; before?: string; after: string }
interface Journal { id: string; pid: number; state: 'prepared' | 'applying' | 'completed' | 'rolled_back' | 'recovery_required'; entries: Entry[] }
const hash = (content: Buffer) => createHash('sha256').update(content).digest('hex');
async function currentHash(target: string) { try { await assertOrdinaryPath(target); return hash(await readFile(target)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
function resolveArtifact(root: string, name: string) {
  const target = path.resolve(root, name), relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => ['.git', '.wentian'].includes(part.toLowerCase()))) throw new Error('反映パスが範囲外または管理領域です。');
  return target;
}
async function rollback(source: string, journal: Journal) {
  let pending = false;
  for (const entry of [...journal.entries].reverse()) {
    try {
      const target = resolveArtifact(source, entry.path), current = await currentHash(target);
      if (current === entry.beforeHash) continue;
      // 人間がさらに変更した内容は、巻戻しで上書きしない。
      if (current !== entry.afterHash) { pending = true; continue; }
      if (entry.before === undefined) await unlink(target);
      else await atomicOrdinaryWrite(target, Buffer.from(entry.before, 'base64'));
    } catch { pending = true; }
  }
  journal.state = pending ? 'recovery_required' : 'rolled_back';
  return pending;
}
export async function transactionalPublish(workspace: TaskWorkspace, changes: Array<{ path: string; kind: string; beforeHash?: string; afterHash?: string }>, options: PublicationOptions = {}): Promise<PublishResult> {
  const source = path.resolve(workspace.source), stage = path.resolve(workspace.directory);
  const result = (note: string, extra: Partial<PublishResult> = {}): PublishResult => ({ status: 'conflict', destination: source, files: [], note, ...extra });
  if (!changes.length) return result('反映対象の変更がありません。', { status: 'no_changes' });
  const lockPath = path.join(source, '.wentian', 'publication.lock');
  const journalPath = path.join(source, '.wentian', 'publications', randomUUID(), 'journal.json');
  let lock; let journal: Journal | undefined; let keepLock = false;
  try {
    await assertOrdinaryPath(source); await assertOrdinaryPath(stage); await assertOrdinaryPath(lockPath);
    await mkdir(path.dirname(lockPath), { recursive: true });
    lock = await open(lockPath, 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, journalPath }));
    const seen = new Set<string>(); const entries: Entry[] = [];
    // 全件を読み込み・検査してから1件目を反映する。
    for (const change of changes) {
      if (!['added', 'modified'].includes(change.kind)) throw new Error('削除または不正な種類は自動反映しません。');
      const target = resolveArtifact(source, change.path), input = resolveArtifact(stage, change.path);
      const key = target.toLowerCase(); if (seen.has(key)) throw new Error('同じ反映パスが重複しています。'); seen.add(key);
      await assertOrdinaryPath(target); await assertOrdinaryPath(input);
      if (!(await lstat(input)).isFile()) throw new Error('反映する成果物が通常ファイルではありません。');
      const current = await currentHash(target); const expected = change.kind === 'added' ? undefined : change.beforeHash;
      if (current !== expected) throw new Error(`制作中に反映先が変更されました: ${change.path}`);
      const content = await readFile(input), afterHash = hash(content);
      if (change.afterHash && change.afterHash !== afterHash) throw new Error('検収後に成果物が変更されました。');
      entries.push({ path: change.path, beforeHash: current, afterHash, before: current === undefined ? undefined : (await readFile(target)).toString('base64'), after: content.toString('base64') });
      if (entries.at(-1)!.before && hash(Buffer.from(entries.at(-1)!.before!, 'base64')) !== current) throw new Error('退避中に原本が変更されました。');
    }
    journal = { id: path.basename(path.dirname(journalPath)), pid: process.pid, state: 'prepared', entries };
    await atomicOrdinaryWrite(journalPath, JSON.stringify(journal));
    journal.state = 'applying'; await atomicOrdinaryWrite(journalPath, JSON.stringify(journal));
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!; await options.beforeApply?.(index);
      const target = resolveArtifact(source, entry.path);
      if (await currentHash(target) !== entry.beforeHash) throw new Error('反映直前に原本が変更されました。');
      await atomicOrdinaryWrite(target, Buffer.from(entry.after, 'base64'));
    }
    journal.state = 'completed'; await atomicOrdinaryWrite(journalPath, JSON.stringify(journal));
    return result(`${entries.length}件を反映しました。`, { status: 'published', files: entries.map(entry => entry.path), journalPath, recoveryRequired: false });
  } catch (error) {
    if (journal) { keepLock = await rollback(source, journal); await atomicOrdinaryWrite(journalPath, JSON.stringify(journal)); }
    return result(error instanceof Error ? error.message : '反映に失敗しました。', { journalPath: journal ? journalPath : undefined, recoveryRequired: keepLock });
  } finally { if (lock) { await lock.close(); if (!keepLock) await unlink(lockPath); } }
}

/** 強制終了後の反映を巻き戻す。所有プロセスが生存している間は絶対に復旧しない。 */
export async function recoverPublication(source: string): Promise<{ recovered: boolean; journalPath: string }> {
  const lockPath = path.join(path.resolve(source), '.wentian', 'publication.lock');
  await assertOrdinaryPath(lockPath);
  const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number; journalPath: string };
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('反映ロックの所有者が不正です。');
  try { process.kill(owner.pid, 0); throw new Error('反映プロセスが生存しています。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  const base = path.join(path.resolve(source), '.wentian', 'publications');
  const relative = path.relative(base, path.resolve(owner.journalPath));
  if (relative.startsWith('..') || path.isAbsolute(relative) || !/^[a-f0-9-]{36}[\\/]journal\.json$/.test(relative)) throw new Error('復旧台帳が管理範囲外です。');
  await assertOrdinaryPath(owner.journalPath);
  const journal = JSON.parse(await readFile(owner.journalPath, 'utf8')) as Journal;
  if (!Array.isArray(journal.entries) || !['prepared', 'applying', 'completed', 'rolled_back', 'recovery_required'].includes(journal.state)) throw new Error('復旧台帳が不正です。');
  for (const entry of journal.entries) {
    resolveArtifact(source, entry.path);
    if (hash(Buffer.from(entry.after, 'base64')) !== entry.afterHash || (entry.before !== undefined && hash(Buffer.from(entry.before, 'base64')) !== entry.beforeHash)) throw new Error('復旧台帳の成果物ハッシュが不一致です。');
  }
  const pending = ['completed', 'rolled_back'].includes(journal.state) ? false : await rollback(source, journal);
  await atomicOrdinaryWrite(owner.journalPath, JSON.stringify(journal));
  if (!pending) await unlink(lockPath);
  return { recovered: !pending, journalPath: owner.journalPath };
}
