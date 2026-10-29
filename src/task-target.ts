import path from 'node:path';

export interface ResolvedTaskTarget {
  workspace: string;
  explicit: boolean;
  source: 'quoted_path' | 'unquoted_path' | 'default';
}
/**
 * 利用者が依頼文で明示したWindows絶対Pathを抽出します。
 * 自然言語中の未引用PathはPlannerが構造化して指定します。
 */
export function resolveTaskTarget(input: string, defaultWorkspace: string, selectedPath?: string): ResolvedTaskTarget {
  const quoted = input.match(/["']([A-Za-z]:\\[^"'\r\n]+)["']/)?.[1];
  const candidate = (selectedPath || quoted)?.trim();
  if (!candidate) return { workspace: path.resolve(defaultWorkspace), explicit: false, source: 'default' };
  if (!input.includes(candidate)) throw new Error('作業先Pathは今回の依頼文に明示されていません。');
  if (!path.win32.isAbsolute(candidate) || /[\0\r\n]/.test(candidate)) throw new Error(`作業先Pathが不正です: ${candidate}`);
  return { workspace: path.win32.normalize(candidate), explicit: true, source: quoted === candidate ? 'quoted_path' : 'unquoted_path' };
}
