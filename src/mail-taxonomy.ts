import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './atomic-file.js';

export type MailProfileKind = 'personnel' | 'project' | 'other';
export type MailCategory = { path: string[]; name: string; profileKind: MailProfileKind };
const initial: [string, string, MailProfileKind][] = [
  ['spam','迷惑メール','other'],
  ['normal/normal.project/normal.project.open','通常メール / 案件 / オープン系','project'],
  ['normal/normal.project/normal.project.mainframe','通常メール / 案件 / 汎用系','project'],
  ['normal/normal.project/normal.project.embedded','通常メール / 案件 / 組込み系','project'],
  ['normal/normal.personnel/normal.personnel.business_app','通常メール / 要員 / 業務アプリ','personnel'],
  ['normal/normal.personnel/normal.personnel.infrastructure','通常メール / 要員 / 基盤開発構築','personnel'],
  ['normal/normal.personnel/normal.personnel.embedded','通常メール / 要員 / 組込み開発','personnel'],
  ['normal/normal.admin/normal.admin.proposal_reply','通常メール / 営業事務 / 要員提案の返信','other'],
  ['normal/normal.admin/normal.admin.contract','通常メール / 営業事務 / 契約事務関連','other'],
  ['normal/normal.admin/normal.admin.appointment','通常メール / 営業事務 / アポ取り','other'],
  ['normal/normal.admin/normal.admin.inquiry','通常メール / 営業事務 / お問合せ','other'],
];
export const mailCategoryPaths = new Set(initial.map(([id]) => id));
const queues = new Map<string, Promise<unknown>>();

/** 自由な表示名と不変の分類IDを分け、改名後もメール・学習済みモデルを参照できます。 */
export class MailTaxonomyStore {
  constructor(readonly file: string) {}
  load(): {revision: number; categories: MailCategory[]} {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {revision:0, categories:initial.map(([id,name,profileKind]) => ({path:id.split('/'),name,profileKind}))};
    }
  }
  category(value: unknown): MailCategory {
    if (!Array.isArray(value) || !value.every(part => typeof part === 'string')) throw new Error('分類を指定してください。');
    const item = this.load().categories.find(item => item.path.join('/') === value.join('/'));
    if (!item) throw new Error('分類マスターに存在しない分類です。先に分類を追加してください。');
    return item;
  }
  async save(input: {revision: number; name: string; profileKind: MailProfileKind; path?: string[]}): Promise<MailCategory> {
    // 同じ保存先への更新を直列化し、世代番号で別画面からの上書きも防ぎます。
    const previous = queues.get(this.file) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const state = this.load();
      if (input.revision !== state.revision) throw Object.assign(new Error('分類が別の画面で更新されています。再読込してください。'), {statusCode:409});
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200 || /[\x00-\x1f]/.test(input.name)) throw new Error('分類名は1〜200文字で入力してください。');
      if (!['personnel','project','other'].includes(input.profileKind)) throw new Error('分類の抽出対象を選択してください。');
      const current = input.path === undefined ? undefined : this.category(input.path);
      if (current && current.profileKind !== input.profileKind) throw new Error('既存分類の抽出対象は変更できません。別の対象では新しい分類を追加してください。');
      const name = input.name.trim();
      if (state.categories.some(item => item.name === name && item.path.join('/') !== current?.path.join('/'))) throw new Error('同じ分類名が既にあります。既存の分類を選択してください。');
      if (!current && state.categories.length >= 300) throw new Error('分類数の上限は300件です。');
      const branch = input.profileKind === 'other' ? 'admin' : input.profileKind;
      const item: MailCategory = {path:current?.path || ['normal', 'normal.'+branch, 'normal.'+branch+'.custom-'+randomUUID()],name,profileKind:input.profileKind};
      const categories = current ? state.categories.map(existing => existing.path.join('/') === current.path.join('/') ? item : existing) : [...state.categories,item];
      await mkdir(path.dirname(this.file), {recursive:true});
      const temporary = this.file+'.'+randomUUID()+'.tmp';
      await writeFile(temporary, JSON.stringify({revision:state.revision+1,categories},null,2), {mode:0o600});
      await renameWithRetry(temporary,this.file);
      return item;
    });
    queues.set(this.file,pending);
    try { return await pending; } finally { if (queues.get(this.file) === pending) queues.delete(this.file); }
  }
}
