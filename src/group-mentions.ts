export interface MentionMember { name: string; kind?: string; userId?: string; active?: boolean; presence?: string }
export interface GroupMention { start: number; end: number; label: string; targets: string[]; mode: 'member' | 'all' | 'here' }

/** @は明示的な通信プロトコルです。本文の意味や利用者の意図は分類しません。 */
export function parseGroupMentions(content: string, members: MentionMember[]): GroupMention[] {
  const eligible = members.filter(m => m.kind !== 'human' || m.active);
  const key = (m: MentionMember) => m.kind === 'human' ? 'human:' + m.userId : 'ai:' + m.name;
  const named = [...eligible].sort((a, b) => b.name.length - a.name.length);
  const boundary = (c: string | undefined) => !c || /[\s.,!?;:，。！？；：、()\[\]{}<>「」『』]/u.test(c);
  const result: GroupMention[] = [];
  let fenced = false, inline = false;
  for (let i = 0; i < content.length; i++) {
    if (result.length >= 100) break;
    if (content.startsWith('```', i)) { fenced = !fenced; inline = false; i += 2; continue; }
    if (!fenced && content[i] === '`') { inline = !inline; continue; }
    if (fenced || inline) continue;
    if (content[i] !== '@' || !boundary(content[i - 1])) continue;
    const tail = content.slice(i + 1);
    const broadcast = ['everyone', 'all', 'here'].find(name => tail.slice(0, name.length).toLowerCase() === name && boundary(tail[name.length]));
    if (broadcast) {
      const targets = eligible.filter(m => broadcast !== 'here' || (m.kind === 'human' ? m.presence === 'online' : m.presence !== 'offline')).map(key);
      const end = i + 1 + broadcast.length;
      result.push({ start: i, end, label: content.slice(i, end), targets, mode: broadcast === 'here' ? 'here' : 'all' });
      i = end - 1; continue;
    }
    const quoted = tail.startsWith('"');
    const member = named.find(m => quoted ? tail.startsWith('"' + m.name + '"') && boundary(tail[m.name.length + 2]) : tail.startsWith(m.name) && boundary(tail[m.name.length]));
    if (!member) continue;
    const end = i + 1 + member.name.length + (quoted ? 2 : 0);
    result.push({ start: i, end, label: content.slice(i, end), targets: eligible.filter(m => m.name === member.name).map(key), mode: 'member' });
    i = end - 1;
  }
  return result;
}
