import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface AcceptanceCheck { path: string; contains?: string; }
export interface DeliveryEvidence { path: string; passed: boolean; detail: string; sha256?: string; bytes?: number; }
export interface DeliveryVerification {
  status: 'passed' | 'failed' | 'pending'; checkedAt: string; evidence: DeliveryEvidence[]; summary: string;
}

/** 利用者指定のファイル条件を実行前に固定します。任意コマンドの実行は伴いません。 */
export function validateAcceptance(value: unknown): AcceptanceCheck[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('验収条件は20件以内の配列で指定してください。');
  return value.map(item => {
    if (!item || typeof item.path !== 'string' || !item.path.trim() || item.path.length > 500 || path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..')) throw new Error('成果物はワークスペース内の相対パスで指定してください。');
    if (item.contains !== undefined && (typeof item.contains !== 'string' || item.contains.length > 10_000)) throw new Error('確認する文字列は10,000文字以内で指定してください。');
    return { path: item.path, ...(item.contains ? { contains: item.contains } : {}) };
  });
}

/** Agentの自己申告を使わず、ホスト側で成果物の存在・内容・ハッシュを検査します。 */
export async function verifyDelivery(workspace: string, checks: AcceptanceCheck[]): Promise<DeliveryVerification> {
  const checkedAt = new Date().toISOString();
  if (!checks.length) return { status: 'pending', checkedAt, evidence: [], summary: '验収条件が未設定です。成果を確認して条件を追加してください。' };
  const accepted = validateAcceptance(checks), base = await realpath(workspace);
  const evidence: DeliveryEvidence[] = [];
  for (const check of accepted) {
    try {
      const target = await realpath(path.resolve(base, check.path)), relative = path.relative(base, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ワークスペース外の参照は検証できません。');
      const info = await stat(target);
      if (!info.isFile() || info.size === 0 || info.size > 2 * 1024 * 1024) throw new Error('成果物は空でない2MiB以内のファイルが必要です。');
      const content = await readFile(target);
      const passed = !check.contains || content.toString('utf8').includes(check.contains);
      evidence.push({ path: check.path, passed, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), detail: passed ? '指定条件に合格' : '指定文字列がありません。' });
    } catch (error) { evidence.push({ path: check.path, passed: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  const passed = evidence.every(item => item.passed);
  return { status: passed ? 'passed' : 'failed', checkedAt, evidence, summary: passed ? '全ての指定条件に合格しました。' : '指定条件に未達の成果物があります。' };
}
