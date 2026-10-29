// team-access.ts — P1 チーム別の利用管理（Team-based Usage Management）
// 永続化する対象: ユーザー・プロジェクト所属（Membership）・役割（Role）・モデル許可（Model Allow-list）・
// 仮想キー（Virtual Key）のハッシュ・明示価格（Explicit Pricing）・予算（Budget）・予約（Reservation）・監査履歴（Audit Trail）。
// 設計方針:
//  - 状態は専用 root 配下の 1 ファイル（team-access.json）に保存し、原子リネーム（Atomic Rename）で更新します。
//  - すべての変更（Mutate）は Promise キューで直列化し、毎回ディスクから再読込します。
//    同じプロセス内なら並行要求でも「予約済み金額」をvisibility した順次判定になるため、予算超過が併発しません。
//  - 仮想キー原文（Plaintext）は発行時だけ返し、保存は SHA-256 ハッシュのみ。監査・一覧から原文は出ません。
//  - 料金不明をゼロ費用として捏造（Fabricate）しません。費用予算があるプロジェクトは明示価格設定が必須で、
//    価格が無いモデルの予約は 409 で拒否します。予算が無いプロジェクトだけ費用不明（Unknown）を許します。
//  - モデル許可は authoritative exact match（原文完全一致・大文字小文字保持）で、前方一致や正規化はしません。
import { mkdir, readFile, writeFile, open, unlink, lstat } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { renameWithRetry } from './atomic-file.js';

/* ===== 型定義（Types） ===== */
export type TeamRole = 'owner' | 'member';
/** 実行主体（Actor）。identity はルート層でホスト認証が確定させたものだけを使い、API本文からの指定は受け付けません。 */
export type Actor = { kind: 'user'; userId: string } | { kind: 'key'; keyId: string; projectId: string };

export interface UserRecord { id: string; displayName: string; platformAdmin: boolean; createdAt: string }
export interface KeyRecord { id: string; projectId: string; label: string; hash: string; prefix: string; createdAt: string; revokedAt?: string; lastUsedAt?: string }
export interface PricingRecord { inputUsdPerMTok: number; outputUsdPerMTok: number }
export interface ReservationRecord {
  id: string; projectId: string; model: string; estimatedUsd: number; createdAt: string; expiresAt: string;
  state: 'reserved' | 'committed' | 'cancelled' | 'expired'; committedUsd?: number; costKnown: boolean; pricingSnapshot?: PricingRecord;
}
export interface ProjectRecord {
  id: string; name: string; createdAt: string;
  members: Record<string, TeamRole>;                      // 永続プロジェクト所属と役割
  allowedModels: string[];                               // モデル許可（完全一致）
  pricing: Record<string, PricingRecord>;                // モデル別明示価格（USD / 1M tokens）
  budgetUsd?: number;                                    // 費用予算。未設定なら費用は監視しない（不明を許す）
  requestLimit?: { maxRequests: number; windowMs: number }; // 利用枠（回数枠・窓付き）
  spendUsd: number;                                      // 確定済み費用（価格不明分は含めない）
  requestLog: string[];                                  // 予約受付時刻（ISO）。窓内で回数枠を判定する
  keys: KeyRecord[];
  reservations: ReservationRecord[];
}
export interface AuditRecord { id: string; at: string; actorType: 'user' | 'key' | 'system'; actorId: string; action: string; projectId?: string; detail: Record<string, string | number | boolean | null> }
export interface TeamAccessState { version: '1.0'; users: UserRecord[]; projects: ProjectRecord[]; audit: AuditRecord[] }

/** HTTP ステータスと ErrorCode を持つ業務エラー。ルート層がそのまま 4xx レスポンスへ変換します。 */
export class TeamAccessError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
// 明示的な型注釈付き never 戻し関数にします（TypeScript の到達性解析で「以降は到達不能」と認識させるため）。
const fail: (status: number, code: string, message: string) => never = (status, code, message) => { throw new TeamAccessError(status, code, message); };

