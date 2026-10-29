import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { atomicOrdinaryWrite, assertOrdinaryPath } from '../safe-file.js';
import type { StudyModule } from './service.js';

/** ユーザー名や外部入力をパスにせず、固定IDのハッシュで個別書斎を管理します。 */
export class PersonalStudies {
  private services = new Map<string, StudyModule>();
  private owners: Record<string, string> = {};
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private factory: ((workspace: string, owner?: string) => StudyModule) | undefined, readonly workspace: string) {}
  async load() {
    try {
      const value = JSON.parse(await readFile(this.ownerFile, 'utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('書房の所有者設定が不正です。');
      this.owners = value;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private get ownerFile() { return path.join(this.workspace, '.wentian', 'study-group-owners.json'); }
  forUser(id: string): StudyModule | undefined {
    if (!id || !this.factory) return undefined;
    const key = createHash('sha256').update(id).digest('hex');
    if (!this.services.has(key)) this.services.set(key, this.factory(this.workspace, key));
    return this.services.get(key);
  }
  async rootForUser(id: string) { return (await this.forUser(id)?.status())?.notebooks; }
  async bindGroup(groupId: string, ownerId: string) {
    const operation = this.writes.catch(() => undefined).then(async () => {
      if (Object.hasOwn(this.owners, groupId)) return;
      const next = { ...this.owners, [groupId]: ownerId };
      await atomicOrdinaryWrite(this.ownerFile, JSON.stringify(next)); this.owners = next;
    });
    this.writes = operation; await operation;
  }
  async rootForGroup(groupId?: string) { const owner = groupId && Object.hasOwn(this.owners, groupId) ? this.owners[groupId] : undefined; return owner ? this.rootForUser(owner) : undefined; }
  async importLegacy(id: string) {
    const source = (await this.factory?.(this.workspace).status())?.notebooks, destination = await this.rootForUser(id);
    if (!source || !destination || path.resolve(source) === path.resolve(destination)) throw new Error('書房の保存先を確認できません。');
    let copied = 0, skipped = 0, count = 0;
    const copy = async (relative: string) => {
      const current = path.join(source, relative); await assertOrdinaryPath(current);
      let entries; try { entries = await readdir(current, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        // 個人領域は旧共有データではないため、他人の書房を取り込みません。
        if (!relative && entry.name === 'users') continue;
        if (++count > 10000) throw new Error('取り込み対象が多すぎます。対象を分けてください。');
        const child = path.join(relative, entry.name), from = path.join(source, child), to = path.join(destination, child);
        await assertOrdinaryPath(from); await assertOrdinaryPath(to);
        if (entry.isDirectory()) await copy(child);
        else if (entry.isFile()) {
          await mkdir(path.dirname(to), { recursive: true });
          try { await copyFile(from, to, constants.COPYFILE_EXCL); copied++; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') skipped++; else throw error; }
        }
      }
    };
    await copy(''); return { copied, skipped };
  }
  async stopAll() { await Promise.allSettled([...this.services.values()].map(service => service.stop())); }
}
