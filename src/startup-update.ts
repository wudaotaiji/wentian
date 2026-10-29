import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { applyVersionUpdate, createVersionUpdatePlan, issueVersionUpdateApproval } from './version-update.js';
import { cliText } from './cli-language.js';

/** 起動確認と手動更新で同じ処理を使い、テストでは外部操作を差し替えます。 */
export interface StartupUpdateOptions {
  check?: typeof createVersionUpdatePlan;
  apply?: typeof applyVersionUpdate;
  confirm?: () => Promise<boolean>;
  emit?: (text: string) => void;
}

async function confirmUpdate(): Promise<boolean> {
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await reader.question(cliText('Enter で今すぐ更新 / n + Enter で後で: '));
    return answer.trim() === '' || /^(y|yes)$/i.test(answer.trim());
  } finally { reader.close(); }
}

/** 更新成功・失敗後は旧コードの起動を止め、確認不能・延期時は起動を続けます。 */
export async function checkStartupUpdate(options: StartupUpdateOptions = {}): Promise<boolean> {
  const emit = options.emit || console.log;
  let plan;
  emit(cliText('Wentian の更新を確認しています…'));
  try { plan = await (options.check || createVersionUpdatePlan)(); }
  catch (error) {
    emit(cliText('更新を確認できませんでした。起動を続けます: {0}', error instanceof Error ? error.message : String(error)));
    return false;
  }
  if (plan.relation === 'unknown') {
    emit(cliText('更新を確認できませんでした。起動を続けます: {0}', plan.reason || cliText('リモート情報なし')));
    return false;
  }
  if (!plan.updateAvailable) {
    emit(plan.relation === 'current' ? cliText('Wentian {0} は最新です。', plan.currentVersion) : cliText('ローカル版がリモートより先行しています。'));
    return false;
  }
  emit(cliText('Wentian の更新があります: {0} ({1}) → {2}', plan.currentVersion, plan.currentCommit.slice(0, 8), plan.remoteCommit?.slice(0, 8)));
  if (!plan.canApply) { emit(plan.reason || cliText('現在は更新できません。')); return false; }
  emit(cliText('更新すると依存関係の復元・検証を行います。完了後に Wentian を再起動してください。'));
  if (!await (options.confirm || confirmUpdate)()) { emit(cliText('更新を延期しました。後から wentian update で更新できます。')); return false; }
  // 承認は入力後に発行し、考慮時間による有効期限切れを防ぎます。
  const approval = issueVersionUpdateApproval(plan);
  try {
    const result = await (options.apply || applyVersionUpdate)(approval, approval.token, emit, plan.installRoot);
    emit(cliText('更新完了: {0} ({1})\n記録: {2}\nWentian を再起動してください。', result.version, result.commit.slice(0, 8), result.manifestPath));
  } catch (error) {
    emit(cliText('更新に失敗しました: {0}', error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
  return true;
}