// 監査 detail に秘密・本文系キーが混ざったら除去します（storage.ts の FORBIDDEN_KEYS と同じ狙い）。
const FORBIDDEN_DETAIL_KEYS = /(?:prompt|messages?|content|api.?key|authorization|token|secret|password|plaintext)/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;
const boundedText = (value: unknown, max: number, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, 'invalid_input', `${label}は1〜${max}文字で指定してください。`);
  return value.trim();
};
const safeId = (value: unknown, label: string): string => {
  const id = boundedText(value, 64, `${label} ID`);
  if (!ID_PATTERN.test(id)) fail(400, 'invalid_input', `${label} IDは英数字・. _ - で始まる1〜64文字にしてください。`);
  return id;
};
const nonNegative = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(400, 'invalid_input', `${label}は0以上の有限数で指定してください。`);
  return value;
};
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export interface TeamAccessServiceOptions { root: string; now?: () => number; reservationTtlMs?: number; auditLimit?: number }

/**
 * プロジェクト単位の所属・権限・モデル許可・仮想キー・予算予約を集約するクラス API（Class API）。
 * ルート登録（team-access-routes.ts）からも、メイン Gateway のコードからも、このクラスだけを介して状態を変更します。
 */
export class TeamAccessService {
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly reservationTtlMs: number;
  private readonly auditLimit: number;
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void> | undefined;

  constructor(options: TeamAccessServiceOptions) {
    if (!options.root || typeof options.root !== 'string') throw new Error('専用 root を指定してください。');
    this.statePath = path.join(path.resolve(options.root), 'team-access.json');
    this.now = options.now ?? (() => Date.now());
    this.reservationTtlMs = options.reservationTtlMs ?? 15 * 60 * 1000;
    this.auditLimit = options.auditLimit ?? 1000;
  }

