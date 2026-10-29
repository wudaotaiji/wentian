import { readFileSync } from 'node:fs';
import path from 'node:path';
import { managedConnection } from './agent-connection-policy.js';
import { workIdentity } from './agent-work-policy.js';

export const codexImageEvidencePath = () => process.env.WENTIAN_CODEX_IMAGE_EVIDENCE || path.join(process.env.WENTIAN_INSTALL_ROOT || process.cwd(), '.wentian', 'codex-image-evidence.json');
/** 画像生成の実ファイル検収記録を、一般のCLI疎通とは独立に扱います。 */
export function codexImageVerified(): boolean {
  try { const e = JSON.parse(readFileSync(codexImageEvidencePath(), 'utf8')), c = managedConnection('codex'); return !!c && e.identity === workIdentity(c) && e.passed === true && Date.parse(e.expiresAt) > Date.now(); } catch { return false; }
}
