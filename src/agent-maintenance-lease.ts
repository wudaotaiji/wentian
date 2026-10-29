import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** 生存中の別プロセスを、単なる時間切れで追い出しません。 */
function processAlive(pid: number): boolean {
  try {process.kill(pid,0);return true;}
  catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}

/**
 * 同じ設定を共有するサーバーの保守を、SQLiteの排他トランザクションで直列化します。
 * 設定更新から実応答・能力試験まで所有権を保持し、別サーバーの上書きを防ぎます。
 * 強制終了で残った所有権はPIDの生存を確認してから回収します。
 */
export function acquireAgentMaintenanceLease(filename: string): (()=>void)|undefined {
  mkdirSync(path.dirname(filename),{recursive:true});
  const db=new DatabaseSync(filename);
  const token=randomUUID();
  try{
    db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS maintenance_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    const owner=db.prepare('SELECT pid FROM maintenance_owner WHERE id=1').get() as {pid:number}|undefined;
    if(owner&&processAlive(owner.pid)){db.exec('ROLLBACK');return undefined;}
    db.prepare('INSERT INTO maintenance_owner(id,pid,token) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, token=excluded.token').run(process.pid,token);
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{/* 開始前の失敗では戻す変更がありません。 */}throw error;}
  finally{db.close();}
  return()=>{
    // 古い所有者の終了処理で、新しい所有者の記録を消さないようトークンを照合します。
    const release=new DatabaseSync(filename);
    try{release.exec('PRAGMA busy_timeout=1000');release.prepare('DELETE FROM maintenance_owner WHERE id=1 AND pid=? AND token=?').run(process.pid,token);}
    finally{release.close();}
  };
}
