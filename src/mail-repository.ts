import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type MailEntity = Record<string, any> & {id:string; revision:number; updatedAt:string};
export const mailConflict = () => Object.assign(new Error('別の操作で更新されています。再読込してください。'), {statusCode:409});

/** メール業務を行単位で永続化し、レビューと送信キューを同じトランザクション（Transaction）で確定します。 */
export class MailRepository {
  readonly db:DatabaseSync;
  constructor(readonly file:string) {
    if(file!==':memory:')mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS mail_items(kind TEXT NOT NULL,id TEXT NOT NULL,identity TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(kind,id),UNIQUE(kind,identity));
      CREATE INDEX IF NOT EXISTS mail_items_updated ON mail_items(updated,kind,id);
      CREATE INDEX IF NOT EXISTS mail_items_source ON mail_items(kind,json_extract(value,'$.sourceId'));
      CREATE INDEX IF NOT EXISTS mail_items_status ON mail_items(kind,json_extract(value,'$.status'));
      CREATE TABLE IF NOT EXISTS mail_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mail_changes_item ON mail_changes(kind,id,sequence);
      CREATE TRIGGER IF NOT EXISTS mail_insert_change AFTER INSERT ON mail_items BEGIN INSERT INTO mail_changes(kind,id) VALUES(new.kind,new.id); END;
      CREATE TRIGGER IF NOT EXISTS mail_update_change AFTER UPDATE ON mail_items BEGIN INSERT INTO mail_changes(kind,id) VALUES(new.kind,new.id); END;
      INSERT INTO mail_changes(kind,id) SELECT kind,id FROM mail_items WHERE NOT EXISTS(SELECT 1 FROM mail_changes);`);
  }
  transaction<T>(action:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=action();if(result instanceof Promise)throw new Error('取引内で非同期処理は実行できません。');this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  get(kind:string,id:string):MailEntity|undefined {const row=this.db.prepare('SELECT value FROM mail_items WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(String(row.value)):undefined;}
  byIdentity(kind:string,identity:string):MailEntity|undefined {const row=this.db.prepare('SELECT value FROM mail_items WHERE kind=? AND identity=?').get(kind,identity);return row?JSON.parse(String(row.value)):undefined;}
  require(kind:string,id:string):MailEntity {const item=this.get(kind,id);if(!item)throw Object.assign(new Error('対象データが見つかりません。'),{statusCode:404});return item;}
  put(kind:string,value:Record<string,any>,identity?:string,expected?:number):MailEntity {
    const id=value.id||randomUUID(), current=this.get(kind,id);
    if(expected!==undefined&&(current?.revision??0)!==expected)throw mailConflict();
    const item={...value,id,revision:(current?.revision??0)+1,updatedAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO mail_items(kind,id,identity,value,revision,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value,revision=excluded.revision,updated=excluded.updated').run(kind,id,identity||id,JSON.stringify(item),item.revision,item.updatedAt);
    return item;
  }
  list(kind:string,limit=100,offset=0):MailEntity[] {return this.db.prepare('SELECT value FROM mail_items WHERE kind=? ORDER BY updated DESC,id DESC LIMIT ? OFFSET ?').all(kind,limit,offset).map(row=>JSON.parse(String(row.value)));}
  audit(actor:string,action:string,target:string,detail:unknown={}) {this.db.prepare('INSERT INTO mail_events(at,actor,action,target,detail) VALUES(?,?,?,?,?)').run(new Date().toISOString(),actor,action,target,JSON.stringify(detail));}
  events(){return this.db.prepare('SELECT * FROM mail_events ORDER BY id DESC LIMIT 100').all().map(row=>({...row,detail:JSON.parse(String(row.detail))}));}
  meta(key:string,fallback:any=null):any {const row=this.db.prepare('SELECT value FROM mail_meta WHERE key=?').get(key);return row?JSON.parse(String(row.value)):fallback;}
  setMeta(key:string,value:unknown){this.db.prepare('INSERT INTO mail_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  close(){this.db.close();}
}
