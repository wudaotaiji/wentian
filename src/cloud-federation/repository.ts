import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { FederationError, type FederationState } from './contracts.js';
import type { StoredIdentity } from './identity.js';

/** ノード固有の台帳です。共有中央DBを使わず、予約と再送記録を即時トランザクションで保存します。 */
export class FederationRepository {
  private readonly db: DatabaseSync;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    const file = path.join(directory, 'federation.sqlite');
    this.db = new DatabaseSync(file);
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runtime_lock(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL);');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT pid FROM runtime_lock WHERE id=1').get();
      if (row) {
        let alive = true;
        try { process.kill(Number(row.pid), 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive) throw new FederationError('同じ分散Cloud台帳は既に使用中です。', 409);
      }
      this.db.prepare('INSERT OR REPLACE INTO runtime_lock(id,pid) VALUES(1,?)').run(process.pid);
      this.db.prepare('INSERT OR IGNORE INTO state(id,value) VALUES(1,?)').run(JSON.stringify({ policy: { enabled: false, maxConcurrent: 1, minFreeMemoryBytes: 1024 ** 3, minFreeDiskBytes: 1024 ** 3 }, peers: [], orders: [], outbound: [], nonces: [] } satisfies FederationState));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  identity(): StoredIdentity | undefined { const row = this.db.prepare('SELECT value FROM identity WHERE id=1').get(); return row ? JSON.parse(String(row.value)) : undefined; }
  saveIdentity(identity: StoredIdentity): void { this.db.prepare('INSERT INTO identity(id,value) VALUES(1,?)').run(JSON.stringify(identity)); }
  read(): FederationState { return JSON.parse(String(this.db.prepare('SELECT value FROM state WHERE id=1').get()!.value)); }
  transaction<T>(change: (state: FederationState) => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const state = this.read(); const result = change(state); this.db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(state)); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.prepare('DELETE FROM runtime_lock WHERE id=1 AND pid=?').run(process.pid); this.db.close(); }
}
