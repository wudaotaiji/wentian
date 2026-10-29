import { listAgentSessions } from './agent-session.js';
import { redactTrainingText } from './training-data.js';

/** Wentian自身の保存済み会話を、モデルが根拠として読むための限定された一覧です。 */
export async function listSessionHistory(input: Record<string, unknown>): Promise<string> {
  const date = input.date;
  const limit = input.limit ?? 8;
  if (date !== undefined && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) throw new Error('日付はYYYY-MM-DD形式で指定してください。');
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20) throw new Error('取得件数は1～20の整数で指定してください。');
  const zone = process.env.WENTIAN_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDay = (value: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
  const all = await listAgentSessions();
  const selected = all.filter(session => date === undefined || localDay(session.createdAt) === date || localDay(session.updatedAt) === date).slice(0, Number(limit));
  return JSON.stringify({ source: 'Wentian保存済みSession', timezone: zone, filterDate: date ?? null, totalMatched: all.filter(session => date === undefined || localDay(session.createdAt) === date || localDay(session.updatedAt) === date).length,
    coverage: 'Wentianの会話のみ。Codex・他アプリ・未保存の作業は含みません。発話ごとの時刻や実作業の完了状態は記録されていません。',
    sessions: selected.map(session => ({ id: session.id, workspace: session.workspace, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: session.messages.length,
      messages: session.messages.slice(-12).map(message => ({ role: message.role, content: redactTrainingText(message.content).replace(/\s+/g, ' ').slice(0, 240) })) })) });
}
