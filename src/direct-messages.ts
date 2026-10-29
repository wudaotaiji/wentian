import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { renameWithRetry } from './atomic-file.js';
import { assertOrdinaryPath } from './safe-file.js';
import { directMessagesHtml } from './direct-messages-ui.js';

export interface DmPerson { id: string; name: string }
interface DmMessage { id: string; senderId: string; content: string; at: string }
interface DmThread { id: string; participants: string[]; messages: DmMessage[] }
function denied(message: string, statusCode = 403): Error { return Object.assign(new Error(message), { statusCode }); }

/** 群履歴・AI入力・公開サイトから分離し、参加する二人だけへ返します。 */
export class DirectMessageStore {
  private root: string;
  constructor(workspace: string) { this.root = path.join(workspace, '.wentian', 'direct-messages'); }
  private file(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw denied('会話IDが不正です。', 400);
    return path.join(this.root, id + '.json');
  }
  async get(id: string, userId: string): Promise<DmThread> {
    const file = this.file(id); await assertOrdinaryPath(file);
    let thread: DmThread;
    try { thread = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw denied('会話がありません。', 404); throw error; }
    if (!thread.participants.includes(userId)) throw denied('この個別チャットには参加できません。');
    return thread;
  }
  async list(userId: string): Promise<DmThread[]> {
    await assertOrdinaryPath(this.root);
    const files = await readdir(this.root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const threads: DmThread[] = [];
    for (const file of files.filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
      try { threads.push(await this.get(file.slice(0, -5), userId)); }
      catch (error) { if ((error as { statusCode?: number }).statusCode !== 403) throw error; }
    }
    return threads;
  }
  private async change(id: string, operation: () => Promise<DmThread>): Promise<DmThread> {
    const file = this.file(id), lockPath = file + '.lock';
    await assertOrdinaryPath(file); await assertOrdinaryPath(lockPath); await mkdir(this.root, { recursive: true });
    let lock;
    // 同時送信で発言を失わないよう、プロセス間でも短い排他ロックを取ります。
    for (let attempt = 0; ; attempt++) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Windowsでは直前のロック削除が完了するまでEPERM/EBUSYになる場合があります。
        // 既存ロックと同じ上限内だけ待ち、恒久的な権限エラーは呼出し元へ返します。
        const retryable = code === 'EEXIST' || (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY'));
        if (!retryable || attempt >= 100) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      const thread = await operation();
      await writeFile(temporary, JSON.stringify(thread), { mode: 0o600 }); await renameWithRetry(temporary, file); return thread;
    } finally { await unlink(temporary).catch(() => undefined); await lock.close(); await unlink(lockPath); }
  }
  async create(userId: string, peerId: string): Promise<DmThread> {
    if (!peerId || peerId === userId) throw denied('別の利用者を選んでください。', 400);
    const participants = [userId, peerId].sort(), id = createHash('sha256').update(JSON.stringify(participants)).digest('hex');
    return this.change(id, async () => {
      try { return await this.get(id, userId); }
      catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; return { id, participants, messages: [] }; }
    });
  }
  async post(id: string, userId: string, content: unknown): Promise<DmThread> {
    if (typeof content !== 'string' || !content.trim() || content.length > 10000) throw denied('1〜10000文字の発言を入力してください。', 400);
    return this.change(id, async () => {
      const thread = await this.get(id, userId);
      thread.messages.push({ id: randomUUID(), senderId: userId, content: content.trim(), at: new Date().toISOString() }); return thread;
    });
  }
}

export function registerDirectMessages(app: FastifyInstance, options: {
  workspace: string;
  identity: (req: FastifyRequest) => DmPerson | undefined;
  people: () => DmPerson[];
}): void {
  const store = new DirectMessageStore(options.workspace);
  app.get('/direct-messages', async (_req, reply) => reply.type('text/html; charset=utf-8').send(directMessagesHtml));
  app.register(async routes => {
    routes.addHook('preHandler', async (req, reply) => {
      if (!options.identity(req)) return reply.code(401).send({ error: { message: '個別チャットにはログインが必要です。' } });
      if (req.method !== 'GET' && ((req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site')) return reply.code(403).send({ error: { message: '同じサイトから操作してください。' } });
      reply.header('cache-control', 'no-store');
    });
    routes.get('/api/direct-messages', async req => {
      const me = options.identity(req)!;
      const threads = await store.list(me.id);
      return { me, people: options.people().filter(person => person.id !== me.id), threads: threads.map(({ messages, ...thread }) => ({ ...thread, lastAt: messages.at(-1)?.at, count: messages.length })) };
    });
    routes.post('/api/direct-messages', async req => {
      const me = options.identity(req)!, peerId = (req.body as { peerId?: string })?.peerId;
      if (!options.people().some(person => person.id === peerId)) throw denied('参加可能な利用者を選んでください。', 400);
      return store.create(me.id, peerId!);
    });
    routes.get('/api/direct-messages/:id', req => store.get((req.params as { id: string }).id, options.identity(req)!.id));
    routes.post('/api/direct-messages/:id/messages', async req => {
      const id = (req.params as { id: string }).id, me = options.identity(req)!;
      const thread = await store.get(id, me.id);
      if (thread.participants.some(id => !options.people().some(person => person.id === id))) throw denied('無効になった利用者を含む会話には送信できません。');
      return store.post(id, me.id, (req.body as { content?: unknown })?.content);
    });
  });
}
