import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { assertOrdinaryPath } from './safe-file.js';

export interface PublicGuestProfile { name: string; nickname: string }
export type PublicGuestPost = (id: string, actor: { id: string; name: string }, content: string, profile: { nickname: string; ipAddress: string }) => Promise<void>;
/** 訪問者の入力情報は自己申告です。メール確認済み・登録ユーザーとは扱いません。 */
export function publicGuestProfile(value: unknown): PublicGuestProfile {
  const match = typeof value === 'string' && value.length <= 300 ? /^\s*([^<>\r\n]+?)\s*<([^<>\s]+)>\s*$/.exec(value) : null;
  if (!match || match[1].trim().length > 40 || !match[1].trim() || match[1].trim() === 'ユーザー' || /[\x00-\x1f\x7f]/.test(match[1]) || match[2].length > 254 || !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(match[2])) throw new Error('名前とメールアドレスを入力してください。例：吉田<member@example.com>');
  return { name: match[1].trim(), nickname: match[1].trim() + '<' + match[2] + '>' };
}

/** ゲストのCookieは群・ページ限定です。管理認証や内部APIの認証には使いません。 */
export class PublicGuestSessions {
  private key?: Promise<Buffer>;
  private windows = new Map<string, { until: number; count: number }>();
  constructor(private workspace: string) {}
  private secret() {
    return this.key ??= (async () => {
      const target = path.join(this.workspace, '.wentian', 'public-guests', 'session.key');
      await assertOrdinaryPath(target); await mkdir(path.dirname(target), { recursive: true });
      try { await writeFile(target, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const key = await readFile(target); if (key.length !== 32) throw new Error('訪問者セッション設定を確認してください。'); return key;
    })();
  }
  async actor(req: FastifyRequest, reply: FastifyReply, group: string, page: string, name: string, create: boolean) {
    const scope = group + ':' + page, cookieName = 'wentian_guest_' + createHash('sha256').update(scope).digest('hex').slice(0, 16), key = await this.secret();
    const raw = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (raw && raw.length < 1000) {
      try {
        const [payload, signature] = raw.split('.'), actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', key).update(payload).digest();
        if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
          const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
          if (data.scope === scope && data.expires > Date.now() && /^guest-[a-f0-9-]{36}$/.test(data.id)) return { id: data.id, name };
        }
      } catch {}
    }
    if (!create) return undefined;
    const id = 'guest-' + randomUUID(), payload = Buffer.from(JSON.stringify({ id, scope, expires: Date.now() + 86400000 })).toString('base64url');
    const token = payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
    reply.header('set-cookie', cookieName + '=' + token + '; Path=/api/site/rooms/; HttpOnly; SameSite=Lax; Max-Age=86400' + (req.protocol === 'https' ? '; Secure' : ''));
    return { id, name };
  }
  /** 無認証の連続投稿でAI実行待ちを無制限に増やさないための入口制限です。 */
  accept(ip: string, group: string) {
    const now = Date.now(); for (const [key, value] of this.windows) if (value.until <= now) this.windows.delete(key);
    const key = ip + ':' + group, configured = Number(process.env.WENTIAN_PUBLIC_GUEST_POSTS_PER_MINUTE || 12), limit = Number.isInteger(configured) && configured >= 1 && configured <= 120 ? configured : 12;
    let value = this.windows.get(key);
    if (!value) { if (this.windows.size >= 1024) return false; value = { until: now + 60000, count: 0 }; this.windows.set(key, value); }
    return ++value.count <= limit;
  }
}
