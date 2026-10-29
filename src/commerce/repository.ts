import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {emptyCommerce,type CommerceState} from './model.js';

/** 即時トランザクション（Immediate Transaction）で別プロセスからの在庫競合も直列化します。 */
export class CommerceRepository {
  private db:DatabaseSync;
  constructor(file:string){if(file!==':memory:')mkdirSync(path.dirname(path.resolve(file)),{recursive:true});this.db=new DatabaseSync(file);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS commerce_state(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);');this.db.prepare('INSERT OR IGNORE INTO commerce_state VALUES(1,?)').run(JSON.stringify(emptyCommerce()));}
  read():CommerceState{return {...emptyCommerce(),...JSON.parse(String(this.db.prepare('SELECT value FROM commerce_state WHERE id=1').get()!.value))}}
  transaction<T>(operation:(state:CommerceState)=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const state=this.read(),result=operation(state);if(result instanceof Promise)throw new Error('取引内では非同期処理を実行できません。');this.db.prepare('UPDATE commerce_state SET value=? WHERE id=1').run(JSON.stringify(state));this.db.exec('COMMIT');return structuredClone(result)}catch(error){this.db.exec('ROLLBACK');throw error}}
  backup(destination:string){mkdirSync(path.dirname(path.resolve(destination)),{recursive:true});this.db.prepare('VACUUM INTO ?').run(path.resolve(destination))}
  close(){this.db.close()}
}
