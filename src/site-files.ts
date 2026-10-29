import { randomUUID, createHash } from 'node:crypto';
import { lstat, realpath, readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** 指定されたApache等のフォルダーだけを編集対象にし、接続を30分で失効させます。 */
export class SiteFiles {
  private connections = new Map<string, {root:string; expires:number}>();
  private saving = new Set<string>();
  constructor(private workspace:string) {}
  private async ordinary(target:string) {
    let current = path.parse(target).root;
    for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('リンク先のフォルダー・ファイルは編集できません。');
    }
    return realpath(target);
  }
  async connect(directory:unknown) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('サイトの絶対フォルダーパスを入力してください。');
    const root = await this.ordinary(path.resolve(directory));
    if (!(await lstat(root)).isDirectory()) throw new Error('サイトのフォルダーを指定してください。');
    for (const [id, value] of this.connections) if(value.expires < Date.now()) this.connections.delete(id);
    if(this.connections.size >= 30) throw new Error('接続数が多すぎます。30分後に再接続してください。');
    const id = randomUUID(); this.connections.set(id,{root,expires:Date.now()+30*60*1000});
    return {id,root,files:await this.list(id)};
  }
  private root(id:string) {
    const connection = this.connections.get(id);
    if (!connection || connection.expires < Date.now()) throw new Error('フォルダー接続が失効しました。再読込してください。');
    return connection.root;
  }
  private async file(id:string, name:unknown) {
    if(typeof name !== 'string' || !name || path.isAbsolute(name) || name.split(/[\\/]/).some(p=>!p || p==='..' || p.startsWith('.')) || !/\.(html?|css|js|json|txt|md|svg|php)$/i.test(name)) throw new Error('編集可能なサイトの相対ファイル名を指定してください。');
    const root = this.root(id), target = path.resolve(root,name);
    if(!target.startsWith(root+path.sep)) throw new Error('サイトの外にはアクセスできません。');
    const resolved = await this.ordinary(target), info=await lstat(resolved);
    if(!info.isFile() || info.nlink > 1 || info.size > 512*1024) throw new Error('通常のファイル（512 KiB以下）だけを編集できます。');
    return resolved;
  }
  async list(id:string) {
    const root=this.root(id), files:string[]=[];
    const walk=async(directory:string,depth:number)=>{
      if(depth>5 || files.length>=500) return;
      await this.ordinary(directory);
      for(const entry of await readdir(directory,{withFileTypes:true})) {
        if(entry.name.startsWith('.') || entry.isSymbolicLink() || ['node_modules','vendor'].includes(entry.name)) continue;
        const target=path.join(directory,entry.name);
        if(entry.isDirectory()) await walk(target,depth+1);
        else if(entry.isFile() && /\.(html?|css|js|json|txt|md|svg|php)$/i.test(entry.name)) files.push(path.relative(root,target).replaceAll('\\','/'));
        if(files.length>=500) break;
      }
    };await walk(root,0);return files.sort();
  }
  async read(id:string,name:unknown) {
    const target=await this.file(id,name), bytes=await readFile(target);
    let content:string;
    try {content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
    catch {throw new Error('UTF-8以外の文字コードは直接編集できません。UTF-8へ変換したコピーを指定してください。');}
    return {name,content,version:createHash('sha256').update(bytes).digest('hex')};
  }
  async save(id:string,name:unknown,content:unknown,version:unknown) {
    if(typeof content!=='string' || Buffer.byteLength(content)>512*1024) throw new Error('ファイル本文は512 KiB以内です。');
    const target=await this.file(id,name);
    if(this.saving.has(target))throw new Error('このファイルを保存中です。完了後に再読込してください。');
    this.saving.add(target);
    try {
    const previous=await readFile(target);
    if(createHash('sha256').update(previous).digest('hex')!==version) throw new Error('ファイルが外部で変更されました。再読込してください。');
    // 原本をバックアップ（Backup）してから保存し、他の素材やサーバー設定は変更しません。
    const backup=path.join(this.workspace,'.wentian','site-file-backups',randomUUID());await mkdir(backup,{recursive:true});
    await this.ordinary(backup);
    await writeFile(path.join(backup,path.basename(target)),previous,{flag:'wx'});
    await writeFile(path.join(backup,'origin.json'),JSON.stringify({path:target,at:new Date().toISOString()}),{flag:'wx'});
    await writeFile(target,content,'utf8');
    return {...await this.read(id,name),backup};
    } finally {this.saving.delete(target);}
  }
}

