import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAgentMaintenanceRoutes } from './agent-maintenance-routes.js';
import type { ExternalAgentReadinessManager } from './external-agent-readiness.js';

test('統一保守APIは閲覧・管理者操作・開始停止・一回確認・入力不正を区別する',async()=>{
  const app=Fastify();const patches:unknown[]=[];let runs=0;
  const state:any={settings:{enabled:false},state:'stopped'};
  const manager={maintenanceStatus:()=>state,configureMaintenance:async(patch:any)=>{patches.push(patch);state.settings={...state.settings,...patch};return state;},requestMaintenance:()=>{runs++;}} as unknown as ExternalAgentReadinessManager;
  registerAgentMaintenanceRoutes(app,manager,(req,reply)=>{if(req.headers['x-admin']==='yes')return 'admin';reply.code(403).send({error:'管理者限定'});});
  const post=(body:Record<string,unknown>,admin=true)=>app.inject({method:'POST',url:'/v1/manager/external-agents/maintenance',headers:admin?{'x-admin':'yes'}:{},payload:body});
  try{
    assert.equal((await app.inject('/v1/manager/external-agents/maintenance/ai')).statusCode,403);
    const ai=await app.inject({url:'/v1/manager/external-agents/maintenance/ai',headers:{'x-admin':'yes'}});
    assert.equal(ai.statusCode,200);assert.equal(ai.json().engine,'ai');assert.ok(Array.isArray(ai.json().reports));
    assert.equal((await app.inject('/v1/manager/external-agents/maintenance')).json().state,'stopped');
    assert.equal((await post({action:'start'},false)).statusCode,403);assert.equal(patches.length,0);
    for(const action of ['start','stop','run'])assert.equal((await post({action})).statusCode,202);
    assert.deepEqual(patches,[{enabled:true},{enabled:false}]);assert.equal(runs,1);
    assert.equal((await post({action:'configure',settings:{intervalMs:30000}})).statusCode,202);
    assert.equal((await post({action:'unknown'})).statusCode,400);
    assert.equal((await post({action:'start',agent:'unknown'})).statusCode,400);
    assert.equal((await post({})).statusCode,202,'旧全体開始APIと互換性を保ちます');
  }finally{await app.close();}
});

test('閲覧は現在の資源を再計測し、保守の開始要求は送らない',async()=>{
 const app=Fastify();let measured=0;
 const manager={maintenanceStatus:()=>({state:'error'}),refreshResourceStatus:async()=>{measured++;return{state:'error',resourcePaused:true,resources:{state:'warning',checkedAt:'2026-10-24T00:00:00Z',usage:{cpu:10,memory:82,disk:0,network:0,diskCapacity:61}}}},requestMaintenance:()=>assert.fail('閲覧で保守を起動してはいけません')} as unknown as ExternalAgentReadinessManager;
 registerAgentMaintenanceRoutes(app,manager,()=>undefined);
 try{const result=await app.inject('/v1/manager/external-agents/maintenance');assert.equal(result.statusCode,200);assert.equal(measured,1);assert.equal(result.json().resources.usage.memory,82);assert.equal(result.json().resourcePaused,true)}finally{await app.close()}
});
