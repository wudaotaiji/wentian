import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ControlCenterAuthStore } from './control-center-auth.js';

test('復旧CLIは標準入力でパスワードを受け、一覧・出力に秘密を含めずIDを維持する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-recovery-cli-')),file=path.join(root,'users.json');
 try{
  const store=new ControlCenterAuthStore(file);await store.initialize({bootstrap:false});const user=await store.createUser({username:'original-admin',password:'old-test-password',role:'admin'});
  const run=(args:string[],input='')=>new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./user-recovery.ts',import.meta.url)),file,...args],{cwd:process.cwd(),windowsHide:true,env:{...process.env,WENTIAN_INSTALL_ROOT:root,WENTIAN_ADMIN_USERNAME:'',WENTIAN_ADMIN_PASSWORD:''},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',data=>{out+=data});child.stderr.on('data',data=>{err+=data});child.once('error',reject);child.once('close',code=>resolve({code,out,err}));child.stdin.end(input)});
  const listing=await run(['--list']);assert.equal(listing.code,0,listing.err);assert.equal(JSON.parse(listing.out)[0].id,user.id);assert.doesNotMatch(listing.out,/password|scrypt|Hash/);
  const changed=await run([],JSON.stringify({userId:user.id,password:'new-test-password',username:'recovered-admin'}));assert.equal(changed.code,0,changed.err);assert.doesNotMatch(changed.out+changed.err,/new-test-password|old-test-password/);
  const reloaded=new ControlCenterAuthStore(file);await reloaded.initialize({bootstrap:false});assert.equal((await reloaded.login('recovered-admin','new-test-password'))!.user.id,user.id);assert.doesNotMatch(await readFile(file,'utf8'),/new-test-password/);
 }finally{await rm(root,{recursive:true,force:true})}
});
