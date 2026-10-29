import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {maintainAgentInstallation,readAgentInstallations} from './agent-install-maintenance.js';
import {setAgentExclusion,setAgentRegistration} from './agent-exclusion-policy.js';
import type {ExternalAgentStatus} from './external-agents.js';

test('未導入の登録済みCLIを自動導入し、実起動確認後に接続保守へ渡す',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-install-'));
  const keys=['WENTIAN_AGENT_INSTALL_CACHE','WENTIAN_AGENT_AUTO_INSTALL','WENTIAN_AGENT_EXCLUSIONS_FILE','WENTIAN_AGENT_REGISTRATIONS_FILE'];
  const saved=keys.map(key=>process.env[key]);keys.forEach((key,index)=>process.env[key]=index===1?'true':path.join(root,index+'.json'));
  const agent:ExternalAgentStatus={id:'cline',name:'Cline',cli:'cline',liveState:'not_installed',state:'unavailable',stateLabel:'CLI未導入',note:'',freshWithin24Hours:false};
  const states:string[]=[];let installs=0,now=1000;
  const deps={now:()=>now,install:async()=>{installs++;},probe:async()=>({installed:true,liveState:'healthy' as const,checkedAt:new Date(now).toISOString(),version:'1'})};
  try{
    const result=await maintainAgentInstallation(agent,async updated=>{states.push(updated.installation!.status);},undefined,deps);
    assert.equal(installs,1);assert.deepEqual(states,['installing','verified']);assert.equal(result.liveState,'healthy');assert.equal(result.connection,undefined,'導入成功だけでモデル応答を捏造しません');
    await maintainAgentInstallation(result,undefined,undefined,deps);assert.equal(installs,1,'起動済みのCLIは再導入しません');
    const failed={...deps,install:async()=>{installs++;throw new Error('通信失敗');}};
    const retry=await maintainAgentInstallation(agent,undefined,undefined,failed);assert.equal(retry.installation!.status,'retry_wait');
    const count=installs;await maintainAgentInstallation(agent,undefined,undefined,deps);assert.equal(installs,count,'期限前はパッケージ導入を繰り返しません');
    now=Date.parse(readAgentInstallations().cline.retryAt!)+1;await maintainAgentInstallation(agent,undefined,undefined,deps);assert.equal(installs,count+1);
    await setAgentExclusion('cline',true,'fixture');await maintainAgentInstallation(agent,undefined,undefined,deps);assert.equal(installs,count+1,'停止中は導入しません');
    await setAgentExclusion('cline',false,'fixture');await setAgentRegistration('cline',false);await maintainAgentInstallation(agent,undefined,undefined,deps);assert.equal(installs,count+1,'解除済みは再導入しません');
    const unknown=await maintainAgentInstallation({...agent,id:'unknown-cli'},undefined,undefined,deps);assert.equal(unknown.installation!.status,'manual_required');assert.equal(installs,count+1,'任意のCLI名をパッケージ導入に渡しません');
  }finally{keys.forEach((key,index)=>{if(saved[index]===undefined)delete process.env[key];else process.env[key]=saved[index];});}
});

test('導入コマンド成功でもCLI確認失敗なら利用可能にしない',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-install-probe-'));
  const old=process.env.WENTIAN_AGENT_INSTALL_CACHE,enabled=process.env.WENTIAN_AGENT_AUTO_INSTALL;
  process.env.WENTIAN_AGENT_INSTALL_CACHE=path.join(root,'state.json');process.env.WENTIAN_AGENT_AUTO_INSTALL='true';
  try{
    const agent:ExternalAgentStatus={id:'crush',name:'Crush',liveState:'not_installed',state:'unavailable',stateLabel:'',note:'',freshWithin24Hours:false};
    const result=await maintainAgentInstallation(agent,undefined,undefined,{install:async()=>{},probe:async()=>({installed:false,liveState:'not_installed',checkedAt:''})});
    assert.equal(result.installation!.status,'retry_wait');assert.equal(result.state,'needs_recheck');assert.notEqual(result.liveState,'healthy');
  }finally{if(old===undefined)delete process.env.WENTIAN_AGENT_INSTALL_CACHE;else process.env.WENTIAN_AGENT_INSTALL_CACHE=old;if(enabled===undefined)delete process.env.WENTIAN_AGENT_AUTO_INSTALL;else process.env.WENTIAN_AGENT_AUTO_INSTALL=enabled;}
});
