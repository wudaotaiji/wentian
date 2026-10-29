import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { registerPersonalCloud } from './personal-cloud/routes.js';
import { enrollNode, NodeAgent } from './personal-cloud/agent.js';
import { CloudRepository } from './personal-cloud/repository.js';
import { PersonalCloudService } from './personal-cloud/service.js';
import { diagnoseNode, ContainerRuntime } from './personal-cloud/runtime.js';

/** Docker実機試験（Integration Test）は明示フラグ付きだけで実行し、専用ラベルの対象を後片付けします。 */
test('実Dockerと署名付きAgentで配備・再送・更新失敗・停止・再起動・削除する',{skip:process.env.WENTIAN_CLOUD_DOCKER_TEST!=='true',timeout:240000},async()=>{
 const engine=process.env.WENTIAN_CLOUD_TEST_ENGINE==='podman'?'podman':'docker';
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-cloud-integration-'));
 const app=Fastify();let service:PersonalCloudService,agent:NodeAgent|undefined;const containers:Array<{name:string;appId:string}>=[];
 try{
  service=registerPersonalCloud(app,{file:path.join(root,'cloud.sqlite'),authorize:(_req)=>'test-owner'});
  await app.listen({host:'127.0.0.1',port:0});const server='http://127.0.0.1:'+(app.server.address() as import('node:net').AddressInfo).port;
  const code=service.issueCode('test-owner','Docker実機検証');const identity=await enrollNode(root,server,code.code);service.approve('test-owner',identity.nodeId);
  const capabilities=await diagnoseNode();assert.ok(capabilities.runtimes.some(r=>r.engine===engine&&r.ready));service.heartbeat(identity.nodeId,capabilities);
  agent=new NodeAgent(root);await agent.initialize();
  const spec={name:'専用検証アプリ',image:'docker.io/nginxinc/nginx-unprivileged:alpine',engine,containerPort:8080,healthPath:'/',cpuCores:0.2,memoryBytes:64*1024**2,gpuMemoryBytes:0,environment:{}};
  const job=service.createApp('test-owner',{nodeId:identity.nodeId,spec},'integration-create');containers.push({name:'wentian-'+job.id,appId:job.appId});
  await agent.tick();let snapshot=service.snapshot('test-owner');assert.equal(snapshot.jobs[0].status,'succeeded',JSON.stringify(snapshot.jobs[0].result));
  const localUrl=snapshot.apps[0].localUrl!;assert.match(await(await fetch(localUrl)).text(),/Welcome to nginx/);
  assert.equal(service.createApp('test-owner',{nodeId:identity.nodeId,spec},'integration-create').id,job.id);
  // 同じジョブをAgentへ直接再送しても、管理ラベルから既存コンテナを再利用します。
  assert.equal((await agent.execute(job)).state,'ready');
  const before=service.snapshot('test-owner').apps[0];const update=service.action('test-owner',job.appId,'deploy',{revision:before.revision,spec:{...spec,healthPath:'/does-not-exist'}},'integration-bad-update');
  // 正常性確認失敗の120秒上限を実機で確認します。旧版のURLは維持されます。
  containers.push({name:'wentian-'+update.id,appId:job.appId});await agent.tick();snapshot=service.snapshot('test-owner');assert.equal(snapshot.jobs[0].status,'failed');assert.match(await(await fetch(localUrl)).text(),/Welcome to nginx/);
  let revision=snapshot.apps[0].revision;service.action('test-owner',job.appId,'stop',{revision},'integration-stop');await agent.tick();assert.equal((await fetch(localUrl)).status,503);
  await agent.close();agent=new NodeAgent(root);await agent.initialize();assert.equal((await fetch(localUrl)).status,503);
  revision=service.snapshot('test-owner').apps[0].revision;service.action('test-owner',job.appId,'start',{revision},'integration-start');await agent.tick();assert.match(await(await fetch(localUrl)).text(),/Welcome to nginx/);
  revision=service.snapshot('test-owner').apps[0].revision;service.action('test-owner',job.appId,'delete',{revision},'integration-delete');await agent.tick();assert.equal(service.snapshot('test-owner').apps[0].state,'deleted');
 }finally{
  await agent?.close();await app.close();for(const item of containers){await new ContainerRuntime(engine).remove(item.name,item.appId).catch(()=>{});await new ContainerRuntime(engine).removeNetwork(item.appId).catch(()=>{});}await rm(root,{recursive:true,force:true});
 }
});
