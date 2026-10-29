import { lstat, mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { renameWithRetry } from './atomic-file.js';

/** パスの全祖先を確認し、リンク（Link）と共有実体への書込みを拒否する。 */
export async function assertOrdinaryPath(target: string): Promise<void> {
  let cursor = path.resolve(target);
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error('リンク・ハードリンク（Hard Link）経由の操作は許可しません。');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}

/** 同じディレクトリ内の一時ファイルを原子的に置換する。変更直前にパスを再確認する。 */
export async function atomicOrdinaryWrite(target: string, content: string | Buffer): Promise<void> {
  await assertOrdinaryPath(target);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.wentian-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await assertOrdinaryPath(target);
    await renameWithRetry(temporary, target);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
