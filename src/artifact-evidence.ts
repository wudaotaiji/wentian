import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface ArtifactSnapshot {
  capturedAt: string;
  complete: boolean;
  files: Record<string, string>;
  issues: string[];
}

export interface ArtifactEvidence {
  verification: 'needs_review';
  scope: string;
  before: ArtifactSnapshot;
  after: ArtifactSnapshot;
  changes: Array<{ path: string; kind: 'added' | 'modified' | 'deleted'; beforeHash?: string; afterHash?: string }>;
}

/**
 * Git対象ファイルの実内容をSHA-256ハッシュ（Hash）で記録します。
 * 本文・秘密情報を台帳へ保存せず、既存の未コミット変更も開始時点として扱います。
 * 無視対象・実行台帳は対象外です。読めない場合や上限超過は不完全と明記します。
 */
export async function captureArtifactSnapshot(workspace: string): Promise<ArtifactSnapshot> {
  const snapshot: ArtifactSnapshot = { capturedAt: new Date().toISOString(), complete: true, files: Object.create(null), issues: [] };
  try {
    const root = await realpath(workspace);
    // 親環境のGIT_DIRやGIT_WORK_TREEで別のリポジトリを読まないようにします。
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
    let names: string[];
    try {
      const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd: root, env, windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
      names = [...new Set(stdout.split('\0').filter(Boolean))].filter(name => !name.startsWith('.wentian/'));
    } catch {
      // 新規制作先はGit Repositoryとは限らないため、巨大な依存物と管理領域を除外して通常ファイルを列挙します。
      const ignored = new Set(['.git', '.wentian', 'node_modules', 'dist', 'build', '__pycache__', '.venv', 'venv']);
      names = [];
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (ignored.has(entry.name.toLowerCase())) continue;
          const full = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) { snapshot.complete = false; snapshot.issues.push(`${path.relative(root, full)}: Symbolic Linkは対象外です。`); continue; }
          if (entry.isDirectory()) await walk(full);
          else if (entry.isFile()) names.push(path.relative(root, full).replace(/\\/g, '/'));
          if (names.length > 10_000) throw new Error('対象が10,000ファイルを超えています。');
        }
      };
      await walk(root);
    }
    if (names.length > 10_000) throw new Error('対象が10,000ファイルを超えています。');
    let bytes = 0;
    for (const name of names) {
      const file = path.resolve(root, name);
      try {
        const resolved = await realpath(file);
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('作業場所外への参照です。');
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('通常ファイルではありません。');
        bytes += stat.size;
        if (stat.size > 64 * 1024 * 1024 || bytes > 100 * 1024 * 1024) throw new Error('読取り容量の上限を超えています。');
        snapshot.files[name] = createHash('sha256').update(await readFile(file)).digest('hex');
      } catch (error) {
        // Gitに登録済みでも、削除されたファイルは現在の一覧から除外します。
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        snapshot.complete = false;
        snapshot.issues.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    snapshot.complete = false;
    snapshot.issues.push(error instanceof Error ? error.message : String(error));
  }
  return snapshot;
}

/** 変更の存在と機能の正しさを分離します。ハッシュ一致だけでは受入条件を満たしません。 */
export function compareArtifactSnapshots(before: ArtifactSnapshot, after: ArtifactSnapshot): ArtifactEvidence {
  const changes: ArtifactEvidence['changes'] = [];
  for (const name of [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()) {
    const beforeHash = before.files[name];
    const afterHash = after.files[name];
    if (beforeHash === afterHash) continue;
    changes.push({ path: name, kind: !beforeHash ? 'added' : !afterHash ? 'deleted' : 'modified', beforeHash, afterHash });
  }
  return { verification: 'needs_review', scope: 'Git対象と未追跡ファイル（無視対象と.wentianを除く）。変更者の特定・機能検証は含みません。', before, after, changes };
}
