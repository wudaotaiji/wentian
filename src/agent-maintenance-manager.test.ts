import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentMaintenanceManager as createManager } from './agent-maintenance-manager.js';
import { saveMaintenanceSettings, validateMaintenanceSettings } from './agent-maintenance-settings.js';
import type { ExternalAgentStatus } from './external-agents.js';
import { setAgentExclusion } from './agent-exclusion-policy.js';
import { setTimeout as delay } from 'node:timers/promises';
import {saveMaintenanceControls} from './maintenance-controls.js';

const lowResources = async () => ({cpu:10,memory:10,network:10,disk:10});
const createAgentMaintenanceManager: typeof createManager = (options, dependencies) => createManager(options, {resources:lowResources,...dependencies});
const settle = async () => { for (let i=0;i<30;i++) await new Promise<void>(resolve => setImmediate(resolve)); };
async function until(predicate:()=>boolean) { for(let i=0;i<1000;i++){if(predicate())return;await delay(5);}assert.fail('保守処理の状態遷移が完了しませんでした。'); }
const agents = (): ExternalAgentStatus[] => ['kilo','opencode','crush'].map(id => ({ id, name:id, state:'needs_recheck', stateLabel:'未確認', note:'', liveState:'healthy', freshWithin24Hours:true }));
const snapshot = async () => ({ source:'fixture', agents:agents(), cacheFreshWithin24Hours:true, summary:{available:0,candidate:0,needs_recheck:3,unavailable:0,total:3} });
async function setup(t: any, enabled=false) {
  const root = await mkdtemp(path.join(os.tmpdir(),'wentian-maintenance-'));
  const names = ['WENTIAN_AGENT_MAINTENANCE_SETTINGS','WENTIAN_AGENT_READY_CACHE','WENTIAN_AGENT_EXCLUSIONS_FILE','WENTIAN_AGENT_CONNECTION_MAINTENANCE'];
  const previous = Object.fromEntries(names.map(name=>[name,process.env[name]]));
  process.env.WENTIAN_AGENT_MAINTENANCE_SETTINGS=path.join(root,'settings.json');
  process.env.WENTIAN_AGENT_READY_CACHE=path.join(root,'ready.json');
  process.env.WENTIAN_AGENT_EXCLUSIONS_FILE=path.join(root,'exclusions.json');
  process.env.WENTIAN_AGENT_CONNECTION_MAINTENANCE='true';
  await saveMaintenanceSettings({enabled,intervalMs:60000,retryIntervalMs:10000,autoInstall:false,verifyWork:true});
  const timers: Array<{callback:()=>void;delay:number;cleared?:boolean}> = [];
  t.mock.method(globalThis,'setTimeout',(callback:()=>void,delay:number)=>{const timer={callback,delay,unref(){}};timers.push(timer);return timer as any;});
  t.mock.method(globalThis,'clearTimeout',(timer:any)=>{if(timer)timer.cleared=true;});
  t.after(()=>{for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}});
  return {root,timers};
}

test('資源停止中の表示再計測は保守を起動せず予約時刻・停止状態を維持する',async t=>{
 await setup(t,true);let sample:any=undefined,loads=0;
 const manager=createAgentMaintenanceManager({}, {resources:async()=>sample,loadSnapshot:async()=>{loads++;return snapshot()}});
 try{
  await until(()=>Boolean(manager.maintenanceStatus().nextRunAt));const before=manager.maintenanceStatus();assert.equal(before.resourcePaused,true);
  sample={cpu:10,memory:82,network:0,disk:0,diskCapacity:61};
  const warning=await manager.refreshResourceStatus!();assert.equal(warning.resources?.state,'warning');assert.equal(warning.resourcePaused,true);assert.equal(warning.nextRunAt,before.nextRunAt);assert.ok(warning.resources?.checkedAt);
  sample={...sample,memory:50};const recovered=await manager.refreshResourceStatus!();assert.equal(recovered.resources?.state,'normal');assert.equal(recovered.resourcePaused,true);assert.equal(recovered.nextRunAt,before.nextRunAt);assert.equal(loads,0);
 }finally{await manager.stop()}
});

test('保存された全体開始を再起動後も復元し、一時停止Agentを対象外にする', async t=>{
  await setup(t,true);
  await setAgentExclusion('crush',true,'fixture');
  const calls:string[][]=[];
  const make=()=>createAgentMaintenanceManager({}, {loadSnapshot:snapshot,maintain:async candidates=>{calls.push(candidates.map(a=>a.id));return candidates;}});
  let manager=make();
  await until(()=>calls.length===1&&Boolean(manager.maintenanceStatus().nextRunAt)); await manager.stop();
  assert.deepEqual(calls,[['kilo','opencode']]);
  manager=make(); await until(()=>calls.length===2&&Boolean(manager.maintenanceStatus().nextRunAt)); await manager.stop();
  assert.deepEqual(calls,[['kilo','opencode'],['kilo','opencode']]);
});

