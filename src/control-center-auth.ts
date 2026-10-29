/**
 * Control Center専用の認証（Authentication）とユーザー永続化を提供します。
 *
 * パスワードは平文保存せず、Node.js標準のscryptでソルト付きハッシュへ変換します。
 * ユーザー情報はAtomic Write（アトミック書き込み）でJSONへ保存し、ログインセッションは
 * Gatewayプロセスのメモリだけに保持します。したがってGateway再起動時には安全側へ倒れ、
 * 全利用者が再ログインする必要があります。
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicOrdinaryWrite } from './safe-file.js';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

export type ControlCenterRole = 'admin' | 'operator' | 'viewer';

export interface ControlCenterUser {
  id: string;
  username: string;
  displayName: string;
  role: ControlCenterRole;
  enabled: boolean;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicControlCenterUser extends Omit<ControlCenterUser, 'passwordHash'> {}

interface SessionRecord {
  token: string;
  userId: string;
  expiresAt: number;
}
interface UserAuditEntry { at: string; action: string; userId: string; actorId: string }

/** Cookie値を安全に抽出します。外部パッケージへ依存せず、Control Center用途に限定します。 */
export function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) { try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch { return undefined; } }
  }
  return undefined;
}

/** レスポンスへ設定するHttpOnlyセッションCookieを組み立てます。 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `wentian_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export class ControlCenterAuthStore {
  private users: ControlCenterUser[] = [];
  private audit: UserAuditEntry[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private readonly sessions = new Map<string, SessionRecord>();
  private initialized = false;

  constructor(
    private readonly filePath = path.resolve(process.env.WENTIAN_USER_STORE || '.wentian/control-center-users.json'),
    private readonly sessionLifetimeMs = 8 * 60 * 60 * 1000,
  ) {}

  /** 初回だけ保存済みユーザーを読み、環境変数があれば初期管理者を作成します。 */
  async initialize(options: { bootstrap?: boolean } = {}): Promise<void> {
    if (this.initialized) return;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as { users?: ControlCenterUser[]; audit?: UserAuditEntry[] };
      this.users = Array.isArray(parsed.users) ? parsed.users : [];
      this.audit = Array.isArray(parsed.audit) ? parsed.audit : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
    const username = process.env.WENTIAN_ADMIN_USERNAME?.trim();
    const password = process.env.WENTIAN_ADMIN_PASSWORD;
    if (options.bootstrap !== false && this.users.length === 0 && username && password) {
      await this.createUser({ username, password, displayName: 'Wentian Administrator', role: 'admin', enabled: true });
    }
  }

  listUsers(): PublicControlCenterUser[] {
    return this.users.map(({ passwordHash: _secret, ...user }) => user);
  }

  findPublicUser(id: string): PublicControlCenterUser | undefined {
    const user = this.users.find(candidate => candidate.id === id);
    if (!user) return undefined;
    const { passwordHash: _secret, ...publicUser } = user;
    return publicUser;
  }

  private validate(input: Record<string, unknown>): void {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('利用者情報が不正です。');
    if (input.username !== undefined && (typeof input.username !== 'string' || !/^[a-z0-9._-]{3,40}$/i.test(input.username.trim()))) throw new Error('ユーザー名は3～40文字の英数字、ピリオド、ハイフン、アンダースコアで指定してください。');
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 1024)) throw new Error('パスワードは12～1024文字で指定してください。');
    if (input.displayName !== undefined && (typeof input.displayName !== 'string' || input.displayName.trim().length > 40 || /[\x00-\x1f\x7f]/.test(input.displayName))) throw new Error('表示名は40文字以内で指定してください。');
    if (input.role !== undefined && !['admin', 'operator', 'viewer'].includes(input.role as string)) throw new Error('権限はadmin、operator、viewerから選んでください。');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('有効状態を真偽値で指定してください。');
  }
  /** 保存成功後だけメモリを更新し、並行操作による上書き・最後の管理者の喪失を防ぎます。 */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation); this.pending = next.catch(() => undefined); return next;
  }
  private async commit(users: ControlCenterUser[], action: string, userId: string, actorId: string): Promise<void> {
    const audit = [...this.audit, { at: new Date().toISOString(), action, userId, actorId }].slice(-1000);
    await atomicOrdinaryWrite(this.filePath, JSON.stringify({ version: 1, users, audit }, null, 2));
    this.users = users; this.audit = audit;
  }
  private protectAdmin(users: ControlCenterUser[]): void {
    if (this.users.some(u => u.role === 'admin' && u.enabled) && !users.some(u => u.role === 'admin' && u.enabled)) throw new Error('最後の有効な管理者は削除・無効化・降格できません。');
  }
  async createUser(input: { username: string; password: string; displayName?: string; role?: ControlCenterRole; enabled?: boolean }, actorId = 'system', requireEmpty = false): Promise<PublicControlCenterUser> {
    return this.mutate(async () => {
      if (requireEmpty && this.users.length) throw new Error('初期管理者は作成済みです。');
      this.validate(input as unknown as Record<string, unknown>);
      if (!input.username || !input.password) throw new Error('ユーザー名とパスワードを指定してください。');
      const username = input.username.trim().toLowerCase();
      if (this.users.some(user => user.username === username)) throw new Error('同じユーザー名が既に存在します。');
      const now = new Date().toISOString();
      const user: ControlCenterUser = { id: randomBytes(12).toString('hex'), username, displayName: input.displayName?.trim() || username, role: input.role || 'viewer', enabled: input.enabled ?? true, passwordHash: await this.hashPassword(input.password), createdAt: now, updatedAt: now };
      await this.commit([...this.users, user], 'create', user.id, actorId); return this.findPublicUser(user.id)!;
    });
  }
  async createInitialAdmin(input: { username: string; password: string }): Promise<PublicControlCenterUser> {
    return this.createUser({ ...input, displayName: input.username, role: 'admin' }, 'setup', true);
  }
  async updateUser(id: string, input: { username?: string; displayName?: string; role?: ControlCenterRole; enabled?: boolean; password?: string }, actorId = 'system'): Promise<PublicControlCenterUser> {
    return this.mutate(async () => {
      this.validate(input as Record<string, unknown>);
      const original = this.users.find(candidate => candidate.id === id);
      if (!original) throw new Error('ユーザーが見つかりません。');
      const user = { ...original };
      if (input.username !== undefined) user.username = input.username.trim().toLowerCase();
      if (this.users.some(other => other.id !== id && other.username === user.username)) throw new Error('同じユーザー名が既に存在します。');
      if (input.displayName !== undefined) user.displayName = input.displayName.trim() || user.username;
      if (input.role !== undefined) user.role = input.role;
      if (input.enabled !== undefined) user.enabled = input.enabled;
      if (input.password !== undefined) user.passwordHash = await this.hashPassword(input.password);
      user.updatedAt = new Date().toISOString();
      const users = this.users.map(other => other.id === id ? user : other); this.protectAdmin(users);
      await this.commit(users, input.password !== undefined ? 'password-reset' : 'update', id, actorId);
      if (input.password !== undefined || original.username !== user.username || original.role !== user.role || original.enabled !== user.enabled) this.revokeUserSessions(id);
      return this.findPublicUser(id)!;
    });
  }
  async deleteUser(id: string, actorId: string): Promise<void> {
    return this.mutate(async () => {
      if (id === actorId) throw new Error('ログイン中の管理者自身は削除できません。');
      if (!this.users.some(user => user.id === id)) throw new Error('ユーザーが見つかりません。');
      const users = this.users.filter(user => user.id !== id); this.protectAdmin(users);
      await this.commit(users, 'delete', id, actorId); this.revokeUserSessions(id);
    });
  }
  async updateProfile(id: string, input: { username?: string; displayName?: string; currentPassword?: string; password?: string }): Promise<PublicControlCenterUser> {
    // 本人変更は再認証後も同じ排他キューの中で確定し、権限・有効状態は変更しません。
    return this.mutate(async () => {
      this.validate(input as Record<string, unknown>);
      const original = this.users.find(user => user.id === id && user.enabled);
      if (!original || typeof input.currentPassword !== 'string' || !(await this.verifyPassword(input.currentPassword, original.passwordHash))) throw new Error('現在のパスワードが正しくありません。');
      const user = { ...original, username: input.username?.trim().toLowerCase() ?? original.username, displayName: input.displayName?.trim() || original.displayName, updatedAt: new Date().toISOString() };
      if (this.users.some(other => other.id !== id && other.username === user.username)) throw new Error('同じユーザー名が既に存在します。');
      if (input.password !== undefined) user.passwordHash = await this.hashPassword(input.password);
      await this.commit(this.users.map(other => other.id === id ? user : other), 'profile-update', id, id);
      this.revokeUserSessions(id); return this.findPublicUser(id)!;
    });
  }
  sessionCount(id: string): number { return [...this.sessions.values()].filter(session => session.userId === id && session.expiresAt > Date.now()).length; }
  auditLog(): typeof this.audit { return this.audit.map(entry => ({ ...entry })); }
  async revokeSessions(id: string, actorId: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.users.some(user => user.id === id)) throw new Error('ユーザーが見つかりません。');
      await this.commit(this.users, 'sessions-revoked', id, actorId); this.revokeUserSessions(id);
    });
  }

  async login(usernameInput: string, password: string): Promise<{ token: string; user: PublicControlCenterUser } | undefined> {
    if (typeof usernameInput !== 'string' || typeof password !== 'string' || password.length > 1024) return undefined;
    const username = usernameInput.trim().toLowerCase();
    const user = this.users.find(candidate => candidate.username === username && candidate.enabled);
    if (!user) return undefined;
    const verifiedHash = user.passwordHash;
    if (!(await this.verifyPassword(password, verifiedHash))) return undefined;
    const current = this.users.find(other => other.id === user.id);
    if (!current?.enabled || current.passwordHash !== verifiedHash || current.username !== username) return undefined;
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { token, userId: user.id, expiresAt: Date.now() + this.sessionLifetimeMs });
    return { token, user: this.findPublicUser(user.id)! };
  }

  authenticate(token: string | undefined): PublicControlCenterUser | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(token);
      return undefined;
    }
    const user = this.findPublicUser(session.userId);
    return user?.enabled ? user : undefined;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private revokeUserSessions(userId: string): void {
    for (const [token, session] of this.sessions) if (session.userId === userId) this.sessions.delete(token);
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, 64) as Buffer;
    return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`;
  }

  private async verifyPassword(password: string, stored: string): Promise<boolean> {
    const [algorithm, saltValue, hashValue] = stored.split(':');
    if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
    const expected = Buffer.from(hashValue, 'base64');
    const actual = await scrypt(password, Buffer.from(saltValue, 'base64'), expected.length) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

}