/** 不要な管理サイトを非公開にし、復元用にゴミ箱（Trash）へ移動します。外部サイトは削除しません。 */
export async function trashSite(workspace:string,page:unknown) {
  if(typeof page!=='string' || (page && !/^[a-z0-9][a-z0-9-]{0,59}$/.test(page))) throw new Error('サイト名が不正です。');
  const root=path.join(path.resolve(workspace),'.wentian');
  const targets=[path.join(root,page?'site-pages/'+page+'.json':'public-site.json'),path.join(root,'sites',...(page?['pages',page]:['home']))];
  const existing:string[]=[];
  for(const target of targets) {
    let current=path.parse(target).root, missing=false;
    for(const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current=path.join(current,segment);
      try {if((await lstat(current)).isSymbolicLink()) throw new Error('リンクされたサイトは削除できません。');}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){missing=true;break;}throw error;}
    }
    if(!missing) existing.push(target);
  }
  if(!existing.length) throw new Error('保存済みのサイトがありません。');
  const title=existing.includes(targets[0])?JSON.parse(await readFile(targets[0],'utf8')).title:page;
  const trash=path.join(root,'site-trash',randomUUID());await mkdir(trash,{recursive:true});
  for(const directory of [root,path.join(root,'site-trash'),trash]) if((await lstat(directory)).isSymbolicLink())throw new Error('ゴミ箱には通常のフォルダーを指定してください。');
  for(const [index,target] of existing.entries()) await rename(target,path.join(trash,`${index}-${path.basename(target)}`));
  await writeFile(path.join(trash,'manifest.json'),JSON.stringify({page,title,originalPaths:existing,at:new Date().toISOString()},null,2));
  if(!page)await writeFile(path.join(root,'home-closed.json'),'{}');
  return {trash,page};
}

/** ゴミ箱（Trash）の通常ディレクトリだけを許可し、外部パスやリンク経由の削除を拒否します。 */
async function trashRoot(workspace:string) {
  const root=path.join(path.resolve(workspace),'.wentian','site-trash');
  let current=path.parse(root).root;
  for(const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);
    if((await lstat(current)).isSymbolicLink())throw new Error('リンクされたゴミ箱は操作できません。');
  }
  return root;
}
/** 閉鎖済み一覧（Closed Site List）は実際の閉鎖記録から取得します。 */
export async function listTrashedSites(workspace:string) {
  let root:string;
  try{root=await trashRoot(workspace)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
  const result=[];
  for(const id of await readdir(root)) {
    if(!/^[0-9a-f-]{36}$/.test(id))continue;
    const directory=path.join(root,id),stat=await lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink())continue;
    const manifest=path.join(directory,'manifest.json');
    if((await lstat(manifest)).isSymbolicLink())throw new Error('リンクされた閉鎖記録は読めません。');
    const data=JSON.parse(await readFile(manifest,'utf8'));
    result.push({id,page:data.page,title:data.title,at:data.at});
  }
  return result;
}
/** 完全削除（Permanent Delete）は閉鎖IDを再確認し、その専用領域内だけを削除します。 */
export async function purgeTrashedSite(workspace:string,id:unknown,confirmation:unknown) {
  if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)||confirmation!==id)throw new Error('完全削除の対象確認が一致しません。');
  const root=await trashRoot(workspace),target=path.resolve(root,id);
  if(path.dirname(target)!==root)throw new Error('削除範囲が不正です。');
  if(!(await listTrashedSites(workspace)).some(item=>item.id===id))throw new Error('閉鎖済みサイトが存在しません。');
  // 子階層も走査し、リンク（Symbolic Link）を含む領域は削除せず停止します。
  async function check(directory:string):Promise<void>{for(const name of await readdir(directory)){const child=path.join(directory,name),stat=await lstat(child);if(stat.isSymbolicLink())throw new Error('リンクを含む保存領域は完全削除できません。');if(stat.isDirectory())await check(child)}}
  await check(target);await rm(target,{recursive:true});return {id,deleted:true};
}