test('管理画面の許可変更で再起動せず開始し、禁止で実行中処理を停止する',async t=>{
 const {root}=await setup(t,true);
 const previous=process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE;
 process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE=path.join(root,'controls.json');
 t.after(()=>{if(previous===undefined)delete process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE;else process.env.WENTIAN_MAINTENANCE_CONTROLS_FILE=previous;});
 await saveMaintenanceControls({connection:false});
 let started=false,aborted=false;
 const manager=createAgentMaintenanceManager({}, {loadSnapshot:snapshot,maintain:async(candidates,_update,signal)=>{
  started=true;await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return candidates;
 }});
 try{
  await settle();assert.equal(manager.maintenanceStatus().state,'disabled');
  await saveMaintenanceControls({connection:true});await manager.reloadMaintenanceControls?.();
  await until(()=>started);assert.equal(manager.maintenanceStatus().state,'running');
  await saveMaintenanceControls({connection:false});await manager.reloadMaintenanceControls?.();
  assert.equal(aborted,true);assert.equal(manager.maintenanceStatus().state,'disabled');assert.equal(manager.maintenanceStatus().nextRunAt,undefined);
 }finally{await manager.stop();}
});

test('全体停止は保存され、手動確認は自動保守を有効化せず一回だけ実行する', async t=>{
  const {timers}=await setup(t,false);
  const calls:string[][]=[];
  const manager=createAgentMaintenanceManager({}, {loadSnapshot:snapshot,maintain:async candidates=>{calls.push(candidates.map(a=>a.id));return candidates;}});
  try{
    await settle(); await manager.refresh();
    assert.equal(calls.length,0);
    assert.equal(manager.maintenanceStatus().state,'stopped');
    manager.requestMaintenance('kilo'); await until(()=>calls.length===1&&manager.maintenanceStatus().state==='stopped');
    assert.deepEqual(calls,[['kilo']]);
    assert.equal(manager.maintenanceStatus().settings.enabled,false);
    assert.equal(manager.maintenanceStatus().nextRunAt,undefined);
    assert.equal(timers.filter(timer=>!timer.cleared).length,0);
  }finally{await manager.stop();}
});

test('行の手動確認で全体定期保守の対象範囲を狭めない', async t=>{
  const {timers}=await setup(t,true);
  const calls:string[][]=[];
  const manager=createAgentMaintenanceManager({}, {loadSnapshot:snapshot,maintain:async candidates=>{calls.push(candidates.map(a=>a.id));return candidates;}});
  try{
    await until(()=>Boolean(manager.maintenanceStatus().nextRunAt));manager.requestMaintenance('kilo');await until(()=>calls.length===2&&Boolean(manager.maintenanceStatus().nextRunAt));
    const timer=timers.filter(timer=>!timer.cleared).at(-1)!;
    assert.equal(timer.delay,10000,'失敗Agentが残る場合は再試行間隔を使用します');
    timer.callback();await until(()=>calls.length===3&&Boolean(manager.maintenanceStatus().nextRunAt));
    assert.deepEqual(calls,[['kilo','opencode','crush'],['kilo'],['kilo','opencode','crush']]);
    assert.ok(manager.maintenanceStatus().nextRunAt);
  }finally{await manager.stop();}
});

test('全体停止は実行中の保守を中断し、待機要求と次回予約を解除する', async t=>{
  const {root}=await setup(t,false);
  let aborted=false;
  let started=false;
  const manager=createAgentMaintenanceManager({}, {loadSnapshot:snapshot,maintain:async(candidates,_update,signal)=>{
    started=true;
    await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return candidates;
  }});
  try{
    manager.requestMaintenance('kilo');await until(()=>started);
    manager.requestMaintenance('opencode');
    await manager.configureMaintenance({enabled:false});await settle();
    assert.equal(aborted,true);
    assert.equal(manager.maintenanceStatus().state,'stopped');
    assert.deepEqual(manager.maintenanceStatus().pendingAgents,[]);
    assert.equal(manager.maintenanceStatus().nextRunAt,undefined);
    assert.equal(JSON.parse(await readFile(path.join(root,'settings.json'),'utf8')).enabled,false);
  }finally{await manager.stop();}
});

