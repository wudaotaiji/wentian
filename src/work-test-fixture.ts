import type { ExternalAgentStatus } from './external-agents.js';
import { workIdentity } from './agent-work-policy.js';

/** 単体試験だけで使う明示的な合格フィクスチャー。実際の保守記録は生成しません。 */
export function withVerifiedWork<T extends ExternalAgentStatus>(agent: T): T {
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const model = agent.id === 'kilo' ? 'kilo/kilo-auto/free' : agent.id === 'opencode' ? 'opencode/example-free' : 'local-model';
  const connection = agent.connection || { mode: ['kilo', 'opencode'].includes(agent.id) ? 'free' as const : 'local' as const, model, fingerprint: '試験専用', policyHash: '試験専用', status: 'verified' as const, checkedAt: new Date().toISOString(), expiresAt };
  return { ...agent, connection, workEvidence: { revision: 1, identity: workIdentity(connection, agent.version), checkedAt: new Date().toISOString(), expiresAt, retryAt: expiresAt, status: 'passed', capabilities: { reading: true, coding: true, testing: true, verification: true }, evidenceDirectory: '単体試験の模擬資料', reason: '明示的な試験用合格記録' } };
}
