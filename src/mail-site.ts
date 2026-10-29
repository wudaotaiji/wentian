import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PublicSiteStore, defaultPublicSite } from './public-site.js';
import { mailSolutionsHtml } from './mail-solutions.js';

/** メール画面を既存のサイト管理へ一度だけ登録します。閉鎖・完全削除後は再登録しません。 */
export async function provisionMailSite(workspace: string): Promise<void> {
  const root = path.join(path.resolve(workspace), '.wentian');
  const marker = path.join(root, 'site-builtins', 'mail-solutions.json');
  try { await readFile(marker); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const store = new PublicSiteStore(workspace, 'mail-solutions');
  // 同じURLに既存の保存データがあれば、内容を上書きせず管理対象として引き継ぎます。
  if (!(await store.pages()).some(page => page.slug === 'mail-solutions')) {
    await store.save({...structuredClone(defaultPublicSite), title:'Wentian Mail Solutions', headline:'Wentian Mail Solutions', showRooms:false, sections:[], mailDocument:mailSolutionsHtml});
  }
  // この記録はサイトの保存領域と分離し、ゴミ箱の完全削除後も再作成を防ぎます。
  await mkdir(path.dirname(marker), {recursive:true});
  await writeFile(marker, JSON.stringify({installedAt:new Date().toISOString()}), {flag:'wx'}).catch(error => {if(error.code !== 'EEXIST') throw error;});
}