test('保存待ちで停止した保守は子処理を起動せず終了する', async t=>{
  await setup(t,false);
  let saving=false,called=false;
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const manager=createAgentMaintenanceManager({}, {
    loadSnapshot:snapshot,
    saveSnapshot:async()=>{saving=true;await waiting;},
    maintain:async candidates=>{called=true;return candidates;},
  });
  try{
    manager.requestMaintenance('kilo');await until(()=>saving);
    await manager.configureMaintenance({enabled:false});
    release();await manager.stop();
    assert.equal(called,false,'停止後に外部Agentを起動しません。');
    assert.equal(manager.maintenanceStatus().state,'stopped');
    assert.equal(manager.maintenanceStatus().nextRunAt,undefined);
  }finally{release();await manager.stop();}
});

test('環境による無効化を画面操作で迂回せず、設定破損も停止理由として公開する', async t=>{
  const {root}=await setup(t,true);
  process.env.WENTIAN_AGENT_CONNECTION_MAINTENANCE='false';
  let manager=createAgentMaintenanceManager({}, {loadSnapshot:snapshot,maintain:async()=>{throw new Error('実行禁止');}});
  await settle();
  assert.equal(manager.maintenanceStatus().state,'disabled');
  await assert.rejects(manager.configureMaintenance({enabled:true}),/無効/);
  assert.throws(()=>manager.requestMaintenance(),/無効/);
  await manager.stop();
  process.env.WENTIAN_AGENT_CONNECTION_MAINTENANCE='true';
  await writeFile(path.join(root,'settings.json'),'broken');
  manager=createAgentMaintenanceManager({}, {loadSnapshot:snapshot});
  await until(()=>manager.maintenanceStatus().state==='error');
  assert.equal(manager.maintenanceStatus().state,'error');
  assert.match(manager.maintenanceStatus().reason!,/設定/);
  await manager.stop();
});

test('保守エラーを公開し実際の再試行予約を作成する',async t=>{
  const {timers}=await setup(t,true);
  const manager=createAgentMaintenanceManager({}, {loadSnapshot:snapshot,maintain:async()=>{throw new Error('秘密を含むCLI詳細');}});
  await until(()=>manager.maintenanceStatus().state==='error'&&Boolean(manager.maintenanceStatus().nextRunAt));
  assert.equal(manager.maintenanceStatus().state,'error');
  assert.ok(manager.maintenanceStatus().nextRunAt);
  assert.doesNotMatch(manager.maintenanceStatus().lastError!,/秘密/);
  assert.equal(timers.filter(timer=>!timer.cleared).at(-1)!.delay,10000);
  await manager.stop();
});

test('保守設定は型・範囲・未知のキーを検証する',()=>{
  assert.throws(()=>validateMaintenanceSettings({enabled:'true'}));
  assert.throws(()=>validateMaintenanceSettings({intervalMs:0}));
  assert.throws(()=>validateMaintenanceSettings({retryIntervalMs:Infinity}));
  assert.throws(()=>validateMaintenanceSettings({command:'任意実行'}));
});
test('90%停止後は89.99%へ回復すれば警告を残して自動復帰する',async t=>{
  const {timers}=await setup(t,true);
  let memory=90,loads=0,calls=0;
  const manager=createAgentMaintenanceManager({}, {
    resources:async()=>({cpu:10,memory,network:10,disk:10}),
    loadSnapshot:async()=>{loads++;return snapshot();},
    maintain:async candidates=>{calls++;return candidates;},
  });
  try {
    await until(()=>Boolean(manager.maintenanceStatus().nextRunAt));
    assert.equal(loads,0);assert.equal(calls,0);
    assert.equal(manager.maintenanceStatus().resources?.state,'paused');
    assert.equal(timers.filter(timer=>!timer.cleared).at(-1)!.delay,60000);
    manager.requestMaintenance('kilo');await settle();
    assert.equal(loads,0,'再確認の連打で資源停止を迂回しません');
    memory=89.99;timers.filter(timer=>!timer.cleared).at(-1)!.callback();
    await until(()=>calls===1&&Boolean(manager.maintenanceStatus().nextRunAt));
    assert.equal(loads,1);assert.equal(manager.maintenanceStatus().lastError,undefined);
    assert.equal(manager.maintenanceStatus().resources?.state,'warning');
    assert.equal(manager.maintenanceStatus().resourcePaused,false);
    assert.equal(manager.maintenanceStatus().resourceRetryCount,0);
  } finally {await manager.stop();}
});
