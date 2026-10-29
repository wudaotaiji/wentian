import os from 'node:os';
import path from 'node:path';
import { workCachePath } from './agent-work-policy.js';

/** プロジェクト全体や一時フォルダー全体へ許可せず、保守の対象場所を固定します。 */
export function maintenanceWorkspaces() {
  return {
    connection: path.resolve(process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT || path.join(os.tmpdir(), 'wentian-connection-checks')),
    work: path.resolve(path.dirname(workCachePath()), 'work-verification'),
  };
}
