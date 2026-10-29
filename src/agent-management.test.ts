import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {registerAgentRowControls} from './agent-row-controls.js';
import {readAgentManagement,compareAgentPriority} from './agent-management.js';
import {agentRegistered} from './agent-exclusion-policy.js';
import type {ExternalAgentSnapshot} from './external-agents.js';
import {selectExternalAgents,type OrchestrationTask} from './external-orchestrator.js';

test('順位・停止・解除・再追加・削除を永続化し、削除範囲の未確認を拒否する',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wentian-management-'));
  const keys=['WENTIAN_AGENT_MANAGEMENT_FILE','WENTIAN_AGENT_REGISTRATIONS_FILE','WENTIAN_AGENT_EXCLUSIONS_FILE','WENTIAN_MANUAL_AGENTS_FILE'];
  const saved=keys.map(key=>process.env[key]);keys.forEach((key,index)=>process.env[key]=path.join(root,index+'.json'));
  const snapshot:ExternalAgentSnapshot={source:'fixture',cacheFreshWithin24Hours:false,summary:{total:2,available:2,candidate:0,needs_recheck:0,unavailable:0},agents:['goose','crush'].map(id=>({id,name:id,cli:id,state:'available',stateLabel:'利用可能',note:'証拠',freshWithin24Hours:false}))};
  const app=Fastify();registerAgentRowControls(app,{snapshot:async()=>snapshot,update:async()=>{},authorize:(req,reply)=>{if(req.headers['x-admin']!=='yes'){reply.code(403).send({});return;}return 'admin';}});
  const control=(id:string,payload:object)=>app.inject({method:'POST',url:'/v1/manager/external-agents/'+id+'/control',headers:{'x-admin':'yes'},payload});
  const registration=(id:string,action:string)=>app.inject({method:'POST',url:'/v1/manager/agent-marketplace/'+id+'/registration',headers:{'x-admin':'yes'},payload:{action}});
  try{
    assert.equal((await app.inject({method:'POST',url:'/v1/manager/external-agents/goose/uninstall-plan',payload:{}})).statusCode,403);
    const moved=await control('crush',{action:'up'});assert.equal(moved.statusCode,200);assert.equal(moved.json().agents[0].id,'crush');assert.ok(compareAgentPriority('crush','goose')<0);
    const task:OrchestrationTask={version:'1.0',taskId:'fixture',objective:'確認',workspace:root,requiredCapabilities:['text'],requestedAgents:[],parallel:false,allowedWritePaths:[],forbiddenOperations:[],stopConditions:[],acceptanceCriteria:[],reportPath:'fixture.json'};
    assert.equal(selectExternalAgents(task,snapshot.agents)[0].id,'crush','表示順位を実際の自動選択にも反映します');
    assert.equal(selectExternalAgents({...task,requestedAgents:['goose','crush']},snapshot.agents)[0].id,'goose','明示指定した順序を尊重します');
    await control('goose',{action:'force'});assert.equal(readAgentManagement().forcedAgent,'goose');
    assert.equal(selectExternalAgents(task,snapshot.agents)[0].id,'goose','強制使用は手動順位より優先します');
    assert.equal(selectExternalAgents({...task,requestedAgents:['crush']},snapshot.agents)[0].id,'crush','明示した候補範囲を越えません');
    assert.equal((await control('goose',{action:'pause'})).json().agents[1].stateLabel,'一時停止');
    assert.equal((await control('goose',{action:'resume'})).json().agents[1].excluded,false);
    assert.notEqual((await control('goose',{action:'uninstall'})).statusCode,200);assert.equal(agentRegistered('goose'),true);
    assert.notEqual((await control('goose',{action:'uninstall',scope:'cli',token:'invalid'})).statusCode,200);assert.equal(agentRegistered('goose'),true);
    assert.equal((await control('goose',{action:'uninstall',scope:'wentian'})).statusCode,200);assert.equal(agentRegistered('goose'),false);assert.equal(readAgentManagement().uninstalled.goose.cli,'goose');
    assert.equal(readAgentManagement().forcedAgent,undefined,'解除したAgentを強制対象に残しません');
    assert.equal((await registration('goose','add')).statusCode,200);assert.equal(agentRegistered('goose'),true);assert.equal(readAgentManagement().uninstalled.goose,undefined);
    assert.equal((await registration('goose','delete')).statusCode,409);
    await control('goose',{action:'uninstall',scope:'wentian'});
    assert.equal((await registration('goose','delete')).statusCode,200);assert.ok(readAgentManagement().deleted.includes('goose'));assert.equal(agentRegistered('goose'),false);
  }finally{await app.close();keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});}
});
