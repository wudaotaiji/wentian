import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {maintenanceControlStatus,saveMaintenanceControls} from './maintenance-controls.js';
import {registerMaintenanceControlsRoutes} from './maintenance-controls-routes.js';

async function fixture(t:any){
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-controls-'));
 const keys=['WENTIAN_MAINTENANCE_CONTROLS_FILE','WENTIAN_AGENT_CONNECTION_MAINTENANCE','WENTIAN_MEDIA_MODEL_MAINTENANCE'];
 const previous=keys.map(key=>process.env[key]);
 process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE=path.join(root,'controls.json');
 process.env.WENTIAN_AGENT_CONNECTION_MAINTENANCE='false';process.env.WENTIAN_MEDIA_MODEL_MAINTENANCE='false';
 t.after(()=>keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];}));
 return root;
}
test('画面の保存値で環境初期値を変更し、未指定項目は維持する',async t=>{
 await fixture(t);
 assert.equal(maintenanceControlStatus().connection.allowed,false);
 await saveMaintenanceControls({connection:true});
 assert.equal(maintenanceControlStatus().connection.allowed,true);
 assert.equal(maintenanceControlStatus().connection.source,'management');
 assert.equal(maintenanceControlStatus().connection.environmentAllowed,false);
 assert.equal(maintenanceControlStatus().media.allowed,false);
 await saveMaintenanceControls({media:true});
 assert.deepEqual(JSON.parse(await readFile(process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE!,'utf8')),{connection:true,media:true});
 await assert.rejects(async()=>saveMaintenanceControls({connection:'false'}));
 await assert.rejects(async()=>saveMaintenanceControls({unknown:true}));
});
test('管理APIで認可・同一オリジンを確認し、保存後すぐ反映して状態を返す',async t=>{
 await fixture(t);const app=Fastify();const changed:unknown[]=[];
 registerMaintenanceControlsRoutes(app,(req,reply)=>{if(req.headers['x-admin']==='yes')return 'owner';reply.code(403).send({error:{message:'管理者限定です。'}});},keys=>{changed.push(keys);});
 const url='/v1/manager/maintenance-controls',headers={'x-admin':'yes'};
 try{
  assert.equal((await app.inject(url)).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url,headers:{...headers,origin:'https://external.example'},payload:{connection:true}})).statusCode,403);
  const result=await app.inject({method:'PUT',url,headers,payload:{connection:true,media:true}});
  assert.equal(result.statusCode,200);assert.equal(result.json().connection.allowed,true);assert.deepEqual(changed,[['connection','media']]);
  assert.equal((await app.inject({method:'GET',url,headers})).json().media.source,'management');
  assert.equal((await app.inject({method:'PUT',url,headers,payload:{connection:false}})).statusCode,200);
  assert.deepEqual(changed,[['connection','media'],['connection']]);
 }finally{await app.close();}
});
test('サーバー起動オプションの禁止と反映失敗を成功として表示しない',async t=>{
 await fixture(t);const app=Fastify();
 registerMaintenanceControlsRoutes(app,()=>true,()=>{throw Error('反映失敗');},()=>true);
 const url='/v1/manager/maintenance-controls';
 try{
  assert.equal((await app.inject(url)).json().connection.editable,false);
  assert.equal((await app.inject({method:'PUT',url,payload:{connection:true}})).statusCode,409);
  const result=await app.inject({method:'PUT',url,payload:{media:true}});
  assert.equal(result.statusCode,500);assert.equal(result.json().saved,true);
  assert.match(result.json().error.message,/保存済み/);
 }finally{await app.close();}
});
