import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertOrdinaryPath } from './safe-file.js';
import { normalizedVector } from './knowledge-embeddings.js';

/** 派生索引を資料本文から分離し、バッチごとの更新を小さなSQLite書込みにします。 */
export class KnowledgeVectorCache {
  private constructor(private db:DatabaseSync){}
  static async open(root:string,project:string){const folder=path.join(root,'vector-index'),file=path.join(folder,project+'.sqlite');await assertOrdinaryPath(file);await mkdir(folder,{recursive:true,mode:0o700});const db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vectors (provider TEXT NOT NULL, chunk TEXT NOT NULL, signature TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(provider,chunk))');return new KnowledgeVectorCache(db)}
  get(provider:string,chunk:string,signature:string,dimensions:number):number[]|undefined{
    const row=this.db.prepare('SELECT dimensions,vector FROM vectors WHERE provider=? AND chunk=? AND signature=?').get(provider,chunk,signature);if(!row||row.dimensions!==dimensions)return undefined;const data=Buffer.from(row.vector as Uint8Array);if(data.length!==dimensions*4)return undefined;const values=[];for(let index=0;index<dimensions;index++)values.push(data.readFloatLE(index*4));try{return normalizedVector(values,dimensions)}catch{return undefined}
  }
  put(provider:string,rows:Array<{chunk:string;signature:string;vector:number[]}>){
    this.db.exec('BEGIN IMMEDIATE');try{const statement=this.db.prepare('INSERT INTO vectors(provider,chunk,signature,dimensions,vector) VALUES(?,?,?,?,?) ON CONFLICT(provider,chunk) DO UPDATE SET signature=excluded.signature,dimensions=excluded.dimensions,vector=excluded.vector');for(const row of rows){const values=normalizedVector(row.vector),data=Buffer.alloc(values.length*4);values.forEach((v,i)=>data.writeFloatLE(v,i*4));statement.run(provider,row.chunk,row.signature,values.length,data)}this.db.exec('COMMIT')}catch(error){this.db.exec('ROLLBACK');throw error}
  }
  validCount(provider:string,signatures:Map<string,string>){let count=0;for(const row of this.db.prepare('SELECT chunk,signature FROM vectors WHERE provider=?').all(provider))if(signatures.get(String(row.chunk))===row.signature)count++;return count}
  count(provider:string){return Number(this.db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE provider=?').get(provider)?.n||0)}
  prune(provider:string,valid:Map<string,string>){this.db.prepare('DELETE FROM vectors WHERE provider<>?').run(provider);const remove=this.db.prepare('DELETE FROM vectors WHERE provider=? AND chunk=?');for(const row of this.db.prepare('SELECT chunk,signature FROM vectors WHERE provider=?').all(provider))if(valid.get(String(row.chunk))!==row.signature)remove.run(provider,String(row.chunk))}
  close(){this.db.close()}
}
