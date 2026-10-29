import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceResourceState, runResourceLimited, withMaintenanceResources, MaintenanceResourcePause, resourceRetryDelay,createResourceCollector } from './maintenance-resources.js';
const low = { cpu: 10, memory: 10, network: 10, disk: 10 };
test('全資源の80%警告・90%停止と不正値を検証する', () => {
  assert.equal(maintenanceResourceState(low), 'normal');
  assert.equal(maintenanceResourceState(undefined), 'unknown');
  for (const key of Object.keys(low)) {
    for (const [value, state] of [[79.99,'normal'],[80,'warning'],[89.99,'warning'],[90,'paused'],[100,'paused'],[NaN,'unknown'],[-1,'unknown'],[Infinity,'unknown']] as const)
      assert.equal(maintenanceResourceState({...low,[key]:value}),state);
  }
});
test('低負荷でも全Agentを直列実行する', async () => {
  let running=0, maximum=0;
  await runResourceLimited([1,2,3],async()=>{
    maximum=Math.max(maximum,++running);
    await new Promise(resolve=>setImmediate(resolve));running--;
  },undefined,async()=>low);
  assert.equal(maximum,1);
});
test('90%以上・未計測・取得例外では一件も起動しない', async () => {
  for(const sample of [undefined,{...low,disk:90},'例外']) {
    await assert.rejects(runResourceLimited([1],async()=>assert.fail('起動禁止'),undefined,
      async()=>{if(typeof sample==='string')throw Error('計測失敗');return sample;}),MaintenanceResourcePause);
  }
});
test('負荷上昇時は次のAgentを起動しない', async () => {
  const completed:number[]=[];
  await assert.rejects(runResourceLimited([1,2],async id=>{completed.push(id);},undefined,
    async()=>completed.length?{...low,memory:90}:low),MaintenanceResourcePause);
  assert.deepEqual(completed,[1]);
});
test('計測中の停止は新しいAgentを起動しない', async () => {
  const controller=new AbortController();
  await assert.rejects(runResourceLimited([1],async()=>assert.fail('起動禁止'),controller.signal,
    async()=>{controller.abort();return low;}));
});
test('実行中の90%到達は子処理へ中断を通知し監視を解除する',async t=>{
  let poll:()=>void=()=>{},cleared=false,measured=0,aborted=false;
  t.mock.method(globalThis,'setInterval',(callback:()=>void)=>{poll=callback;return {unref(){}} as any;});
  t.mock.method(globalThis,'clearInterval',()=>{cleared=true;});
  const task=withMaintenanceResources(async signal=>{
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
  },undefined,async()=>++measured===1?low:{...low,disk:90});
  await new Promise(resolve=>setImmediate(resolve));poll();
  await assert.rejects(task,MaintenanceResourcePause);
  assert.equal(aborted,true);assert.equal(cleared,true);
});
test('80%警告は通知し、開始前の90%では処理を起動しない',async()=>{
  const states:string[]=[];
  await withMaintenanceResources(async()=>{},undefined,async()=>({...low,cpu:80}),state=>{states.push(state);});
  assert.deepEqual(states,['warning']);
  await assert.rejects(withMaintenanceResources(async()=>assert.fail('起動禁止'),undefined,async()=>({...low,cpu:90})),MaintenanceResourcePause);
});
test('ディスク稼働率が低くても容量使用率90%以上なら開始せず理由を返す',async()=>{
  for(const [diskCapacity,state] of [[79.9,'normal'],[80,'warning'],[90,'paused'],[95.5,'paused'],[NaN,'unknown'],[-1,'unknown'],[101,'unknown']] as const)
    assert.equal(maintenanceResourceState({...low,diskCapacity}),state);
  await assert.rejects(withMaintenanceResources(async()=>assert.fail('容量不足時は起動禁止'),undefined,
    async()=>({...low,diskCapacity:95.5})),/ディスク容量使用率/);
});
test('資源停止の連続回数に従って再試行を延長し利用者の長い設定を尊重する',()=>{
  assert.deepEqual([1,2,3,4,5,10].map(count=>resourceRetryDelay(count)),[60000,120000,240000,480000,900000,900000]);
  assert.equal(resourceRetryDelay(1,3600000),3600000);
});

test('計測は30秒枠で重複せず実行し、失敗理由・計測時刻を保持して成功後に失敗を消す',async()=>{
 let done:(error:(Error&{killed?:boolean;code?:string})|null,output:string)=>void=()=>{};
 let calls=0,time=1000;
 const collector=createResourceCollector({platform:'win32',now:()=>time,run:(timeout,callback)=>{assert.equal(timeout,30000);calls++;done=callback}});
 const first=collector.measure(),same=collector.measure();assert.equal(calls,1);
 time=31000;done(Object.assign(Error('秘密を含む生診断'),{killed:true}), '');
 assert.equal(await first,undefined);assert.equal(await same,undefined);assert.equal(collector.latest()?.failure,'timeout');assert.equal(collector.latest()?.elapsedMs,30000);assert.doesNotMatch(collector.latest()?.reason||'',/秘密/);
 const next=collector.measure();done(null,JSON.stringify({...low,diskCapacity:50}));assert.deepEqual(await next,{...low,diskCapacity:50});assert.equal(collector.latest()?.failure,undefined);
});

test('壊れた出力・容量欠落・異常値・起動失敗・未対応OSを区別して安全側へ返す',async()=>{
 for(const output of ['不正JSON',JSON.stringify(low),JSON.stringify({...low,diskCapacity:101})]){
  const collector=createResourceCollector({platform:'win32',run:(_timeout,done)=>done(null,output)});assert.equal(await collector.measure(),undefined);assert.equal(collector.latest()?.failure,'invalid');
 }
 const failed=createResourceCollector({platform:'win32',run:()=>{throw Error('spawn失敗')}});assert.equal(await failed.measure(),undefined);assert.equal(failed.latest()?.failure,'execution');
 const unsupported=createResourceCollector({platform:'linux',run:()=>assert.fail('未対応OSで起動禁止')});assert.equal(await unsupported.measure(),undefined);assert.equal(unsupported.latest()?.failure,'unsupported');
});
