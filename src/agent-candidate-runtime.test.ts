import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildExternalAgentCommand,prepareExternalRuntime} from './external-orchestrator.js';
import type {AgentConnection} from './agent-connection-policy.js';

for(const mode of ['local','native'] as const)test(`OpenClawは旧台帳の接続先でなく検査中の${mode}候補を隔離設定へ渡す`,async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'wentian-candidate-runtime-'));
 const names=['WENTIAN_AGENT_CONNECTION_CACHE','OPENCLAW_CONFIG_PATH'],previous=names.map(name=>process.env[name]);
 t.after(async()=>{names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index]});await rm(directory,{recursive:true,force:true})});
 process.env.WENTIAN_AGENT_CONNECTION_CACHE=path.join(directory,'connections.json');process.env.OPENCLAW_CONFIG_PATH=path.join(directory,'native.json');
 await writeFile(process.env.WENTIAN_AGENT_CONNECTION_CACHE,JSON.stringify({agents:{openclaw:{mode:'local',model:'retired',baseUrl:'http://127.0.0.1:1111/v1'}}}));
 await writeFile(process.env.OPENCLAW_CONFIG_PATH,JSON.stringify({models:{providers:{configured:{baseUrl:'http://127.0.0.1:3333/v1',models:[{id:'actual'}]}}}}));
 const connection:AgentConnection={mode,model:mode==='native'?'configured/actual':'actual',baseUrl:'http://127.0.0.1:2222/v1',status:'pending',checkedAt:'',expiresAt:'',fingerprint:'',policyHash:''};
 const command=buildExternalAgentCommand('openclaw','隔離した接続確認',directory,'reviewer',{attempt:0},connection)!;
 // CLIを起動せず設定生成だけを検査します。共通ランナーの許可前副作用禁止は別の試験で検収します。
 await prepareExternalRuntime(command,{cwd:directory,agent:'openclaw',role:'connection-probe'});
 const config=JSON.parse(await readFile(path.join(directory,'.wentian/openclaw-runtime.json'),'utf8'));
 if(mode==='local'){assert.equal(config.models.providers['wentian-local'].baseUrl,connection.baseUrl);assert.equal(config.agents.defaults.model.primary,'wentian-local/actual')}
 else{assert.ok(config.models.providers.configured);assert.equal(config.models.providers['wentian-local'],undefined);assert.equal(config.agents.defaults.model.primary,'configured/actual')}
});


test('OpenClawの非対話実行は必須messageオプションで依頼を渡す',()=>{
  const command=buildExternalAgentCommand('openclaw','専用領域で接続を確認','C:/fixture','reviewer',{attempt:0},{mode:'local',model:'fixture/model',baseUrl:'http://127.0.0.1:8787/v1',status:'pending',checkedAt:'',expiresAt:'',fingerprint:'',policyHash:''})!;
  assert.ok(command.args.includes('--local'));
  for(const flag of ['exec','--cwd','--config','--state-dir','--local-model-lean'])assert.ok(!command.args.includes(flag));
  const index=command.args.indexOf('--message');assert.ok(index>=0);
  assert.equal(index+1,command.args.length-1);
  assert.match(command.args[index+1],/専用領域で接続を確認/);
});


test('OpenClawの単体書込み試験は隔離設定で必要なファイル編集だけを許可する',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'wentian-openclaw-write-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const command=buildExternalAgentCommand('openclaw','指定ファイルの限定修正',directory,'builder',{attempt:0},{mode:'local',model:'fixture',baseUrl:'http://127.0.0.1:8787/v1',status:'pending',checkedAt:'',expiresAt:'',fingerprint:'',policyHash:''})!;
 await prepareExternalRuntime(command,{cwd:directory,agent:'openclaw',role:'work-standalone'});
 const config=JSON.parse(await readFile(path.join(directory,'.wentian/openclaw-runtime.json'),'utf8'));
 assert.equal(config.agents.defaults.workspace,directory);
 assert.deepEqual(config.tools.allow,['read','write','edit','exec']);
 assert.equal(config.plugins.enabled,false);
 assert.equal(config.agents.defaults.skipBootstrap,true);
 assert.equal(config.agents.defaults.experimental.localModelLean,true);
});


test('Ollamaの子ランナーへLM Studioの接続先を混入しない',t=>{
 const old=process.env.LMSTUDIO_BASE_URL,ollama=process.env.OLLAMA_HOST;
 process.env.LMSTUDIO_BASE_URL='http://127.0.0.1:1234/v1';process.env.OLLAMA_HOST='http://127.0.0.1:11434';
 t.after(()=>{if(old===undefined)delete process.env.LMSTUDIO_BASE_URL;else process.env.LMSTUDIO_BASE_URL=old;if(ollama===undefined)delete process.env.OLLAMA_HOST;else process.env.OLLAMA_HOST=ollama;});
 const command=buildExternalAgentCommand('ollama','限定修正','C:/fixture','builder',{attempt:0},{mode:'native',model:'fixture-cloud',status:'pending',checkedAt:'',expiresAt:'',fingerprint:'',policyHash:''})!;
 assert.equal(command.args.at(-1),'http://127.0.0.1:11434');
 assert.ok(!command.args.includes('http://127.0.0.1:1234/v1'));
});
