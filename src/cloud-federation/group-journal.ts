import { randomUUID } from 'node:crypto';
import { AgentGroupStore } from '../agent-group.js';
import type { Envelope } from './contracts.js';
import { groupIdFor } from './identity.js';

/** 同じ通信グループIDを各所有者のWorkbenchへ独立保存します。記録失敗を無視しません。 */
export class GroupJournal {
  readonly store: AgentGroupStore;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(workspace: string, readonly localId: string) { this.store = new AgentGroupStore(workspace); }
  private async append(id: string, nodeIds: string[], event: Parameters<AgentGroupStore['appendFederationEvent']>[2]) {
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.store.appendFederationEvent(id, nodeIds, event));
    this.queues.set(id, next);
    try { await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
  }
  async envelope(envelope: Envelope, phase: string): Promise<void> {
    await this.append(envelope.groupId, [envelope.sender, envelope.recipient], {
      id: phase + ':' + envelope.sender + ':' + envelope.nonce, speaker: 'Wentian-' + envelope.sender.slice(0, 24), at: new Date().toISOString(), content: phase + '\n' + JSON.stringify(envelope, null, 2),
    });
  }
  async notice(peerId: string, title: string, detail: unknown): Promise<void> {
    await this.append(groupIdFor(this.localId, peerId), [this.localId, peerId], {
      id: randomUUID(), speaker: 'Wentian-' + this.localId.slice(0, 24), at: new Date().toISOString(), content: title + '\n' + JSON.stringify(detail, null, 2),
    });
  }
  async history(peerId: string) {
    try { const group = await this.store.load(groupIdFor(this.localId, peerId)); return group.messages.slice(-20); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
}
