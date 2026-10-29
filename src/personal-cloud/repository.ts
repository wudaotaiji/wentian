import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { emptyCloudState, type CloudState } from './types.js';

/** SQLiteの即時トランザクション（Immediate Transaction）で予約・ジョブ・監査を同時確定します。 */
export class CloudRepository {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    if(file!==':memory:')mkdirSync(path.dirname(path.resolve(file)),{recursive:true});
    this.db=new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS cloud_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);');
    this.db.prepare('INSERT OR IGNORE INTO cloud_state(id,value) VALUES(1,?)').run(JSON.stringify(emptyCloudState()));
  }
  read(): CloudState {return JSON.parse(String(this.db.prepare('SELECT value FROM cloud_state WHERE id=1').get()!.value));}
  transaction<T>(change:(state:CloudState)=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const state=this.read();const result=change(state);this.db.prepare('UPDATE cloud_state SET value=? WHERE id=1').run(JSON.stringify(state));this.db.exec('COMMIT');return result;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  /** SQLite自身のバックアップ（Backup）命令で一貫した退避コピーを作ります。 */
  backup(destination:string){this.db.prepare('VACUUM INTO ?').run(path.resolve(destination));}
  close(){this.db.close();}
}
