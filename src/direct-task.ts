import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureArtifactSnapshot, compareArtifactSnapshots } from './artifact-evidence.js';
import { assertTaskPathIncluded, createTaskWorkspace, publishTaskWorkspace } from './task-workspace.js';
import { loadAcceptancePlan, verifyAcceptance } from './acceptance-verification.js';
import { terminateProcessTree } from './external-orchestrator.js';
import { assertWriteAllowed, normalizeWritePaths } from './execution-policy.js';
import { errorOutcome, taskOutcome, type TaskOutcome } from './task-outcome.js';
import type { AgentPlan } from './agent-planner.js';
import { validateAcceptance, verifyDelivery, type AcceptanceCheck, type DeliveryVerification } from './delivery-verification.js';
import { atomicOrdinaryWrite } from './safe-file.js';
import { cliText } from './cli-language.js';

/** 直接実装も隔離作業場所で実行し、ホスト受入検証を通るまで原本へ反映しません。 */
export async function runDirectTask(plan: AgentPlan, source: string, execute: (workspace: string, protectedFiles: string[]) => Promise<string>, signal?: AbortSignal, checks: AcceptanceCheck[] = [], execution?: { model?: string; agent?: string }): Promise<{ outcome: TaskOutcome; answer?: string }> {
  const taskId = `direct-${Date.now()}-${randomUUID()}`;
  const manifestPath = path.join(source, '.wentian', 'orchestration', 'runs', taskId, 'manifest.json');
  const allowed = normalizeWritePaths(source, plan.allowedWritePaths || []);
  let workspace: Awaited<ReturnType<typeof createTaskWorkspace>> | undefined;
  let answer: string | undefined;
  let evidence: ReturnType<typeof compareArtifactSnapshots> | undefined;
  let acceptance: Awaited<ReturnType<typeof verifyAcceptance>> | undefined;
  let publication: Awaited<ReturnType<typeof publishTaskWorkspace>> | undefined;
  let delivery: DeliveryVerification | undefined;
  const frozenChecks = validateAcceptance(structuredClone(checks));
  let outcome = taskOutcome('needs_review', { executionMode: 'direct', taskId, manifestPath });
  let running = true, stage = 'staging';
  const save = async () => {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await atomicOrdinaryWrite(manifestPath, JSON.stringify({ version: '1.0', updatedAt: new Date().toISOString(), task: { taskId, executionMode: 'direct', model: execution?.model, agent: execution?.agent, allowedWritePaths: allowed, acceptanceChecks: frozenChecks }, result: { state: running ? 'running' : outcome.status, stage, outcome, workspace, evidence, acceptance, delivery, publication } }, null, 2));
  };
  try {
    if (!allowed.length) throw new Error('書き込み許可範囲を指定してください。');
    for (const name of allowed.filter(value => value !== '.')) await assertTaskPathIncluded(source, name);
    const acceptancePlan = await loadAcceptancePlan(source);
    await save(); workspace = await createTaskWorkspace(source); stage = 'executing'; await save();
    answer = await execute(workspace.directory, acceptancePlan?.protectedFiles || []);
    signal?.throwIfAborted();
    evidence = compareArtifactSnapshots(workspace.baseline, await captureArtifactSnapshot(workspace.directory));
    if (!evidence.before.complete || !evidence.after.complete || !evidence.changes.length) throw new Error('直接実装の実ファイル差分を確認できません。');
    for (const change of evidence.changes) assertWriteAllowed(workspace.directory, path.join(workspace.directory, change.path), allowed);
    stage = 'verification'; await save();
    acceptance = await verifyAcceptance(workspace.directory, acceptancePlan, workspace.baseline, { signal, terminate: terminateProcessTree });
    signal?.throwIfAborted();
    if (frozenChecks.length) delivery = await verifyDelivery(workspace.directory, frozenChecks);
    // 受入設定がない場合も、明示Targetへの成果物は失わず反映し、検証未実施として要検収にします。
    const notConfigured = acceptance.status === 'not_configured';
    const deliveryPassed = delivery?.status === 'passed';
    const canPublish = acceptance.status === 'passed' || (notConfigured && (deliveryPassed || !frozenChecks.length));
    if (canPublish && delivery?.status !== 'failed') {
      signal?.throwIfAborted();
      stage = 'publication'; await save();
      publication = await publishTaskWorkspace(workspace, evidence.changes);
      const unverified = notConfigured && !deliveryPassed;
      outcome = taskOutcome(publication.status === 'published' ? (unverified ? 'needs_review' : 'success') : 'needs_review', {
        ...outcome,
        reason: publication.status === 'published' && unverified ? cliText('受入設定がないため自動検証は未実施です。変更は反映済みです。反映ファイル: {0}。', publication.files.join(', ')) : publication.note,
      });
    } else {
      const timeout = acceptance.commands.some(command => /時間超過/.test(command.reason || ''));
      outcome = taskOutcome(timeout ? 'timeout' : acceptance.status === 'not_configured' && delivery?.status !== 'failed' ? 'needs_review' : 'failed', { ...outcome, reason: delivery?.status === 'failed' ? delivery.summary : acceptance.note });
    }
  } catch (error) {
    outcome = { ...errorOutcome(error), executionMode: 'direct', taskId, manifestPath };
    if (workspace && !evidence) evidence = compareArtifactSnapshots(workspace.baseline, await captureArtifactSnapshot(workspace.directory));
  }
  running = false; stage = 'finished'; await save();
  return { outcome, answer };
}
