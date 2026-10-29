import { createHash } from 'node:crypto';

export interface ConsensusProposal {
  conclusion: string;
  actionPlan: string[];
  verification: string[];
  unresolved: string[];
}
export interface ConsensusVote { candidateId: string; agree: boolean; reason: string; objections: string[] }
export interface ConsensusCheck {
  round: number; candidateId: string; proposal: ConsensusProposal;
  coordinator?: string;
  votes: Array<ConsensusVote & { member: string; agent?: string }>;
  agreed: boolean;
}

/** 合意判定の入力は会話本文と分け、モデルの「全員合意」という主張を採用しません。 */
function objectReply(raw: string): Record<string, unknown> {
  const clean = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  const marked = clean.match(/WENTIAN_CONSENSUS_BEGIN\s*([\s\S]*?)\s*WENTIAN_CONSENSUS_END/);
  const value = JSON.parse(marked?.[1] || clean.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('合意判定の回答はJSONオブジェクトにしてください。');
  return value;
}
function nonempty(value: unknown, max = 6000): value is string { return typeof value === 'string' && Boolean(value.trim()) && value.length <= max; }
function rows(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 30 && value.every(row => nonempty(row, 2000)); }

/** 結論だけで終了せず、実施手順・確認方法・未解決点を必ず構造化して保存します。 */
export function parseConsensusProposal(raw: string): ConsensusProposal {
  const value = objectReply(raw);
  if (!nonempty(value.conclusion) || !rows(value.actionPlan) || !rows(value.verification) || !rows(value.unresolved)) throw new Error('結論・実施手順・確認方法・未解決点の形式が不正です。');
  return { conclusion: value.conclusion.trim(), actionPlan: value.actionPlan.map(row => row.trim()), verification: value.verification.map(row => row.trim()), unresolved: value.unresolved.map(row => row.trim()) };
}

/** 同じ案へ賛否を問うため、整形済みの案全体をハッシュ（hash）へ固定します。 */
export function consensusCandidateId(proposal: ConsensusProposal): string {
  return createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
}

export function parseConsensusVote(raw: string): ConsensusVote {
  const value = objectReply(raw);
  if (typeof value.candidateId !== 'string' || !/^[a-f0-9]{64}$/.test(value.candidateId) || typeof value.agree !== 'boolean' || !nonempty(value.reason, 2000) || !rows(value.objections)) throw new Error('合意確認の回答形式が不正です。');
  return { candidateId: value.candidateId, agree: value.agree, reason: value.reason.trim(), objections: value.objections.map(row => row.trim()) };
}

/** 全参加者が同一案へ明示同意し、反対・未解決点がない場合だけ合意とします。 */
export function hasConsensus(check: ConsensusCheck, participants: string[]): boolean {
  return check.proposal.actionPlan.length > 0 && check.proposal.verification.length > 0 && check.proposal.unresolved.length === 0
    && check.votes.length === participants.length && new Set(check.votes.map(vote => vote.member)).size === participants.length
    && participants.every(member => check.votes.some(vote => vote.member === member && vote.candidateId === check.candidateId && vote.agree && vote.objections.length === 0));
}
