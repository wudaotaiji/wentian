import path from 'node:path';
import { loadExternalAgentSnapshot } from './external-agents.js';
import { connectionStorePath, managedAgentIds, readAgentConnections, type AgentConnection } from './agent-connection-policy.js';
import { readWorkEvidence, workCachePath, workEvidenceState, type AgentWorkEvidence, type WorkCapability } from './agent-work-policy.js';

/** 接続記録だけの状態名称です。実作業能力の合否（workState）とは必ず分けて表示します。 */
export type ConnectionState = 'unverified' | 'verified' | 'expired' | 'failed';
export interface AgentStatusRow {
  id: string;
  name: string;
  /** Wentianが接続保守を担う対象かどうか（それ以外は手動登録・未管理）。 */
  managed: boolean;
  cli?: string;
  version?: string;
  /** CLI生存確認の結果（Health Check Cache由来）。 */
  liveState?: 'healthy' | 'not_installed' | 'probe_failed' | 'unknown';
  /** CLI生存確認の観察時刻（Health Check Cache由来）。 */
  cliObservedAt?: string;
  freshWithin24Hours: boolean;
  connectionState: ConnectionState;
  mode?: AgentConnection['mode'];
  model?: string;
  connectionCheckedAt?: string;
  connectionExpiresAt?: string;
  connectionStage?: string;
  connectionReason?: string;
  /** 試したモデルと結果。失敗理由の切り分けに使えるよう元データ保持にします。 */
  connectionAttempts?: AgentConnection['attempts'];
  workState: ReturnType<typeof workEvidenceState>;
  capabilities: Partial<Record<WorkCapability, boolean>>;
  workExpiresAt?: string;
  /** 次回再試行予定。上流利用制限でも即再投入しないための約束です。 */
  workRetryAt?: string;
  workFailures?: number;
  workAttentionRequired?: boolean;
  workFailureKind?: string;
  workReason?: string;
  /** 実ファイル・検証プログラム・ログを保存した資料ディレクトリ。 */
  evidenceDirectory?: string;
}
export interface AgentStatusReport {
  revision: 1;
  generatedAt: string;
  /** 判断に必要な前提を隠さないため、キャッシュの鮮度と保存場所を必ず出します。 */
  cache: { healthSource: string; healthUpdatedAt?: string; healthFreshWithin24Hours: boolean; connectionStore: string; workStore: string };
  summary: { total: number; managed: number; connectionVerified: number; workVerified: number; retryPending: number; attentionRequired: number; unverified: number };
  agents: AgentStatusRow[];
}

const connectionLabels: Record<ConnectionState, string> = { unverified: '未確認', verified: '確認済み', expired: '期限切れ', failed: '失敗' };
/** CLI生存確認の観察結果。観測記録なしを未導入と断定しません。 */
const cliLabels: Record<NonNullable<AgentStatusRow['liveState']> | 'unknown', string> = { healthy: '生存確認済み', not_installed: 'CLI未検出', probe_failed: 'CLI起動失敗', unknown: '生存確認の記録なし' };
const workLabels: Record<AgentStatusRow['workState'], string> = { unverified: '未検証', passed: '合格', retry_pending: '再試行待ち', attention_required: '対応待ち', expired: '期限切れ' };
const capabilityLabels: Record<WorkCapability, string> = { reading: '読', coding: '実', testing: '試', verification: '検' };

/** 接続記録から表示用の状態を導きます。合格記録でも期限を過ぎていれば verified にしません。 */
function connectionState(connection: AgentConnection | undefined, now: number): ConnectionState {
  if (!connection) return 'unverified';
  if (connection.status !== 'verified') return 'failed';
  return Date.parse(connection.expiresAt) > now ? 'verified' : 'expired';
}

