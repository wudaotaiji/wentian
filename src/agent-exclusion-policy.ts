import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renameWithRetry } from './atomic-file.js';

/**
 * 外部エージェントの「対象外」設定を保存する policies（方針）モジュールです。
 *
 * 目的: 制御盤（Control Center）の `#/agents` 明細行にある【対象外】ボタンで、
 * 特定のエージェントを外部Agent委任の指定対象から外します。
 *
 * 保存先は**このマシン（ユーザー）単位の設定目录**です。リポジトリ内の `.wentian/` には置しません。
 * 「どの外部エージェントを委任先から外すか」はGatewayを動かしている端末側の運用判断で、
 * 作業リポジトリやGit管理下のファイルに追従させるものではないためです。
 * 既定は `%LOCALAPPDATA%\wentian\agent-exclusions.json`（Linux/macOSは `~/.config/wentian/`）。
 * 環境変数 `WENTIAN_CONFIG_DIR` で目录そのものを、`WENTIAN_AGENT_EXCLUSIONS_FILE` でファイル1つ分を
 * 変更でき、いずれもGateway再起動・キャッシュ更新をまたいで効き続けます。
 *
 * 既存の `apiFallbackExcludedAgents`（設定ファイル側の除外）とは別物です。
 * あちらは設定ファイル編集が要る常設除外、こちらは運用中に画面から切り替えできる操作除外です。
 */

/** 保存する対象外設定の1件。`excluded` が真のときだけ意味を持ちます。 */
export interface AgentExclusion {
  id: string;
  excluded: boolean;
  /** 設定を変えた時刻（ISO文字列）。 */
  updatedAt: string;
  /** 操作者識別子（管理者セッション名など。無ければ unknown）。 */
  actor?: string;
  /** 操作者が入れた補足。表示専用で、判定には使いません。 */
  note?: string;
}

/** 保存ファイルの形: エージェントIDごとに1件。 */
export type AgentExclusionMap = Record<string, AgentExclusion>;

/** エージェントIDにだけ許す文字種（コマンド注入・パス脱出を防ぐ既存と同じ制限）。 */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{1,39}$/;

/**
 * Gateway本机設定（ユーザー単位の設定目录）を返します。
 * 作業ディレクトリ＝リポジトリに依存しない場所を選ぶことで、
 * Git管理下のファイルやリポジトリ単位の `.wentian/` とは独立して効かせます。
 * ①`WENTIAN_CONFIG_DIR`、②Windowsは `%LOCALAPPDATA%\wentian`（無ければ `%APPDATA%`、最後はホーム）、
 * ③Linux/macOSは `$XDG_CONFIG_HOME/wentian`（無ければ `~/.config/wentian`）の順で決めます。
 */
export function machineConfigDirectory(): string {
  if (process.env.WENTIAN_CONFIG_DIR) return path.resolve(process.env.WENTIAN_CONFIG_DIR);
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
    return path.join(root, 'wentian');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'wentian');
}

/** 保存先の絶対パス。既定は本機設定目录内の `agent-exclusions.json`（リポジトリ外）。 */
export function agentExclusionStorePath(): string {
  return process.env.WENTIAN_AGENT_EXCLUSIONS_FILE || path.join(machineConfigDirectory(), 'agent-exclusions.json');
}

/** 入力を検証して保存用の1件へ正規化します。不正IDはここで投げます。 */
export function validateAgentExclusion(input: unknown): AgentExclusion {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const id = String(value.id || '').trim().toLowerCase();
  if (!AGENT_ID.test(id)) throw new Error('対象外設定のIDは2～40文字の英小文字・数字・ハイフン・アンダースコアで指定してください。');
  const excluded = value.excluded === true;
  const actor = String(value.actor || '').trim().slice(0, 80) || undefined;
  const note = String(value.note || '').trim().slice(0, 240) || undefined;
  const parsed = Date.parse(String(value.updatedAt || ''));
  return { id, excluded, updatedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString(), actor, note };
}

/**
 * 保存済みの対象外設定を同期読み込みします。
 * 選択処理（同期関数）から呼ぶため、ここだけ同期I/Oを許可します。
 * 未作成・破損は「対象外なし」として扱い、外部Agent実行を止めません。
 */
