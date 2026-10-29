import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectionMenu,selectedChoice,navigateSelection,modelChoices,agentChoices,formatSelection} from './terminal-selection.js';
import {selectCliLanguage} from './cli-language.js';

test('上下キー・番号・IDで選択し、利用不可項目と範囲外を拒否する',()=>{
 const menu=selectionMenu('model',[{id:'a',label:'模型A',detail:'登録済み'},{id:'b',label:'利用終了',detail:'利用不可',disabled:true},{id:'c',label:'モデルC',detail:'登録済み'}],'a');
 assert.equal(navigateSelection(menu,1),'/model c');assert.equal(navigateSelection(menu,1),'/model a');assert.equal(navigateSelection(menu,-1),'/model c');
 assert.equal(selectedChoice(menu,'').id,'c');assert.equal(selectedChoice(menu,'1').id,'a');assert.equal(selectedChoice(menu,'c').id,'c');
 for(const value of ['2','0','99','unknown'])assert.throws(()=>selectedChoice(menu,value));
 for(const language of ['ja','en','zh'] as const){selectCliLanguage(language);const text=formatSelection(menu,'a');assert.match(text,/模型A/);assert.match(text,/モデルC/);assert.match(text,/Ctrl\+C/);}
 selectCliLanguage('ja');
});

test('モデル一覧は認証を渡し、重複を除き、利用終了状態を維持する',async()=>{
 const choices=await modelChoices('http://gateway.test/',async(input,init)=>{assert.equal(String(input),'http://gateway.test/v1/models');assert.ok(init?.signal);return Response.json({data:[{id:'a',name:'模型A'},{id:'a'},{id:'retired',available:false,unavailableReason:'提供終了'},{}]})});
 assert.equal(choices.length,2);assert.equal(choices[1].disabled,true);
 await assert.rejects(modelChoices('http://gateway.test',async()=>new Response('',{status:401})),/401/);
 await assert.rejects(modelChoices('http://gateway.test',async()=>Response.json({error:'bad'})),/形式/);
 const items=agentChoices([{id:'goose',name:'测试Agent',state:'available',stateLabel:'',note:'',liveState:'probe_failed',freshWithin24Hours:false}]);assert.equal(items[0].id,'auto');assert.equal(items[1].disabled,true);
});

test('実CLIで両コマンドの一覧・番号選択・解除・モデル切替を行い設定を隔離保存する',{timeout:30000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-selector-cli-')),app=Fastify();t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
 app.get('/v1/models',async()=>({data:[{id:'wentian-auto/local'},{id:'fixture/model',name:'中文模型'},{id:'retired',available:false}]}));
 let requests=0;app.post('/v1/chat/completions',async req=>{requests++;assert.equal((req.body as any).model,'fixture/model');return{choices:[{message:{content:JSON.stringify({kind:'answer',language:'zh',answer:'模型切换已验证。'})}}]};});
 const ready=path.join(root,'ready.json'),management=path.join(root,'management.json');
 await writeFile(ready,JSON.stringify({readinessVersion:'1.0',refreshedAt:new Date().toISOString(),pools:{},agents:[{id:'goose',name:'测试Agent',state:'available',stateLabel:'',note:'',liveState:'healthy',connection:{mode:'native',model:'fixture/native',status:'verified',expiresAt:new Date(Date.now()+600000).toISOString()}}]}));
 await app.listen({host:'127.0.0.1',port:0});const server=`http://127.0.0.1:${(app.server.address() as any).port}`;
 const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const run=async(input:string)=>new Promise<string>((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(project,'bin/wentian.js'),'agent','--language','zh','--server',server],{cwd:root,windowsHide:true,env:{...process.env,WENTIAN_ENV_FILE:path.join(root,'missing.env'),WENTIAN_AGENT_READY_CACHE:ready,WENTIAN_AGENT_MANAGEMENT_FILE:management,WENTIAN_AGENT_CONNECTION_CACHE:path.join(root,'connections.json'),WENTIAN_CLI_SETTINGS_FILE:path.join(root,'cli.json'),WENTIAN_API_KEY:''}});let out='',err='';
  child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(Error(err)));child.stdin.end(input);
 });
 const first=await run('/model\n2\n你好\n/agent\n2\n/exit\n');assert.match(first,/中文模型/);assert.match(first,/当前模型：fixture\/model/);assert.match(first,/优先智能体：goose/);assert.equal(requests,1);assert.match(first,/模型切换已验证/);
 const {readFile}=await import('node:fs/promises');assert.equal(JSON.parse(await readFile(management,'utf8')).forcedAgent,'goose');
 const refused=await run('/agent missing\n/exit\n');assert.match(refused,/列表/);assert.equal(JSON.parse(await readFile(management,'utf8')).forcedAgent,'goose');
 await run('/model fixture/model\n/exit\n');assert.equal(JSON.parse(await readFile(management,'utf8')).forcedAgent,undefined);
 await run('/agent goose\n/agent auto\n/exit\n');assert.equal(JSON.parse(await readFile(management,'utf8')).forcedAgent,undefined);
});
