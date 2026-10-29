import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerMediaModelMaintenance } from './media-model-maintenance.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {saveMaintenanceControls} from './maintenance-controls.js';
import {writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

test('モデル保守は取得許可を永続化し、無認証・外部オリジン・不正な対象を拒否する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-model-policy-')),previous=process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT;process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT=root;const app=Fastify();registerMediaModelMaintenance(app,(req,reply)=>{if(req.headers['x-test-admin']==='yes')return 'owner';reply.code(401).send({error:{message:'ログインが必要です。'}})});const headers={'x-test-admin':'yes'},policy={music:true,sound:true,transcribe:true,video:true};
 try{assert.equal((await app.inject('/api/media/models')).statusCode,401);assert.equal((await app.inject({method:'PUT',url:'/api/media/models',headers:{...headers,origin:'https://external.example'},payload:policy})).statusCode,403);assert.equal((await app.inject({method:'PUT',url:'/api/media/models',headers,payload:{...policy,command:'cmd.exe'}})).statusCode,400);assert.equal((await app.inject({method:'PUT',url:'/api/media/models',headers,payload:policy})).statusCode,202);const result=(await app.inject({url:'/api/media/models',headers})).json();assert.deepEqual(result.policy,policy);assert.equal(result.running,false);
 }finally{await app.close();process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT=previous;await rm(root,{recursive:true,force:true})}
});

test('メディア実行許可も環境初期値から再起動なしで変更できる',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-media-controls-'));
 const names=['WENTIAN_MEDIA_MAINTENANCE_ROOT','WENTIAN_MAINTENANCE_CONTROLS_FILE','WENTIAN_MEDIA_MODEL_MAINTENANCE'],previous=names.map(name=>process.env[name]);
 process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT=root;process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE=path.join(root,'controls.json');process.env.WENTIAN_MEDIA_MODEL_MAINTENANCE='false';
 t.after(()=>names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];}));
 await writeFile(path.join(root,'policy.json'),JSON.stringify({music:true,sound:false,transcribe:false,video:false}));
 const app=Fastify();let measured=0;
 const maintenance=registerMediaModelMaintenance(app,()=> 'owner',{resources:async()=>{measured++;return {cpu:10,memory:10,disk:90,network:10};}});
 try{
  await maintenance.sweep();assert.equal(measured,0);assert.equal((await maintenance.status()).permission.allowed,false);
  await saveMaintenanceControls({media:true});await maintenance.reloadMaintenanceControls();
  for(let i=0;i<200;i++){if(measured>0&&!(await maintenance.status()).running)break;await delay(5);}
  assert.equal(measured,1);assert.equal((await maintenance.status()).permission.allowed,true);
  assert.equal((await maintenance.status()).resources.state,'paused','許可変更でも資源保護を維持します');
  await saveMaintenanceControls({media:false});await maintenance.reloadMaintenanceControls();assert.equal((await maintenance.status()).permission.allowed,false);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
test('モデル保守も90%ではPythonを起動せず回復確認を予約する',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-model-resource-'));
 const previousRoot=process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT,previousEnabled=process.env.WENTIAN_MEDIA_MODEL_MAINTENANCE,previousPython=process.env.WENTIAN_VIDEO_PYTHON;
 process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT=root;process.env.WENTIAN_MEDIA_MODEL_MAINTENANCE='true';
 const retries:Array<()=>void>=[];
 // 保守の長い予約だけを捕捉します。実ファイルの原子的置換がWindowsの短時間ロックで
 // 再試行するときまで仮時計へ止めると、解除されないPromiseが残って試験全体が停止します。
 const actualSetTimeout=globalThis.setTimeout,actualClearTimeout=globalThis.clearTimeout;
 t.mock.method(globalThis,'setTimeout',(callback:()=>void,ms?:number,...args:any[])=>{if(Number(ms)<1000)return actualSetTimeout(callback,ms,...args);retries.push(callback);return {maintenanceMockTimer:true,unref(){}} as any;});
 t.mock.method(globalThis,'clearTimeout',(timer:any)=>{if(!timer?.maintenanceMockTimer)actualClearTimeout(timer);});
 const app=Fastify({logger:false});
 let disk=90;
 // 未存在の実行ファイルで起動直後に停止し、実モデル・ダウンロードを使わず再開条件を検査します。
 process.env.WENTIAN_VIDEO_PYTHON=path.join(root,'not-installed-python.exe');
 const maintenance=registerMediaModelMaintenance(app,()=> 'owner',{resources:async()=>({cpu:10,memory:10,network:10,disk})});
 try {
   const {writeFile}=await import('node:fs/promises');
   await writeFile(path.join(root,'policy.json'),JSON.stringify({music:true,sound:false,transcribe:false,video:false}));
   await maintenance.sweep();
   const status=await maintenance.status();
   assert.equal(status.resources.state,'paused');assert.equal(status.running,false);
   assert.match((status as any).message,/90%/);assert.equal(retries.length,1);
   disk=89.99;retries[0]();
   for(let i=0;i<200;i++){if(!(await maintenance.status()).running)break;await delay(5)}
   const recovered=await maintenance.status();assert.equal(recovered.resources.state,'warning');assert.match((recovered as any).message,/専用Python/,'警告域への回復で資源停止を解除し、次の処理へ進みます');
 } finally {
   await app.close();
   if(previousRoot===undefined)delete process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT;else process.env.WENTIAN_MEDIA_MAINTENANCE_ROOT=previousRoot;
   if(previousEnabled===undefined)delete process.env.WENTIAN_MEDIA_MODEL_MAINTENANCE;else process.env.WENTIAN_MEDIA_MODEL_MAINTENANCE=previousEnabled;
   if(previousPython===undefined)delete process.env.WENTIAN_VIDEO_PYTHON;else process.env.WENTIAN_VIDEO_PYTHON=previousPython;
   await rm(root,{recursive:true,force:true});
 }
});