export function readAgentExclusionsSync(): AgentExclusionMap {
  try {
    const parsed = JSON.parse(readFileSync(agentExclusionStorePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: AgentExclusionMap = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      try {
        const item = validateAgentExclusion({ ...(raw && typeof raw === 'object' ? raw : {}), id: key });
        if (item.excluded) out[item.id] = item;
      } catch { /* 不正IDの残骸は無視して読み進めます。 */ }
    }
    return out;
  } catch { return {}; }
}

/** 非同期版（書込み側・テスト用）。 */
export async function readAgentExclusions(): Promise<AgentExclusionMap> {
  try {
    const parsed = JSON.parse(await readFile(agentExclusionStorePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: AgentExclusionMap = {};
    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      try {
        const item = validateAgentExclusion({ ...(raw && typeof raw === 'object' ? raw : {}), id: key });
        if (item.excluded) out[item.id] = item;
      } catch { /* 不正IDの残骸は無視します。 */ }
    }
    return out;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

/** 対象外かどうか（保存値のみの判定）。 */
export function isAgentExcluded(id: string): boolean {
  return Boolean(readAgentExclusionsSync()[String(id || '').trim().toLowerCase()]);
}

/**
 * 判定ゲート共通版。表示用スナップショットの `excluded` と保存値の両方を見て、
 * どちらか一方でも対象外なら false（指定対象にしない）を返します。
 * 各選択処理はこれを1行足すだけで、既存の健康判定は変更しません。
 */
export function agentNotExcluded(agent: { id: string; excluded?: boolean } | undefined): boolean {
  if (!agent) return false;
  if (!agentRegistered(agent.id)) return false;
  if (agent.excluded === true) return false;
  return !isAgentExcluded(agent.id);
}

/** 明示指定されたIDが対象外かどうか（グループ参加者の `external/<id>` 指定など）。 */
export function explicitAgentAllowed(id: string): boolean {
  return agentRegistered(id) && !isAgentExcluded(id);
}

/** 一覧への登録解除は、使用禁止と別のユーザー設定として保存します。 */
export function agentRegistrationStorePath(): string {
  return process.env.WENTIAN_AGENT_REGISTRATIONS_FILE || path.join(machineConfigDirectory(), 'agent-registrations.json');
}

/** 明示設定がない既存エージェントは登録済みとして扱い、導入済み環境を維持します。 */
export function agentRegistered(id: string, defaultRegistered = true): boolean {
  try {
    const values = JSON.parse(readFileSync(agentRegistrationStorePath(), 'utf8')) as Record<string, boolean>;
    return typeof values[id] === 'boolean' ? values[id] : defaultRegistered;
  } catch (error: any) {
    // 設定破損は登録済みへ戻して起動せず、安全側へ停止します。
    return error?.code === 'ENOENT' ? defaultRegistered : false;
  }
}

/** 登録解除はメタデータやCLI本体を削除せず、後から追加で復帰できます。 */
export async function setAgentRegistration(id: string, registered: boolean): Promise<void> {
  validateAgentExclusion({ id, excluded: false });
  const target = agentRegistrationStorePath();
  let current: Record<string, boolean> = {};
  try { current = JSON.parse(await readFile(target, 'utf8')); }
  catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...current, [id]: registered }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, target);
}

/**
 * 対象外設定を保存します（`excluded: false` で解除＝指定対象へ復帰）。
 * 一時ファイルからの置換で、途中書き込みにより台帳を壊しません。
 */
export async function setAgentExclusion(id: string, excluded: boolean, actor?: string, note?: string): Promise<AgentExclusion> {
  const item = validateAgentExclusion({ id, excluded, actor, note, updatedAt: new Date().toISOString() });
  const current = await readAgentExclusions();
  const next: AgentExclusionMap = { ...current };
  if (item.excluded) next[item.id] = item;
  else delete next[item.id];
  const target = agentExclusionStorePath();
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  const ordered: AgentExclusionMap = {};
  for (const key of Object.keys(next).sort((a, b) => a.localeCompare(b))) ordered[key] = next[key]!;
  await writeFile(temporary, `${JSON.stringify(ordered, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await renameWithRetry(temporary, target);
  return item;
}
