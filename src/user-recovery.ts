import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlCenterAuthStore } from './control-center-auth.js';
import { processAlive, readDaemonRecord } from './cli-runtime.js';

/** 復旧はローカル端末から停止中だけ実行し、パスワードは標準入力で受け取ります。 */
export async function recoverUser(options: { store: string; userId: string; username?: string; password: string }, running: () => Promise<boolean> = async () => { const record = await readDaemonRecord(); return Boolean(record && processAlive(record.pid)); }) {
  if (await running()) throw new Error('先にWentian Daemonを停止してください。');
  const store = new ControlCenterAuthStore(path.resolve(options.store)); await store.initialize({ bootstrap: false });
  const user = store.findPublicUser(options.userId);
  if (!user) throw new Error('対象ユーザーIDが見つかりません。');
  // 既存の管理者本人を復旧し、一般利用者を管理者へ昇格させません。
  if (user.role !== 'admin') throw new Error('復旧の対象は登録済み管理者だけです。');
  return store.updateUser(user.id, { ...(options.username ? { username: options.username } : {}), password: options.password, enabled: true }, 'local-recovery');
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('利用者台帳のパスを指定してください。');
  if (process.argv.includes('--list')) {
    // 初期管理者の自動作成を避け、台帳を読むだけにします。
    const data = JSON.parse(await readFile(path.resolve(file), 'utf8'));
    console.log(JSON.stringify(data.users.filter((u: { role: string }) => u.role === 'admin').map((u: { id: string; username: string; enabled: boolean }) => ({ id: u.id, username: u.username, enabled: u.enabled })), null, 2)); return;
  }
  let content = ''; for await (const chunk of process.stdin) { content += chunk; if (content.length > 16384) throw new Error('復旧入力が大きすぎます。'); }
  const input = JSON.parse(content);
  const user = await recoverUser({ store: file, userId: input.userId, username: input.username, password: input.password });
  console.log('管理者を復旧しました。ユーザーIDは保持されています: ' + user.id);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error instanceof Error ? error.message : '復旧に失敗しました。'); process.exitCode = 1; });