  /** 初回利用時に状態ファイルと親ディレクトリを用意します。多重呼び出しでは同一 Promise を返します。 */
  initialize(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      // 作成は変更ロックの内側だけで行います。複数インスタンスの初期化による上書きを防ぎます。
    })();
    return this.ready;
  }

  /* ===== 永続化（Persistence） ===== */
  private async load(): Promise<TeamAccessState> {
    try {
      const info = await lstat(this.statePath);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error('リンクされた利用台帳は使用できません。');
      const state = JSON.parse(await readFile(this.statePath, 'utf8')) as TeamAccessState;
      if (state.version !== '1.0' || !Array.isArray(state.users) || !Array.isArray(state.projects) || !Array.isArray(state.audit)) throw new Error('利用台帳が破損しています。');
      return state;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: '1.0', users: [], projects: [], audit: [] };
      throw error;
    }
  }
  /** 一時ファイル→原子リネームで保存し、途中状態（破損JSON）を磁盘に残しません。 */
  private async save(state: TeamAccessState): Promise<void> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await renameWithRetry(temporary, this.statePath);
  }
  /** 変更操作を直列化します。fn 内で必ず再読込後の state を書き換え、完了時に原子保存します。 */
  private mutate<T>(fn: (state: TeamAccessState) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.initialize();
      // プロセス内キューに加え、OSファイルロックで複数Gatewayの同時予算予約も直列化します。
      for (let item = path.dirname(this.statePath); item !== path.dirname(item); item = path.dirname(item)) {
        if ((await lstat(item)).isSymbolicLink()) throw new Error('リンクされた利用台帳の保存場所は使用できません。');
      }
      const lockPath = `${this.statePath}.lock`;
      let lock;
      for (let attempt = 0; attempt < 200; attempt++) {
        try { lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const owner = Number(await readFile(lockPath, 'utf8').catch(() => ''));
          if (owner > 0) {
            try { process.kill(owner, 0); }
            catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') await unlink(lockPath).catch(() => undefined); }
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      if (!lock) throw new Error('利用台帳の排他を取得できません。');
      try {
        const state = await this.load(); const result = await fn(state); await this.save(state); return result;
      } finally { await lock.close(); await unlink(lockPath).catch(() => undefined); }
    });
    this.queue = run.catch(() => undefined); // 失敗を次の操作に伝播させず、キューを止めません
    return run as Promise<T>;
  }
  /** 監査1件を追記します。detail の秘密系キーは保存前に除去します。 */
  private audit(state: TeamAccessState, actor: Actor | { kind: 'system' }, action: string, projectId: string | undefined, detail: Record<string, unknown>): void {
    const clean = Object.fromEntries(Object.entries(detail)
      .filter(([key]) => !FORBIDDEN_DETAIL_KEYS.test(key))
      .map(([key, value]) => [key, value as string | number | boolean | null]));
    state.audit.push({ id: randomUUID(), at: new Date(this.now()).toISOString(), actorType: actor.kind === 'user' ? 'user' : actor.kind === 'key' ? 'key' : 'system', actorId: actor.kind === 'system' ? 'system' : actor.kind === 'user' ? actor.userId : actor.keyId, action, ...(projectId ? { projectId } : {}), detail: clean });
    if (state.audit.length > this.auditLimit) state.audit.splice(0, state.audit.length - this.auditLimit);
  }

  /* ===== 認可ヘルパ（Authorization Helpers） ===== */
  private requireUser(state: TeamAccessState, userId: string): UserRecord {
    const user = state.users.find(u => u.id === userId);
    return user ?? fail(403, 'unknown_identity', '登録されていない identity では操作できません。');
  }
  private requireProject(state: TeamAccessState, projectId: string): ProjectRecord {
    const project = state.projects.find(p => p.id === projectId);
    return project ?? fail(404, 'project_not_found', 'プロジェクトが存在しません。');
  }
  /** プロジェクト管理者（owner または platformAdmin）だけを許可します。他プロジェクトの者は一律拒否です。 */
  private requireProjectAdmin(state: TeamAccessState, actor: Actor, projectId: string): ProjectRecord {
    const project = this.requireProject(state, projectId);
    if (actor.kind === 'key') fail(403, 'key_admin_forbidden', '仮想キーでは管理操作（Member・設定・キー発行）を行えません。');
    const user = this.requireUser(state, actor.userId);
    if (user.platformAdmin || project.members[actor.userId] === 'owner') return project;
    fail(403, 'project_admin_required', 'そのプロジェクトの owner または platform admin が必要です。');
  }
  /** 所属メンバー（member 以上）または platformAdmin だけを許可します。他者のプロジェクト参照防止。 */
  private requireProjectMember(state: TeamAccessState, actor: Actor, projectId: string): ProjectRecord {
    const project = this.requireProject(state, projectId);
    if (actor.kind === 'key') {
      if (actor.projectId !== projectId) fail(403, 'cross_project_denied', '他プロジェクトの情報にはアクセスできません。');
      return project;
    }
    const user = this.requireUser(state, actor.userId);
    if (user.platformAdmin || ['owner', 'member'].includes(project.members[actor.userId])) return project;
    fail(403, 'project_membership_required', 'そのプロジェクトのメンバーだけです。');
  }
  /** 予約の現在保持額から期限切れを解放します（滞留予約が予算を無限に押さえないため）。 */
  private pruneReservations(project: ProjectRecord): void {
    const now = this.now();
    for (const reservation of project.reservations) {
      if (reservation.state === 'reserved' && Date.parse(reservation.expiresAt) <= now) reservation.state = 'expired';
    }
  }
  /** 予約（reserved）の合計額。予算判定の「すでに押さえられている額」です。 */
  private heldUsd(project: ProjectRecord): number {
    this.pruneReservations(project);
    return project.reservations.filter(r => r.state === 'reserved').reduce((sum, r) => sum + r.estimatedUsd, 0);
  }

  /* ===== 台帳 API（Ledger API: users / projects / members / pricing） ===== */
  /** ユーザー登録。platformAdmin はプラットフォーム全体の管理権（プロジェクト横断）です。
   *  ユーザーが1人もいない初期状態では system actor（ホストのブートストラップ処理）による作成だけ許します。 */
  createUser(input: { id?: string; displayName: string; platformAdmin?: boolean }, actor: Actor | { kind: 'system' }): Promise<UserRecord> {
    return this.mutate(state => {
      if (state.users.length === 0 && actor.kind !== 'system') fail(403, 'bootstrap_required', '初期ユーザーはホストの認証情報から登録してください。');
      if (state.users.length > 0) {
        // 2人目以降は platform admin が必要です。API本文で identity を選べないため、昇格の勝手口にはなりません。
        if (actor.kind !== 'user' || !this.requireUser(state, actor.userId).platformAdmin) fail(403, 'platform_admin_required', 'ユーザー登録には platform admin が必要です。');
      }
      const id = input.id === undefined ? `u-${randomUUID().slice(0, 8)}` : safeId(input.id, 'User');
      if (state.users.some(u => u.id === id)) fail(409, 'user_exists', '同一 ID のユーザーがすでにいます。');
      const user: UserRecord = { id, displayName: boundedText(input.displayName, 80, '表示名'), platformAdmin: input.platformAdmin === true, createdAt: new Date(this.now()).toISOString() };
      state.users.push(user);
      this.audit(state, actor, 'user_create', undefined, { targetUserId: id, platformAdmin: user.platformAdmin });
      return user;
    });
  }

  /** ホストが本人確認した利用者だけを同期します。HTTP本文からこのメソッドを呼ばせません。 */
  syncHostUser(input: { id: string; displayName: string; platformAdmin: boolean }): Promise<UserRecord> {
    return this.mutate(state => {
      const id = safeId(input.id, 'User');
      let user = state.users.find(u => u.id === id);
      if (!user) { user = { id, displayName: boundedText(input.displayName, 80, '表示名'), platformAdmin: input.platformAdmin, createdAt: new Date(this.now()).toISOString() }; state.users.push(user); }
      else { user.displayName = boundedText(input.displayName, 80, '表示名'); user.platformAdmin = input.platformAdmin; }
      return user;
    });
  }

  /** プロジェクト作成。作成者を owner として所属保持に記録します。 */
  createProject(input: { id?: string; name: string; ownerId: string }, actor: Actor): Promise<ProjectRecord> {
    return this.mutate(state => {
      const actorUser = actor.kind === 'user' ? this.requireUser(state, actor.userId) : fail(403, 'key_admin_forbidden', '仮想キーではプロジェクトを作れません。');
      if (state.users.some(u => u.platformAdmin) && !actorUser.platformAdmin) fail(403, 'platform_admin_required', 'プロジェクト作成には platform admin が必要です。');
      const id = input.id === undefined ? `p-${randomUUID().slice(0, 8)}` : safeId(input.id, 'Project');
      if (state.projects.some(p => p.id === id)) fail(409, 'project_exists', '同一 ID のプロジェクトがすでにいます。');
      const owner = this.requireUser(state, input.ownerId);
      const project: ProjectRecord = { id, name: boundedText(input.name, 120, 'プロジェクト名'), createdAt: new Date(this.now()).toISOString(), members: { [owner.id]: 'owner' }, allowedModels: [], pricing: {}, spendUsd: 0, requestLog: [], keys: [], reservations: [] };
      state.projects.push(project);
      this.audit(state, actor, 'project_create', id, { ownerUserId: owner.id });
      return project;
    });
  }

  /** メンバーの所属・役割変更。プロジェクト owner か platformAdmin だけです。 */
  addProjectMember(projectId: string, userId: string, role: TeamRole, actor: Actor): Promise<ProjectRecord> {
    return this.mutate(state => {
      const project = this.requireProjectAdmin(state, actor, projectId);
      if (role !== 'owner' && role !== 'member') fail(400, 'invalid_role', '役割は owner か member です。');
      const user = this.requireUser(state, userId);
      if (role === 'member' && project.members[user.id] === 'owner' && Object.values(project.members).filter(value => value === 'owner').length === 1) fail(409, 'last_owner', '最後のオーナー（Owner）は降格できません。');
      project.members[user.id] = role;
      this.audit(state, actor, 'member_add', projectId, { targetUserId: user.id, role });
      return project;
    });
  }

  /** プロジェクト設定の更新: モデル許可・予算・回数枠・明示価格。owner か platformAdmin だけです。 */
  updateProject(projectId: string, patch: { allowedModels?: string[]; budgetUsd?: number | null; requestLimit?: { maxRequests: number; windowMs: number } | null; pricing?: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }> | null }, actor: Actor): Promise<ProjectRecord> {
    return this.mutate(state => {
      const project = this.requireProjectAdmin(state, actor, projectId);
      if (patch.allowedModels !== undefined) {
        if (!Array.isArray(patch.allowedModels) || patch.allowedModels.length > 200) fail(400, 'invalid_input', 'allowedModels は最大200件の配列です。');
        // authoritative model exact match: 原文のまま保存し、判定時も完全一致だけを使います（trim・大小変換の正規化なし）。
        project.allowedModels = [...new Set(patch.allowedModels.map(m => boundedText(m, 200, 'モデル名')))];
      }
      if (patch.budgetUsd !== undefined) project.budgetUsd = patch.budgetUsd === null ? undefined : nonNegative(patch.budgetUsd, 'budgetUsd');
      if (patch.requestLimit !== undefined) {
        if (patch.requestLimit === null) project.requestLimit = undefined;
        else {
          const { maxRequests, windowMs } = patch.requestLimit;
          if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000000 || !Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 31 * 86400000) fail(400, 'invalid_input', '要求数と期間は許容範囲内の整数で指定してください。');
          project.requestLimit = { maxRequests, windowMs };
        }
      }
      if (patch.pricing !== undefined) {
        if (patch.pricing === null) project.pricing = {};
        else {
          const next: Record<string, PricingRecord> = Object.create(null);
          for (const [model, price] of Object.entries(patch.pricing)) {
            const name = boundedText(model, 200, 'モデル名');
            if (!price || typeof price !== 'object') fail(400, 'invalid_input', `モデル ${name} の価格設定が不正です。`);
            next[name] = { inputUsdPerMTok: nonNegative(price.inputUsdPerMTok, `${name} inputUsdPerMTok`), outputUsdPerMTok: nonNegative(price.outputUsdPerMTok, `${name} outputUsdPerMTok`) };
          }
          project.pricing = next;
        }
      }
      // 予算を有効化した瞬間に、許可済みモデルの価格が欠けていると予約が必ず 409 になります。設定時点で気付けるよう警告は監査に残します（作成は拒否しません: 価格追加で解消できるため）。
      this.audit(state, actor, 'project_update', projectId, { allowedModelsCount: project.allowedModels.length, budgetUsd: project.budgetUsd ?? null, maxRequests: project.requestLimit?.maxRequests ?? null, pricedModels: Object.keys(project.pricing).length });
      return project;
    });
  }

  /* ===== 仮想キー（Virtual Key） ===== */
  /** 仮想キーを発行します。原文は戻り値だけ返し、保存は SHA-256 ハッシュのみ（発行時にしか原文は出ません）。 */
  issueKey(projectId: string, label: string, actor: Actor): Promise<{ key: string; keyId: string; prefix: string }> {
    return this.mutate(state => {
      const project = this.requireProjectAdmin(state, actor, projectId);
      if (project.keys.filter(k => !k.revokedAt).length >= 50) fail(409, 'key_limit', '有効な仮想キーは50件までです。先に失効させてください。');
      const secret = randomBytes(32).toString('base64url');
      const plaintext = `wtvk_${secret}`;
      const key: KeyRecord = { id: `k-${randomUUID().slice(0, 8)}`, projectId: project.id, label: boundedText(label, 80, 'キー名'), hash: sha256(plaintext), prefix: `wtvk_${secret.slice(0, 8)}`, createdAt: new Date(this.now()).toISOString() };
      project.keys.push(key);
      this.audit(state, actor, 'key_issue', projectId, { keyId: key.id, keyPrefix: key.prefix });
      return { key: plaintext, keyId: key.id, prefix: key.prefix };
    });
  }

  /** 仮想キーを失効（Revoke）します。以降の認証は全て拒否されます。 */
  revokeKey(projectId: string, keyId: string, actor: Actor): Promise<KeyRecord> {
    return this.mutate(state => {
      const project = this.requireProjectAdmin(state, actor, projectId);
      const key = project.keys.find(k => k.id === keyId);
      if (!key) fail(404, 'key_not_found', 'キーが見つかりません。');
      if (!key!.revokedAt) key!.revokedAt = new Date(this.now()).toISOString();
      this.audit(state, actor, 'key_revoke', projectId, { keyId: key!.id, keyPrefix: key!.prefix });
      return key!;
    });
  }

  /** 仮想キー原文を認証し、所属プロジェクトを返します。成否だけを見せ、他情報は漏らしません。 */
  authenticateKey(plaintext: string): Promise<{ projectId: string; keyId: string }> {
    return this.mutate(state => {
      const hash = sha256(String(plaintext || ''));
      for (const project of state.projects) {
        const key = project.keys.find(k => k.hash === hash);
        if (!key) continue;
        if (key.revokedAt) fail(401, 'key_revoked', 'このキーは失効済みです。');
        key.lastUsedAt = new Date(this.now()).toISOString();
        return { projectId: project.id, keyId: key.id };
      }
      fail(401, 'invalid_key', '仮想キーが不正です。');
    });
  }

  /* ===== 予算予約（Budget Reservation）と利用枠（Usage Quota） ===== */
  /** モデル別の見積費用。価格が無い場合、予算有効なら 409（拒否）、予算無しなら undefined（不明）でゼロにしません。 */
  private estimateUsd(project: ProjectRecord, model: string, inputTokens: number, outputTokens: number): number | undefined {
    const price = Object.hasOwn(project.pricing, model) ? project.pricing[model] : undefined;
    if (!price) {
      if (project.budgetUsd !== undefined) fail(409, 'model_price_required', `モデル ${model} の明示価格が未設定のため予算管理できません。価格設定をするか、予算を外してください。`);
      return undefined;
    }
    return (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) / 1_000_000;
  }
  /** モデル許可（完全一致）→回数枠→予算の順で判定し、予約を作ります。 */
  reserve(actor: Actor, input: { projectId?: string; model: string; estInputTokens?: number; estOutputTokens?: number }): Promise<{ reservationId: string; estimatedUsd: number | undefined; budgetUsd: number | undefined }> {
    return this.mutate(state => {
      const requestedProject=actor.kind==='key'?actor.projectId:input.projectId;
      if(!requestedProject)fail(400,'project_required','利用するプロジェクトを指定してください。');
      const project = this.requireProjectMember(state, actor, requestedProject!);
      const model = String(input.model ?? '');
      // authoritative model exact match: 完全一致しれば即拒否。前方一致・大小無視はしません。
      if (!project.allowedModels.includes(model)) fail(403, 'model_not_allowed', 'そのモデルはこのプロジェクトで許可されていません。');
      const estInput = nonNegative(input.estInputTokens ?? 0, 'estInputTokens');
      const estOutput = nonNegative(input.estOutputTokens ?? 0, 'estOutputTokens');
      // 回数枠: 窓内の予約受付回数で判定します（取消も受付事実として数えます）。
      if (project.requestLimit) {
        const cutoff = new Date(this.now() - project.requestLimit.windowMs).toISOString();
        project.requestLog = project.requestLog.filter(t => t > cutoff);
        if (project.requestLog.length >= project.requestLimit.maxRequests) fail(429, 'request_limit_exceeded', '利用枠（回数）を消化済みです。窓の再開まで待ってください。');
      }
      const estimated = this.estimateUsd(project, model, estInput, estOutput);
      if (project.budgetUsd !== undefined && estimated !== undefined) {
        // 予約は確定費用と他の有効予約を合わせた「保持額」を見て判定するため、並行要求でも予算を超過できません。
        const held = project.spendUsd + this.heldUsd(project);
        if (held + estimated > project.budgetUsd) fail(429, 'budget_exceeded', `予算上限を超えます。保持済み ${held.toFixed(6)} + 今回 ${estimated.toFixed(6)} > 予算 ${project.budgetUsd.toFixed(6)} USD。`);
      }
      // 未確定予約は保持し、保持額を消して予算をすり抜けさせない。
      this.pruneReservations(project);
      if (project.reservations.filter(r => r.state === 'reserved').length >= 2000) fail(429, 'too_many_reservations', '同時予約の上限に達しています。');
      project.reservations = [...project.reservations.filter(r => r.state !== 'reserved').slice(-1000), ...project.reservations.filter(r => r.state === 'reserved')];
      const reservation: ReservationRecord = { id: `r-${randomUUID()}`, projectId: project.id, model, estimatedUsd: estimated ?? 0, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + this.reservationTtlMs).toISOString(), state: 'reserved', costKnown: estimated !== undefined, pricingSnapshot: Object.hasOwn(project.pricing, model) ? { ...project.pricing[model] } : undefined };
      project.reservations.push(reservation);
      if (project.requestLimit) project.requestLog.push(reservation.createdAt);
      this.audit(state, actor, 'usage_reserve', project.id, { reservationId: reservation.id, keyId: actor.kind==='key'?actor.keyId:null, model, estimatedUsd: estimated ?? null, costKnown: reservation.costKnown });
      return { reservationId: reservation.id, estimatedUsd: estimated, budgetUsd: project.budgetUsd };
    });
  }

  /** 予約を確定（Commit）します。実トークン数があれば明示価格で再計算し、価格不明時は費用不明のまま確定します。 */
  commitReservation(reservationId: string, input: { inputTokens?: number; outputTokens?: number }, actor: Actor): Promise<{ reservationId: string; committedUsd: number | undefined }> {
    return this.mutate(state => {
      const project = this.requireProjectMember(state, actor, this.findReservationProject(state, reservationId));
      const reservation = project.reservations.find(r => r.id === reservationId)!;
      this.pruneReservations(project);
      if (reservation.state !== 'reserved') fail(409, 'reservation_not_open', `この予約は確定済み・取消済み・期限切れです（state=${reservation.state}）。`);
      let committed: number | undefined;
      if (reservation.costKnown) {
        const price = reservation.pricingSnapshot ?? project.pricing[reservation.model];
        const inTok = nonNegative(input.inputTokens ?? 0, 'inputTokens');
        const outTok = nonNegative(input.outputTokens ?? 0, 'outputTokens');
        committed = price ? (inTok * price.inputUsdPerMTok + outTok * price.outputUsdPerMTok) / 1_000_000 : reservation.estimatedUsd;
        project.spendUsd += committed;
      }
      // reservation.costKnown === false（予算無しプロジェクト）は費用を 0 と記録せず、spendUsd を動かしません。
      reservation.state = 'committed';
      if (committed !== undefined) reservation.committedUsd = committed;
      this.audit(state, actor, 'usage_commit', project.id, { reservationId, model: reservation.model, committedUsd: committed ?? null, costKnown: reservation.costKnown });
      return { reservationId, committedUsd: committed };
    });
  }

  /** 予約を取り消し（Cancel）、予算の保持額を解放します。 */
  cancelReservation(reservationId: string, actor: Actor): Promise<{ reservationId: string; status: 'cancelled' }> {
    return this.mutate(state => {
      const project = this.requireProjectMember(state, actor, this.findReservationProject(state, reservationId));
      this.pruneReservations(project);
      const reservation = project.reservations.find(r => r.id === reservationId)!;
      if (reservation.state !== 'reserved') fail(409, 'reservation_not_open', `この予約は取消できません（state=${reservation.state}）。`);
      reservation.state = 'cancelled';
      this.audit(state, actor, 'usage_cancel', project.id, { reservationId, releasedUsd: reservation.estimatedUsd, model: reservation.model });
      return { reservationId, status: 'cancelled' as const };
    });
  }

  /** 予約 ID から所属プロジェクトを解決します。存在しない ID は 404 にします。 */
  private findReservationProject(state: TeamAccessState, reservationId: string): string {
    for (const project of state.projects) if (project.reservations.some(r => r.id === reservationId)) return project.id;
    fail(404, 'reservation_not_found', '予約が見つかりません。');
  }

  /* ===== 参照（Read） ===== */
  /** プロジェクトの利用状況。本人（メンバー）か platformAdmin / 自プロジェクトのキーだけです。 */
  projectUsage(projectId: string, actor: Actor): Promise<{ project: { id: string; name: string; allowedModels: string[]; budgetUsd?: number; spendUsd: number; heldUsd: number; requestLimit?: { maxRequests: number; windowMs: number }; requestsInWindow: number; canManage: boolean; members: Record<string, TeamRole> }; keys: Array<{ id: string; label: string; prefix: string; createdAt: string; revokedAt?: string; lastUsedAt?: string }>; reservations: ReservationRecord[] }> {
    return this.mutate(state => {
      const project = this.requireProjectMember(state, actor, projectId);
      this.pruneReservations(project);
      const windowCutoff = project.requestLimit ? new Date(this.now() - project.requestLimit.windowMs).toISOString() : '';
      return {
        project: { id: project.id, name: project.name, allowedModels: [...project.allowedModels], budgetUsd: project.budgetUsd, spendUsd: project.spendUsd, heldUsd: this.heldUsd(project), requestLimit: project.requestLimit, requestsInWindow: project.requestLimit ? project.requestLog.filter(t => t > windowCutoff).length : project.requestLog.length, canManage: actor.kind === 'user' && (this.requireUser(state, actor.userId).platformAdmin || project.members[actor.userId] === 'owner'), members: { ...project.members } },
        // 仮想キーは prefix（先頭のみ）だけ返し、ハッシュ・原文を出しません。
        keys: project.keys.map(k => ({ id: k.id, label: k.label, prefix: k.prefix, createdAt: k.createdAt, ...(k.revokedAt ? { revokedAt: k.revokedAt } : {}), ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}) })),
        reservations: project.reservations.filter(r => r.state === 'reserved').map(r => ({ ...r })),
      };
    });
  }

  /** 管理者向けの一覧。仮想キーは prefix だけを出します（ハッシュ・原文は不可視）。 */
  overview(): Promise<{ users: UserRecord[]; projects: Array<{ id: string; name: string; createdAt: string; members: Record<string, TeamRole>; allowedModels: string[]; budgetUsd?: number; spendUsd: number; heldUsd: number; pricing: Record<string, PricingRecord>; keys: Array<{ id: string; label: string; prefix: string; revokedAt?: string }> }>; audit: AuditRecord[] }> {
    return this.mutate(state => ({
      users: state.users.map(u => ({ ...u })),
      projects: state.projects.map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, members: { ...p.members }, allowedModels: [...p.allowedModels], budgetUsd: p.budgetUsd, spendUsd: p.spendUsd, heldUsd: this.heldUsd(p), pricing: JSON.parse(JSON.stringify(p.pricing)) as Record<string, PricingRecord>, keys: p.keys.map(k => ({ id: k.id, label: k.label, prefix: k.prefix, ...(k.revokedAt ? { revokedAt: k.revokedAt } : {}) })) })),
      audit: state.audit.slice(-50).map(a => ({ ...a })),
    }));
  }
}
