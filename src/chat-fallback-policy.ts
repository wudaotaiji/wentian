import { isFreeAgentModel, type AgentConnection } from './agent-connection-policy.js';

export function chatNoModelsMessage(model: string): string {
  if (model === 'wentian-auto/local' || model === 'wentian-auto/free') return '利用可能なローカルLLMがありません。外部Agentへは切り替えていません。ローカルLLMを接続するか、全経路の自動選択を選んでください。';
  if (model === 'wentian-auto/free-agents') return '接続状態・能力・予算条件を満たす無料Agentを利用できません。Codexなど料金区分が異なる候補へは切り替えていません。';
  if (model === 'wentian-auto/remote') return '利用可能なリモートLLMがありません。外部Agentへは切り替えていません。';
  return '利用可能なLLMモデルがありません。';
}

/** 自動選択の範囲を外部Agentへの切替でも維持します。料金は自己紹介から推測しません。 */
export function chatFallbackAgents(model: string, ready: string[], excluded: string[], connections: Record<string, AgentConnection>, now = Date.now()): string[] {
  if (!['wentian-auto/all', 'wentian-auto/free-agents'].includes(model)) return [];
  return ready.filter(agent => {
    if (excluded.includes(agent)) return false;
    if (model === 'wentian-auto/all') return true;
    const entry = connections[agent];
    return entry?.mode !== 'local' && entry?.status === 'verified' && Date.parse(entry.expiresAt) > now && isFreeAgentModel(agent, entry.model);
  });
}
