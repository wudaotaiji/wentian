import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type SkillLanguage = 'ja' | 'en' | 'zh';
export interface SkillDisplay { title: string; description: string; content: string; }
export interface Skill { name: string; description: string; source: string; sha256: string; localizations?: Partial<Record<SkillLanguage, Omit<SkillDisplay, 'content'>>>; }
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills');

/** 表示用の明示的な翻訳だけを読みます。エージェントへ渡す原本とハッシュは変更しません。 */
async function readSkillDisplay(source: string): Promise<Partial<Record<SkillLanguage, SkillDisplay>>> {
  try {
    const root = await realpath(path.dirname(source));
    const file = await realpath(path.join(root, 'display.json'));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || (await stat(file)).size > 64 * 1024) return {};
    const data = JSON.parse(await readFile(file, 'utf8'));
    const result: Partial<Record<SkillLanguage, SkillDisplay>> = {};
    for (const language of ['ja', 'en', 'zh'] as const) {
      const row = data?.[language];
      if (!row || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200 || typeof row.description !== 'string' || !row.description.trim() || row.description.length > 1024 || typeof row.content !== 'string' || !row.content.trim() || row.content.length > 16 * 1024) continue;
      result[language] = { title: row.title, description: row.description, content: row.content };
    }
    return result;
  } catch { return {}; /* 翻訳が未提供・不正でも原本の利用は妨げません。 */ }
}

/** 小さな共通フロントマターだけを解釈し、任意のYAMLオブジェクトは実行しません。 */
export function parseSkill(text: string, source: string): Skill {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md に name と description が必要です。');
  const field = (key: string) => {
    const value = match[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() || '';
    return value.replace(/^(['"])(.*)\1$/, '$2');
  };
  const name = field('name'), description = field('description');
  if (!namePattern.test(name) || name.length > 64 || !description || description.length > 1024 || ['|', '>'].includes(description)) throw new Error('Skill の名前または説明が不正です。説明は1行で指定してください。');
  return { name, description, source, sha256: createHash('sha256').update(text).digest('hex') };
}

/** パスを実体化し、シンボリックリンクを含むディレクトリ外参照を拒否します。 */
async function readSkill(root: string, directory: string): Promise<{ skill: Skill; content: string }> {
  const base = await realpath(root), source = await realpath(path.join(root, directory, 'SKILL.md'));
  const relative = path.relative(base, source);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Skill の参照先が登録ディレクトリ外です。');
  if ((await stat(source)).size > 64 * 1024) throw new Error('Skill は64KiB以内で指定してください。');
  const content = await readFile(source, 'utf8'), skill = parseSkill(content, source);
  if (skill.name !== directory) throw new Error('Skill 名とディレクトリ名が一致しません。');
  return { skill, content };
}

/** プロジェクト→ユーザー→同梱の優先順で発見し、重複名は先に見つかった定義を使います。 */
export async function listSkills(workspace = process.cwd(), home = os.homedir()): Promise<Skill[]> {
  const roots = [path.join(workspace, '.wentian/skills'), path.join(workspace, '.agents/skills'), path.join(home, '.wentian/skills'), bundled];
  const found = new Map<string, Skill>();
  for (const root of roots) {
    const names = await readdir(root).catch(() => [] as string[]);
    for (const name of names.sort().slice(0, 100)) {
      if (!namePattern.test(name) || found.has(name)) continue;
      try {
        const { skill } = await readSkill(root, name);
        const display = await readSkillDisplay(skill.source);
        const localizations = Object.fromEntries(Object.entries(display).map(([language, row]) => [language, { title: row.title, description: row.description }]));
        found.set(name, Object.keys(localizations).length ? { ...skill, localizations } : skill);
      } catch { /* 不正な定義で一覧全体を止めません。 */ }
    }
  }
  return [...found.values()];
}

/** 発見済みの名前からだけ本文を読みます。モデルから任意パスは受け取りません。 */
export async function loadSkill(name: string, workspace = process.cwd(), home = os.homedir()): Promise<string> {
  const entry = (await listSkills(workspace, home)).find(skill => skill.name === name);
  if (!entry) throw new Error(`Skill が見つかりません: ${name}`);
  return (await readSkill(path.dirname(path.dirname(entry.source)), name)).content;
}

/** 同名のプロジェクト定義にも、その定義自身の翻訳だけを使います。 */
export async function loadSkillPresentation(name: string, workspace = process.cwd(), home = os.homedir()) {
  const entry = (await listSkills(workspace, home)).find(skill => skill.name === name);
  if (!entry) throw new Error(`Skill が見つかりません: ${name}`);
  const { content } = await readSkill(path.dirname(path.dirname(entry.source)), name);
  return { content, localizations: await readSkillDisplay(entry.source) };
}

/** 利用者が指定した単一SKILL.mdをコピーします。コード実行・既存ファイル上書きは行いません。 */
export async function installSkill(source: string, workspace = process.cwd()): Promise<Skill> {
  if ((await stat(source)).size > 64 * 1024) throw new Error('Skill は64KiB以内で指定してください。');
  const content = await readFile(source, 'utf8'), entry = parseSkill(content, source);
  const target = path.join(workspace, '.wentian/skills', entry.name);
  const base = await realpath(workspace);
  // 既存の親リンクを作成前に調べ、リンク先へのディレクトリ作成も防ぎます。
  for (const directory of [path.join(workspace, '.wentian'), path.dirname(target), target]) {
    let existing: string;
    try { existing = await realpath(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const relative = path.relative(base, existing);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Skill 保存先がワークスペース外です。');
  }
  await mkdir(target, { recursive: true });
  const destination = await realpath(target);
  const relative = path.relative(base, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Skill 保存先がワークスペース外です。');
  await writeFile(path.join(target, 'SKILL.md'), content, { encoding: 'utf8', flag: 'wx' });
  return { ...entry, source: path.join(target, 'SKILL.md') };
}

export async function skillCatalogPrompt(workspace = process.cwd()): Promise<string> {
  const skills = await listSkills(workspace);
  return skills.length ? '\n利用可能なSkill（必要なものだけ load_skill で読み込んでください）:\n' + skills.map(s => `${s.name}: ${s.description}`).join('\n') : '';
}

export const skillRegistry = { list: listSkills, load: loadSkill, install: installSkill };
