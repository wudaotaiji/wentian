import os from 'node:os';
import { statfsSync } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { FederationRepository } from './repository.js';
import { createIdentity, digest, groupIdFor, publicIdentity, seal, unlock, verifyEnvelope } from './identity.js';
import { GroupJournal } from './group-journal.js';
import { endpoint, httpTransport, type PeerTransport } from './transport.js';
import { FederationError, PEER_PATH, PROTOCOL, record, text, validateDecision, validateTask, type A2ASession, type Envelope, type ExecutionAdapter, type FederationState, type Order, type Outbound, type Peer, type Policy, type PublicIdentity, type Reviewer, type Task } from './contracts.js';

export { endpoint, httpTransport, type PeerTransport } from './transport.js';
export interface FederationOptions {
  directory: string; reviewer: Reviewer; adapters: ExecutionAdapter[]; transport?: PeerTransport;
  observe?: () => { freeMemoryBytes: number; freeDiskBytes: number }; now?: () => number;
  a2aDecide?: (input: unknown) => Promise<unknown>;
  groupWorkspace?: string;
}
/** 各マシンが持つ独立した受付・予約・実行サービスです。中央検索や共通SSOを呼びません。 */
export class FederationService {
  readonly identity: PublicIdentity;
  private readonly adapters: Map<string, ExecutionAdapter>;
  private readonly active = new Set<Promise<void>>();
  private reviewing = 0;
  private a2aBusy = false;
  readonly journal: GroupJournal;
  private closing = false;
  private constructor(readonly repository: FederationRepository, private readonly key: KeyObject, identity: PublicIdentity, private readonly options: FederationOptions) {
    this.identity = identity; this.adapters = new Map(options.adapters.map(adapter => [adapter.id, adapter]));
    this.journal = new GroupJournal(options.groupWorkspace || options.directory, identity.nodeId);
    if (this.adapters.size !== options.adapters.length) throw new FederationError('実行アダプターIDが重複しています。');
    // 実行中の再起動を成功や未実行へ戻さず、不明な副作用を自動再実行しません。
    repository.transaction(state => { for (const order of state.orders) if (order.state === 'running') { order.state = 'unknown'; order.error = '前回実行の終了を確認できません。自動再実行を停止しました。'; order.updatedAt = this.now(); } for (const session of state.sessions || []) if (session.state === 'running') { session.state = 'paused'; session.reason = '再起動後のA2A記録照合が必要です。'; } });
  }
  static async open(options: FederationOptions): Promise<FederationService> {
    const repository = new FederationRepository(options.directory);
    try {
      let identity = repository.identity();
      if (!identity) { identity = await createIdentity(); repository.saveIdentity(identity); }
      return new FederationService(repository, await unlock(identity), publicIdentity(identity.publicKey), options);
    } catch (error) { repository.close(); throw error; }
  }
  private now(): number { return (this.options.now || Date.now)(); }
  private observe() {
    if (this.options.observe) return this.options.observe();
    const disk = statfsSync(this.repository.directory);
    return { freeMemoryBytes: os.freemem(), freeDiskBytes: disk.bavail * disk.bsize };
  }
  private expire(state: FederationState) {
    for (const order of state.orders) if (order.state === 'reserved' && order.expiresAt <= this.now()) { order.state = 'expired'; order.updatedAt = this.now(); }
    state.nonces = state.nonces.filter(nonce => nonce.expiresAt > this.now());
  }
  snapshot() {
    return this.repository.transaction(state => { this.expire(state); return { identity: this.identity, protocol: PROTOCOL, policy: state.policy, peers: state.peers, orders: state.orders, outbound: state.outbound, sessions: state.sessions || [], resources: this.observe(), services: [...this.adapters.values()].map(adapter => ({ id: adapter.id, description: adapter.description })), settlement: 'trial-only' }; });
  }
  policy(value: unknown): Policy {
    const row = record(value);
    if (Object.keys(row).some(key => !['enabled', 'maxConcurrent', 'minFreeMemoryBytes', 'minFreeDiskBytes'].includes(key)) || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.maxConcurrent) || Number(row.maxConcurrent) < 1 || Number(row.maxConcurrent) > 8 || !Number.isSafeInteger(row.minFreeMemoryBytes) || Number(row.minFreeMemoryBytes) < 256 * 1024 ** 2 || !Number.isSafeInteger(row.minFreeDiskBytes) || Number(row.minFreeDiskBytes) < 256 * 1024 ** 2) throw new FederationError('受付設定とローカル安全余裕が不正です。');
    return this.repository.transaction(state => state.policy = row as unknown as Policy);
  }
  trust(value: unknown): Peer {
    const row = record(value), identity = publicIdentity(text(row.publicKey, 2000));
    if (row.nodeId !== identity.nodeId || identity.nodeId === this.identity.nodeId || typeof row.enabled !== 'boolean') throw new FederationError('確認した相手鍵の指紋とノードIDが一致しません。');
    const peer: Peer = { ...identity, endpoint: endpoint(text(row.endpoint, 2048)), enabled: row.enabled };
    return this.repository.transaction(state => {
      const found = state.peers.findIndex(item => item.nodeId === peer.nodeId);
      if (found >= 0) state.peers[found] = peer;
      else { if (state.peers.length >= 128) throw new FederationError('登録できる相手の上限です。', 409); state.peers.push(peer); }
      return peer;
    });
  }
  private peer(id: string): Peer {
    const peer = this.repository.read().peers.find(item => item.nodeId === id && item.enabled);
    if (!peer) throw new FederationError('相手が未承認または失効しています。', 403);
    return peer;
  }
  private nonce(envelope: Envelope) {
    this.repository.transaction(state => {
      this.expire(state); const key = envelope.sender + ':' + envelope.nonce;
      if (state.nonces.some(item => item.key === key)) throw new FederationError('署名要求の再利用を拒否しました。', 409);
      if (state.nonces.length >= 10000) throw new FederationError('受付頻度の上限です。', 429);
      state.nonces.push({ key, expiresAt: this.now() + 120000 });
    });
  }
  async receive(envelope: Envelope): Promise<Envelope> {
    if (this.closing) throw new FederationError('ノードを終了しています。', 503);
    const peer = this.peer(envelope?.sender);
    verifyEnvelope(envelope, peer, this.identity.nodeId, PEER_PATH, this.now());
    await this.journal.envelope(envelope, '受信検証済み'); this.nonce(envelope);
    let payload: unknown;
    try {
      const request = record(envelope.payload);
      let data: unknown;
      if (request.action === 'describe') data = { identity: this.identity, enabled: this.repository.read().policy.enabled, services: [...this.adapters.values()].map(adapter => ({ id: adapter.id, description: adapter.description })), expiresAt: this.now() + 60000, price: { amount: 0, unit: 'trial-credit' } };
      else if (request.action === 'dialogue') {
        if (!this.repository.read().policy.enabled) throw new FederationError('外部AI対話の受付は停止中です。', 403);
        if (this.reviewing >= 2) throw new FederationError('AI対話の同時処理上限です。', 429);
        this.reviewing++;
        try {
          const message = text(request.message, 4000);
          data = validateDecision(await this.options.reviewer({ task: { service: 'a2a.dialogue', objective: message, input: { message } }, requester: peer.nodeId, policy: this.repository.read().policy, adapter: { id: 'a2a.dialogue', description: '相手AIとの相談に日本語で返答し、利用可能なサービスと不足情報を説明する。対話だけでは予約・実行・権限変更を承認しない。提供サービス: ' + [...this.adapters.values()].map(adapter => adapter.id + ': ' + adapter.description).join('; ') } }));
        } finally { this.reviewing--; }
      }
      else if (request.action === 'quote') data = await this.quote(peer.nodeId, text(request.requestId, 100), validateTask(request.task));
      else if (request.action === 'commit') data = this.commit(peer.nodeId, text(request.quoteId));
      else if (request.action === 'status') data = this.order(peer.nodeId, text(request.quoteId));
      else if (request.action === 'cancel') data = this.cancel(peer.nodeId, text(request.quoteId));
      else throw new FederationError('未対応のノード間操作です。');
      payload = { requestNonce: envelope.nonce, ok: true, data };
    } catch (error) {
      payload = { requestNonce: envelope.nonce, ok: false, error: error instanceof FederationError ? error.message : '処理に失敗しました。', statusCode: error instanceof FederationError ? error.statusCode : 500 };
    }
    const reply = seal(this.key, this.identity.nodeId, peer.nodeId, PEER_PATH + '/reply', payload, this.now());
    await this.journal.envelope(reply, '応答送信準備'); return reply;
  }
  private async quote(requester: string, requestId: string, task: Task): Promise<Order> {
    const requestDigest = digest(task);
    const previous = this.repository.read().orders.find(order => order.requester === requester && order.requestId === requestId);
    if (previous) { if (previous.digest !== requestDigest) throw new FederationError('同じ注文IDに異なる内容は使用できません。', 409); return previous; }
    const adapter = this.adapters.get(task.service);
    if (!adapter) throw new FederationError('提供していない実行サービスです。');
    adapter.validate(task.input);
    const policy = this.repository.read().policy;
    if (!policy.enabled) throw new FederationError('外部注文の受付は停止中です。', 403);
    if (this.reviewing >= 2) throw new FederationError('AI受入判断の同時処理上限です。', 429);
    this.reviewing++;
    let decision;
    try { decision = validateDecision(await this.options.reviewer({ task, requester, policy, adapter: { id: adapter.id, description: adapter.description } })); }
    catch { decision = { status: 'unknown' as const, reason: 'AI受入判断を確認できませんでした。' }; }
    finally { this.reviewing--; }
    await this.journal.notice(requester, 'AI受入判断', { requestId, digest: requestDigest, decision });
    if (decision.status !== 'allow') throw new FederationError(decision.reason, 422);
    return this.repository.transaction(state => {
      this.expire(state); this.peer(requester);
      const duplicate = state.orders.find(order => order.requester === requester && order.requestId === requestId);
      if (duplicate) { if (duplicate.digest !== requestDigest) throw new FederationError('同じ注文IDに異なる内容は使用できません。', 409); return duplicate; }
      if (digest(state.policy) !== digest(policy) || !state.policy.enabled || this.closing) throw new FederationError('AI判断中に受付条件が変更されました。再確認してください。', 409);
      const resources = this.observe();
      if (resources.freeMemoryBytes < policy.minFreeMemoryBytes || resources.freeDiskBytes < policy.minFreeDiskBytes || state.orders.filter(order => ['reserved', 'running', 'unknown'].includes(order.state)).length >= policy.maxConcurrent) throw new FederationError('ローカル資源の安全余裕または同時受付枠が不足しています。', 409);
      if (state.orders.length >= 1000) throw new FederationError('台帳の保存上限です。管理者の確認が必要です。', 409);
      const order: Order = { id: digest({ requester, requestId }), requester, requestId, digest: requestDigest, task, state: 'reserved', expiresAt: this.now() + 60000, createdAt: this.now(), updatedAt: this.now(), decision, price: { amount: 0, unit: 'trial-credit' } };
      state.orders.push(order); return order;
    });
  }
  private order(requester: string, id: string): Order {
    return this.repository.transaction(state => { this.expire(state); const order = state.orders.find(item => item.id === id && item.requester === requester); if (!order) throw new FederationError('注文が存在しません。', 404); return order; });
  }
  private commit(requester: string, id: string): Order {
    const order = this.repository.transaction(state => {
      this.expire(state); const item = state.orders.find(order => order.id === id && order.requester === requester);
      if (!item) throw new FederationError('注文が存在しません。', 404);
      if (item.state !== 'reserved') return { order: item, execute: false };
      if (!state.policy.enabled) throw new FederationError('新規実行の受付は停止中です。', 403);
      const resources = this.observe();
      if (resources.freeMemoryBytes < state.policy.minFreeMemoryBytes || resources.freeDiskBytes < state.policy.minFreeDiskBytes) throw new FederationError('実行前のローカル安全余裕が不足しています。', 409);
      item.state = 'running'; item.updatedAt = this.now(); return { order: item, execute: true };
    });
    if (order.execute) {
      // 永続状態を先に確定し、実行の二重起動を防ぎます。結果不明は自動再実行しません。
      const work = Promise.resolve().then(async () => {
        let computed = false;
        try {
          const adapter = this.adapters.get(order.order.task.service);
          if (!adapter) throw new Error();
          const result = await adapter.execute(order.order.task.input);
          computed = true;
          if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128 * 1024) throw new Error();
          await this.journal.notice(requester, '実行結果', { orderId: id, result });
          this.repository.transaction(state => { const current = state.orders.find(item => item.id === id)!; current.state = 'succeeded'; current.result = result; current.updatedAt = this.now(); });
        } catch {
          this.repository.transaction(state => { const current = state.orders.find(item => item.id === id)!; current.state = computed ? 'unknown' : 'failed'; current.error = computed ? '実行後のグループ記録を確認できません。自動再実行を停止しました。' : '実行アダプターが失敗しました。'; current.updatedAt = this.now(); });
        }
      });
      this.active.add(work); void work.finally(() => this.active.delete(work));
    }
    return order.order;
  }
  private cancel(requester: string, id: string): Order {
    return this.repository.transaction(state => { this.expire(state); const order = state.orders.find(item => item.id === id && item.requester === requester); if (!order) throw new FederationError('注文が存在しません。', 404); if (order.state === 'reserved') { order.state = 'cancelled'; order.updatedAt = this.now(); } else if (['running', 'unknown'].includes(order.state)) throw new FederationError('開始済み処理の停止は確認できません。状態を照合してください。', 409); return order; });
  }
  async send(peerId: string, payload: unknown): Promise<{ data: unknown; receipt: Envelope }> {
    const peer = this.peer(peerId), envelope = seal(this.key, this.identity.nodeId, peerId, PEER_PATH, payload, this.now());
    await this.journal.envelope(envelope, '送信準備');
    let receipt: Envelope;
    try { receipt = await (this.options.transport || httpTransport)(peer, envelope); }
    catch (error) { await this.journal.notice(peerId, '通信結果不明', { requestNonce: envelope.nonce, action: record(payload).action }); throw error; }
    verifyEnvelope(receipt, peer, this.identity.nodeId, PEER_PATH + '/reply', this.now());
    await this.journal.envelope(receipt, '受信検証済み');
    this.peer(peerId); this.nonce(receipt);
    const reply = record(receipt.payload);
    if (reply.requestNonce !== envelope.nonce) throw new FederationError('要求と応答の対応が一致しません。', 401);
    if (reply.ok !== true) throw new FederationError(typeof reply.error === 'string' ? reply.error : '相手が注文を受理しませんでした。', 409);
    return { data: reply.data, receipt };
  }
  async request(peerId: string, value: unknown, requestId: string, sessionId?: string): Promise<Outbound> {
    const task = validateTask(value); text(requestId, 100); this.peer(peerId);
    const id = digest({ peerId, requestId });
    const previous = this.repository.transaction(state => {
      const found = state.outbound.find(item => item.id === id);
      if (found) { if (digest(found.task) !== digest(task) || found.sessionId !== sessionId) throw new FederationError('同じ注文IDに異なる内容や対話は使用できません。', 409); return found; }
      if (state.outbound.length >= 1000) throw new FederationError('送信台帳の保存上限です。', 409);
      const item: Outbound = { id, peerId, requestId, task, state: 'pending', updatedAt: this.now(), ...(sessionId ? { sessionId } : {}) }; state.outbound.push(item); return item;
    });
    if (previous.quoteId) return previous;
    try {
      const reply = await this.send(peerId, { action: 'quote', requestId, task });
      const quote = record(reply.data);
      if (quote.id !== digest({ requester: this.identity.nodeId, requestId }) || quote.digest !== digest(task) || quote.requester !== this.identity.nodeId || record(quote.price).amount !== 0 || record(quote.price).unit !== 'trial-credit') throw new FederationError('見積りの内容が注文と一致しません。', 409);
      return this.repository.transaction(state => { const item = state.outbound.find(item => item.id === id)!; item.quoteId = String(quote.id); item.state = 'reserved'; item.receipt = reply.receipt; item.updatedAt = this.now(); return item; });
    } catch (error) { this.markUnknown(id); throw error; }
  }
  private markUnknown(id: string) { this.repository.transaction(state => { const item = state.outbound.find(item => item.id === id)!; item.state = 'unknown'; item.updatedAt = this.now(); }); }
  async reconcileOutgoing(id: string): Promise<Outbound> {
    const order = this.repository.read().outbound.find(item => item.id === id);
    if (!order) throw new FederationError('照合する注文が存在しません。', 404);
    return this.request(order.peerId, order.task, order.requestId, order.sessionId);
  }
  async updateOutgoing(id: string, action: 'commit' | 'status' | 'cancel'): Promise<Outbound> {
    const order = this.repository.read().outbound.find(item => item.id === id);
    if (!order?.quoteId) throw new FederationError('照合できる見積りがありません。', 409);
    try {
      const reply = await this.send(order.peerId, { action, quoteId: order.quoteId });
      const result = record(reply.data);
      if (result.id !== order.quoteId || result.digest !== digest(order.task) || result.requester !== this.identity.nodeId) throw new FederationError('注文結果の対応が一致しません。', 409);
      return this.repository.transaction(state => { const item = state.outbound.find(item => item.id === id)!; item.state = action === 'commit' ? 'submitted' : 'observed'; item.receipt = reply.receipt; item.updatedAt = this.now(); return item; });
    } catch (error) { this.markUnknown(id); throw error; }
  }
  /** 利用者の目的だけを受け取り、双方AIの対話と構造化操作を永続記録付きで進めます。 */
  async runA2A(objective: string, sessionId: string): Promise<A2ASession> {
    text(objective, 2000); text(sessionId, 100);
    if (this.a2aBusy || this.closing) throw new FederationError('別のA2A処理または終了処理が進行中です。', 409);
    if (!this.options.a2aDecide) throw new FederationError('A2A判断プラグインが設定されていません。', 422);
    this.a2aBusy = true;
    try {
      let session = this.repository.transaction(state => {
        state.sessions ||= []; const found = state.sessions.find(item => item.id === sessionId);
        if (found) { if (found.objective !== objective) throw new FederationError('同じ対話IDに異なる目的は使用できません。', 409); return found; }
        if (state.sessions.length >= 100) throw new FederationError('A2A履歴の保存上限です。', 409);
        const item: A2ASession = { id: sessionId, objective, state: 'running', reason: 'AI対話を開始します。', steps: [], updatedAt: this.now() }; state.sessions.push(item); return item;
      });
      if (session.state === 'completed') return session;
      for (let turn = 0; turn < 8 && session.steps.length < 32 && !this.closing; turn++) {
        try {
          const state = this.repository.read();
          const action = record(await this.options.a2aDecide({ objective, session, groupMessages: session.peerId ? await this.journal.history(session.peerId) : [], peers: state.peers.filter(peer => peer.enabled), outbound: state.outbound.filter(order => order.sessionId === sessionId), constraints: { maxPrice: 0, unit: 'trial-credit', remainingTurns: 8 - turn } }));
          const reason = text(action.reason, 2000);
          if (action.action === 'unknown') { if (session.peerId) await this.journal.notice(session.peerId, 'A2Aを保留', { sessionId, reason }); session = this.saveSession(sessionId, item => { item.state = 'paused'; item.reason = reason; }); break; }
          if (action.action === 'finish') {
            const order = state.outbound.find(order => order.id === action.outgoingId && order.sessionId === sessionId);
            if (!order?.receipt || record(record(order.receipt.payload).data).state !== 'succeeded') throw new FederationError('A2Aの完了には対応する成功結果の署名記録が必要です。', 409);
            await this.journal.notice(order.peerId, 'A2Aの完了確認', { sessionId, orderId: order.id, reason });
            session = this.saveSession(sessionId, item => { item.state = 'completed'; item.reason = reason; }); break;
          }
          if (!['message', 'describe', 'quote', 'reconcile', 'commit', 'status', 'cancel'].includes(String(action.action))) throw new FederationError('A2Aが未許可の操作を指定しました。');
          const target = ['message', 'describe', 'quote'].includes(String(action.action)) ? text(action.peerId) : state.outbound.find(order => order.id === action.outgoingId)?.peerId;
          if (!target || (session.peerId && session.peerId !== target)) throw new FederationError('この対話は同じ相手とのグループ内で継続してください。');
          this.peer(target);
          await this.journal.notice(target, 'A2Aの目的とAI提案', { sessionId, objective, action });
          session = this.saveSession(sessionId, item => { item.peerId = target; item.groupId = groupIdFor(this.identity.nodeId, target); });
          const index = session.steps.length;
          session = this.saveSession(sessionId, item => { item.state = 'running'; item.steps.push({ action, state: 'planned' }); });
          let result: unknown;
          if (action.action === 'message') result = (await this.send(text(action.peerId), { action: 'dialogue', message: text(action.message, 4000) })).data;
          else if (action.action === 'describe') result = (await this.send(text(action.peerId), { action: 'describe' })).data;
          else if (action.action === 'quote') result = await this.request(text(action.peerId), action.task, digest({ sessionId, index }), sessionId);
          else {
            const owned = this.repository.read().outbound.find(order => order.id === action.outgoingId && order.sessionId === sessionId);
            if (!owned) throw new FederationError('別のA2A対話の注文は操作できません。', 403);
            result = action.action === 'reconcile' ? await this.reconcileOutgoing(owned.id) : await this.updateOutgoing(owned.id, action.action as 'commit' | 'status' | 'cancel');
          }
          session = this.saveSession(sessionId, item => { item.steps[index].state = 'observed'; item.steps[index].result = result; item.reason = reason; });
        } catch (error) {
          session = this.saveSession(sessionId, item => { item.state = 'paused'; item.reason = error instanceof FederationError ? error.message : 'AI対話の判断・通信結果を確認できませんでした。'; const last = item.steps.at(-1); if (last?.state === 'planned') last.state = 'unknown'; }); break;
        }
      }
      if (session.state === 'running') session = this.saveSession(sessionId, item => { item.state = 'paused'; item.reason = 'A2Aの試行上限に達しました。記録を確認して再開してください。'; });
      return session;
    } finally { this.a2aBusy = false; }
  }
  private saveSession(id: string, change: (session: A2ASession) => void): A2ASession {
    return this.repository.transaction(state => { const item = state.sessions!.find(item => item.id === id)!; change(item); item.updatedAt = this.now(); return item; });
  }
  async close(): Promise<void> { this.closing = true; while (this.a2aBusy || this.reviewing) await new Promise(resolve => setTimeout(resolve, 10)); await Promise.allSettled([...this.active]); this.repository.close(); }
}
