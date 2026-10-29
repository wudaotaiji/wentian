import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {acquireAgentMaintenanceLease} from './agent-maintenance-lease.js';

test('保守の所有権を同時取得できず、解放後に次の保守へ移る',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'wentian-maintenance-lease-'));
  const filename=path.join(directory,'lease.sqlite');
  try{
    const first=acquireAgentMaintenanceLease(filename);assert.ok(first);
    assert.equal(acquireAgentMaintenanceLease(filename),undefined);
    first();
    const second=acquireAgentMaintenanceLease(filename);assert.ok(second);
    first(); // 過去の解放処理は次の所有者を変更しません。
    assert.equal(acquireAgentMaintenanceLease(filename),undefined);
    second();
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('強制終了で残った保守記録は、生存しないPIDを確認して回収する',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'wentian-maintenance-stale-'));
  const filename=path.join(directory,'lease.sqlite');
  try{
    const first=acquireAgentMaintenanceLease(filename);assert.ok(first);first();
    const db=new DatabaseSync(filename);
    db.prepare('INSERT INTO maintenance_owner(id,pid,token) VALUES(1,?,?)').run(2147483647,'終了済みの試験プロセス');db.close();
    const recovered=acquireAgentMaintenanceLease(filename);assert.ok(recovered);recovered();
  }finally{await rm(directory,{recursive:true,force:true});}
});
