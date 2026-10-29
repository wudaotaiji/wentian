import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const execute = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('実装説明は資料未取得の再質問を完了扱いにせず、ホストの読取結果を得て回答する',{timeout:30000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-grounded-cli-')),app=Fastify();await writeFile(path.join(root,'source.ts'),'export const implementation = "fixture-evidence";');let calls=0;
 app.get('/api/mcp/agent-tools',async()=>({tools:[]}));
 app.post('/v1/chat/completions',async req=>{
  const body=req.body as any;
  if(req.headers['x-wentian-decision-kind'])return{choices:[{message:{content:JSON.stringify({kind:'task',plan:{intent:'local_tool',operation:'read',evidence_source:'workspace',language:'zh',required_capabilities:['file_read'],tools:['read_file'],delegation:{enabled:false}}})}}]};
  calls++;if(calls===1)return{choices:[{message:{content:'请告诉我应该检查的项目目录。'}}]};
  if(calls===2){assert.equal(body.tool_choice,'required');return{choices:[{message:{role:'assistant',tool_calls:[{id:'read',type:'function',function:{name:'read_file',arguments:'{"path":"source.ts"}'}}]}}]};}
  assert.ok(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('fixture-evidence')));return{choices:[{message:{content:'实现由source.ts中的fixture-evidence声明，已读取文件。'}}]};
 });
 try{
  await app.listen({host:'127.0.0.1',port:0});
  const result=await execute(process.execPath,[path.join(project,'bin/wentian.js'),'agent','--mode','direct','--server',`http://127.0.0.1:${(app.server.address() as any).port}`,'--model','fixture/model','--','解释这个项目的机制'],{cwd:root,timeout:20000,env:{...process.env,WENTIAN_ENV_FILE:path.join(root,'missing.env'),WENTIAN_API_KEY:''}});
  assert.equal(calls,3);assert.match(result.stdout,/fixture-evidence/);assert.doesNotMatch(result.stdout,/请告诉我应该检查的项目目录/);
 }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
});