/** 作業者が実作業を任せてよいかを、保存済みの証拠だけで報告します。ここでは一切のCLI起動・設定変更を行いません。 */
export async function buildAgentStatusReport(options: { directory?: string; now?: number } = {}): Promise<AgentStatusReport> {
  const now = options.now ?? Date.now();
  // probeLive既定はtrueなので、状態確認自体がCLIを起動しないよう明示的に止めます。
  const snapshot = await loadExternalAgentSnapshot({ directory: options.directory, probeLive: false });
  const connections = readAgentConnections();
  const evidence = readWorkEvidence();
  const agents = snapshot.agents.map((agent): AgentStatusRow => {
    const connection = agent.connection || connections[agent.id];
    const record: AgentWorkEvidence | undefined = agent.workEvidence || evidence[agent.id];
    return {
      id: agent.id, name: agent.name, managed: managedAgentIds.includes(agent.id), cli: agent.cli, version: agent.version, liveState: agent.liveState,
      cliObservedAt: agent.lastObservedAt, freshWithin24Hours: agent.freshWithin24Hours,
      connectionState: connectionState(connection, now), mode: connection?.mode, model: connection?.model,
      connectionCheckedAt: connection?.checkedAt, connectionExpiresAt: connection?.expiresAt, connectionStage: connection?.stage,
      connectionReason: connection?.reason, connectionAttempts: connection?.attempts,
      // 能力記録は本人申告ではなく同一設定の検証履歴のみを信用するため、identity照合は workAllowsExecution 側で行われます。
      workState: workEvidenceState(record, now), capabilities: record?.capabilities || {},
      workExpiresAt: record?.expiresAt, workRetryAt: record?.retryAt, workFailures: record?.failures,
      workAttentionRequired: record?.attentionRequired, workFailureKind: record?.failureKind,
      workReason: record?.reason, evidenceDirectory: record?.evidenceDirectory,
    };
  });
  const summary = {
    total: agents.length,
    managed: agents.filter(agent => agent.managed).length,
    connectionVerified: agents.filter(agent => agent.connectionState === 'verified').length,
    workVerified: agents.filter(agent => agent.workState === 'passed').length,
    retryPending: agents.filter(agent => agent.workState === 'retry_pending').length,
    attentionRequired: agents.filter(agent => agent.workState === 'attention_required').length,
    unverified: agents.filter(agent => agent.workState === 'unverified' || agent.workState === 'expired').length,
  };
  return { revision: 1, generatedAt: new Date(now).toISOString(),
    cache: { healthSource: snapshot.source, healthUpdatedAt: snapshot.cacheUpdatedAt, healthFreshWithin24Hours: snapshot.cacheFreshWithin24Hours, connectionStore: connectionStorePath(), workStore: workCachePath() },
    summary, agents };
}

/** 能力バッジを「読・実・試・検」の短縮表記にまとめます。未合格の能力は推測で付けません。 */
function capabilityBadge(capabilities: Partial<Record<WorkCapability, boolean>>): string {
  const earned = (Object.keys(capabilityLabels) as WorkCapability[]).filter(name => capabilities[name] === true);
  return earned.length ? earned.map(name => capabilityLabels[name]).join('・') : 'なし';
}

/** 日本語の1画面レポート。実行可否の判断根拠（理由・次回再試行・資料場所）を必ず残します。 */
export function formatAgentStatusReport(report: AgentStatusReport): string {
  const lines: string[] = [];
  lines.push('Wentian 外部エージェント状態レポート');
  lines.push(`生成: ${report.generatedAt}`);
  lines.push(`生存確認キャッシュ: ${report.cache.healthSource} / 更新 ${report.cache.healthUpdatedAt || '記録なし'} / 24時間以内 ${report.cache.healthFreshWithin24Hours ? 'はい' : 'いいえ'}`);
  lines.push(`接続記録: ${report.cache.connectionStore}`);
  lines.push(`能力記録: ${report.cache.workStore}`);
  lines.push('');
  lines.push(`合計 ${report.summary.total}（管理対象 ${report.summary.managed}） / 接続確認済み ${report.summary.connectionVerified} / 実作業検証済み ${report.summary.workVerified} / 再試行待ち ${report.summary.retryPending} / 対応待ち ${report.summary.attentionRequired} / 未検証 ${report.summary.unverified}`);
  lines.push('');
  for (const agent of report.agents) {
    lines.push(`■ ${agent.name} [${agent.id}]${agent.managed ? '' : '（接続保守の対象外）'}`);
    lines.push(`  CLI: ${cliLabels[agent.liveState || 'unknown']}（${agent.cli || agent.id}）${agent.version ? ` / 版 ${agent.version}` : ''} / 最終確認 ${agent.cliObservedAt || '記録なし'}`);
    lines.push(`  接続: ${connectionLabels[agent.connectionState]}${agent.mode ? `（${agent.mode === 'free' ? '無料モデル' : agent.mode === 'native' ? 'Agent提供モデル' : 'Wentian/ローカルLLM'} / ${agent.model || '未設定'}）` : ''}${agent.connectionExpiresAt ? ` / 有効期限 ${agent.connectionExpiresAt}` : ''}`);
    if (agent.connectionReason) lines.push(`    理由: ${agent.connectionReason}`);
    if (agent.connectionAttempts?.length) lines.push(`    モデル試行: ${agent.connectionAttempts.map(attempt => `${attempt.model}=${attempt.status}`).join(', ')}`);
    lines.push(`  実作業能力: ${workLabels[agent.workState]} / 認定 ${capabilityBadge(agent.capabilities)}${agent.workExpiresAt && agent.workState === 'passed' ? ` / 有効期限 ${agent.workExpiresAt}` : ''}`);
    if (agent.workReason) lines.push(`    理由: ${agent.workReason}`);
    if (agent.workFailures) lines.push(`    連続失敗: ${agent.workFailures}回${agent.workFailureKind ? ` / 種別 ${agent.workFailureKind}` : ''}`);
    if (agent.workRetryAt && agent.workState !== 'passed') lines.push(`    次回再試行予定: ${agent.workRetryAt}`);
    if (agent.evidenceDirectory) lines.push(`    検証資料: ${path.normalize(agent.evidenceDirectory)}`);
    lines.push('');
  }
  lines.push('注記: 接続確認済みは実作業の保証ではありません。実作業を任せてよいのは「実作業能力: 合格」のAgentだけです。');
  return lines.join('\n');
}