test('実CLIの--languageは回答指示と端末表示へ適用し、JSONの機械可読形式を保持する',{timeout:30000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-cli-locales-')),app=Fastify();
 let expected='ja',calls=0;
 const answers:Record<string,string>={ja:'こんにちは！',en:'Hello!',zh:'你好！'};
 app.post('/v1/chat/completions',async req=>{
  calls++;const body=req.body as any;assert.ok(body.messages[0].content.includes('設定言語: '+expected));
  assert.ok(body.messages.at(-1).content.includes('fixture prompt'));
  assert.ok(!body.messages.at(-1).content.includes('--language'));
  return {model:'fixture/model',choices:[{message:{content:JSON.stringify({kind:'answer',language:expected,answer:answers[expected]})}}]};
 });
 try{
  await app.listen({host:'127.0.0.1',port:0});
  const env={...process.env,WENTIAN_ENV_FILE:path.join(root,'missing.env'),WENTIAN_RESPONSE_LANGUAGE:'',WENTIAN_CLI_SETTINGS_FILE:path.join(root,'cli.json'),WENTIAN_AGENT_MANAGEMENT_FILE:path.join(root,'management.json'),WENTIAN_TRAINING_ROOT:path.join(root,'training')};
  for(const [language,title,final]of [['ja','回答','最終結果'],['en','Answer','Final result'],['zh','回答','最终结果']]){
   expected=language;
   const args=[path.join(project,'bin/wentian.js'),'agent','--language',language,'--server',`http://127.0.0.1:${(app.server.address() as any).port}`,'--model','fixture/model','--','fixture prompt'];
   const result=await execute(process.execPath,args,{cwd:root,timeout:15000,env});
   assert.ok(result.stdout.includes('╭─ '+title));assert.ok(result.stdout.includes(final));assert.ok(result.stdout.includes(answers[language]));
   if(language==='en')assert.doesNotMatch(result.stdout,/[\u3040-\u30ff\u3400-\u9fff]/);
   if(language==='zh')assert.doesNotMatch(result.stdout,/[\u3040-\u30ff]/);
   const json=await execute(process.execPath,[...args.slice(0,-2),'--json','--','fixture prompt'],{cwd:root,timeout:15000,env});
   assert.equal(JSON.parse(json.stdout).status,'success');
  }
  expected='zh';await writeFile(env.WENTIAN_CLI_SETTINGS_FILE,JSON.stringify({version:1,language:'zh'}));
  const saved=await execute(process.execPath,[path.join(project,'bin/wentian.js'),'agent','--server',`http://127.0.0.1:${(app.server.address() as any).port}`,'--model','fixture/model','--','fixture prompt'],{cwd:root,timeout:15000,env});
  assert.ok(saved.stdout.includes('最终结果'));assert.equal(calls,7);
 }finally{await app.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('実CLIの普通会話は一回のHTTPだけで中文回答し、作業計画と台帳を作らない', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-chat-cli-')), app = Fastify();
  let calls = 0;
  app.post('/v1/chat/completions', async req => {
    calls++; assert.equal(req.headers['x-wentian-decision-kind'], 'conversation-turn');
    assert.equal((req.body as any).tools, undefined);
    return { model: 'actual/model', wentian: { resolved_model: 'actual/model', provider: 'fixture-provider' }, choices: [{ message: { content: JSON.stringify({ kind: 'answer', language: 'zh', answer: '你好！有什么可以帮你？' }) } }] };
  });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const result = await execute(process.execPath, [path.join(project, 'bin/wentian.js'), 'agent', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--model', 'fixture/model', '--', '你好！'], { cwd: root, timeout: 20000, env: { ...process.env, WENTIAN_ENV_FILE: path.join(root, 'missing.env'), WENTIAN_API_KEY: '', WENTIAN_TRAINING_ROOT: path.join(root, 'training') } });
    assert.equal(calls, 1); assert.match(result.stdout, /你好！有什么可以帮你/);
    assert.match(result.stdout, /Agent: Wentian Gateway.*Model: actual\/model.*Provider: fixture-provider.*\d+\.\d+s/);
    const json = await execute(process.execPath, [path.join(project, 'bin/wentian.js'), 'agent', '--json', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--model', 'fixture/model', '--', '你好！'], { cwd: root, timeout: 20000, env: { ...process.env, WENTIAN_ENV_FILE: path.join(root, 'missing.env'), WENTIAN_API_KEY: '' } });
    const outcome = JSON.parse(json.stdout);
    assert.equal(outcome.execution.model, 'actual/model'); assert.ok(outcome.execution.elapsedMs >= 0);
    assert.doesNotMatch(result.stdout, /Planning summary|Task orchestration|Builder|Tester|Verifier|日本語でご依頼/);
    await assert.rejects(readdir(path.join(root, '.wentian', 'orchestration', 'runs')));
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('実CLIのAI作業判断は再分類せず読取りへ進み、書込みは許可範囲の検査で止める', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-task-cli-')), app = Fastify();
  let decisions = 0, answers = 0, write = false;
  await writeFile(path.join(root, 'README.md'), '試験資料です。');
  app.get('/api/mcp/agent-tools', async () => ({ tools: [] }));
  app.post('/v1/chat/completions', async req => {
    const body = req.body as any;
    if (req.headers['x-wentian-decision-kind']) {
      assert.equal(req.headers['x-wentian-decision-kind'], 'conversation-turn'); decisions++;
      return { choices: [{ message: { content: JSON.stringify({ kind: 'task', plan: { intent: 'local_tool', operation: write ? 'write' : 'read', language: 'zh', evidence_source: 'workspace', required_capabilities: [write ? 'file_write' : 'file_read'], tools: [write ? 'write_file' : 'read_file'], delegation: { enabled: false } } }) } }] };
    }
    answers++;
    if (!body.messages.some((m: any) => m.role === 'tool')) return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] } }] };
    assert.match(body.messages.at(-1).content, /試験資料/);
    return { choices: [{ message: { role: 'assistant', content: '已读取试验资料。' } }] };
  });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const args = [path.join(project, 'bin/wentian.js'), 'agent', '--server', `http://127.0.0.1:${(app.server.address() as any).port}`, '--model', 'fixture/model'];
    const options = { cwd: root, timeout: 20000, env: { ...process.env, WENTIAN_ENV_FILE: path.join(root, 'missing.env'), WENTIAN_API_KEY: '' } };
    const read = await execute(process.execPath, [...args, '--', '读取项目资料'], options);
    assert.match(read.stdout, /已读取试验资料/); assert.equal(decisions, 1); assert.equal(answers, 2);
    write = true;
    const blocked = await execute(process.execPath, [...args, '--json', '--', '修改项目'], options).catch(error => error);
    assert.equal(JSON.parse(blocked.stdout).status, 'needs_review'); assert.equal(decisions, 2); assert.equal(answers, 2);
  } finally { await app.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
