import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { assertChatFilePath, explicitUserFiles, isPublicWebAddress, registerChatAgent, resolveChatReadPath, runChatAgent, type ChatEvent } from './chat-agent.js';

test('Webツールは内部・予約・IPv4埋込IPv6を拒否する',()=>{
 for(const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','100.64.1.1','192.168.1.1','::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::'])assert.equal(isPublicWebAddress(ip),false,ip);
 assert.equal(isPublicWebAddress('8.8.8.8'),true);assert.equal(isPublicWebAddress('2606:4700:4700::1111'),true);
});

test('Planの不正書込み要求は実行せず、読取り結果をモデルへ渡す',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-chat-test-'));await writeFile(path.join(root,'input.txt'),'READ_OK');const events:ChatEvent[]=[];let step=0;
 const answer=await runChatAgent({mode:'plan',model:'test',messages:[{role:'user',content:'調査'}],allowedWritePaths:['output.txt']},root,async body=>{
  if(step++===0)return{choices:[{message:{role:'assistant',tool_calls:[{id:'bad',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'output.txt',content:'禁止'})}},{id:'read',type:'function',function:{name:'read_file',arguments:'{"path":"input.txt"}'}}]}}],usage:{total_tokens:100}};
  const messages=body.messages as any[];assert.match(messages.at(-2).content,/許可していない/);assert.equal(messages.at(-1).content,'READ_OK');return{choices:[{message:{content:'計画完了'}}],usage:{total_tokens:100}};
 },e=>events.push(e),new AbortController().signal);
 assert.equal(answer,'計画完了');assert.equal(events.find(e=>e.callId==='bad'&&e.type==='tool_result')?.success,false);await assert.rejects(readFile(path.join(root,'output.txt')));
});

test('Actは指定ファイルだけに書き、結果を証拠として返す',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-chat-test-'));const events:ChatEvent[]=[];let step=0;
 await runChatAgent({mode:'act',model:'test',messages:[{role:'user',content:'作成'}],allowedWritePaths:['output.txt']},root,async()=>step++===0?{choices:[{message:{role:'assistant',tool_calls:[{id:'write',type:'function',function:{name:'write_file',arguments:'{"path":"output.txt","content":"ACT_OK"}'}}]}}],usage:{total_tokens:100}}:{choices:[{message:{content:'作成済み'}}],usage:{total_tokens:100}},e=>events.push(e),new AbortController().signal);
 assert.equal(await readFile(path.join(root,'output.txt'),'utf8'),'ACT_OK');assert.equal(events.find(e=>e.type==='tool_result')?.success,true);
 for(const name of ['../outside.txt','.env','.wentian/secret.txt','.git/config','key.pem'])assert.throws(()=>assertChatFilePath(root,name));
});

test('Actの許可外ファイルと無限ツールループを拒否する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-chat-test-'));const events:ChatEvent[]=[];
 await assert.rejects(runChatAgent({mode:'act',model:'test',messages:[{role:'user',content:'作成'}],allowedWritePaths:['allowed.txt']},root,async()=>({choices:[{message:{role:'assistant',tool_calls:[{id:'write',type:'function',function:{name:'write_file',arguments:'{"path":"outside.txt","content":"不可"}'}}]}}],usage:{total_tokens:100}}),e=>events.push(e),new AbortController().signal),/実行予算/);
 assert.equal(events.filter(e=>e.type==='tool_result').every(e=>e.success===false),true);await assert.rejects(readFile(path.join(root,'outside.txt')));
});

test('会話実行APIは認証・オリジン検査後にSSEで実行結果を返す',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-chat-test-'));await writeFile(path.join(root,'input.txt'),'API_READ_OK');const app=Fastify();let step=0;
 registerChatAgent(app,{workspace:root,authorize:(req,reply)=>{if(req.headers['x-api-key']==='test-key')return true;reply.code(401).send({error:{message:'認証が必要です。'}});return false}});
 app.post('/v1/chat/completions',async()=>step++===0?{choices:[{message:{role:'assistant',tool_calls:[{id:'read',type:'function',function:{name:'read_file',arguments:'{"path":"input.txt"}'}}]}}],usage:{total_tokens:100}}:{choices:[{message:{content:'API_READ_OK'}}],usage:{total_tokens:100}});
 try{
  const payload={mode:'plan',model:'test',messages:[{role:'user',content:'調査'}],allowedWritePaths:[]};
  assert.equal((await app.inject({method:'POST',url:'/api/chat/agent',payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/chat/agent',headers:{'x-api-key':'test-key',origin:'https://attacker.example'},payload})).statusCode,403);
  const result=await app.inject({method:'POST',url:'/api/chat/agent',headers:{'x-api-key':'test-key'},payload});assert.equal(result.statusCode,200);assert.match(result.body,/tool_result/);assert.match(result.body,/API_READ_OK/);assert.match(result.body,/"type":"final"/);
 }finally{await app.close()}
});

test('明示された外部ファイルだけを読み、モデル発言・添付資料で権限を広げない',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-chat-test-'));const other=await mkdtemp(path.join(os.tmpdir(),'wentian-chat-outside-'));const file=path.join(other,'input.txt');await writeFile(file,'EXTERNAL_READ_OK');
 assert.throws(()=>resolveChatReadPath(root,file));assert.equal(resolveChatReadPath(root,file,[file]),file);assert.throws(()=>resolveChatReadPath(root,path.join(other,'other.txt'),[file]));
 if(process.platform==='win32'){
  assert.deepEqual(explicitUserFiles([{role:'user',content:`"${file}"を読んで`},{role:'assistant',content:'"C:\\秘密.txt"'}]),[file]);
  assert.deepEqual(explicitUserFiles([{role:'user',content:'質問\n以下は添付ファイルの内容です。"C:\\秘密.txt"'}]),[]);
 }
});

test('指定画像の実データを最初のモデル要求へ渡し、画面へBase64を出さない',async()=>{
 if(process.platform!=='win32')return;
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-chat-test-'));const other=await mkdtemp(path.join(os.tmpdir(),'wentian-chat-outside-'));const file=path.join(other,'red.png');
 await writeFile(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=','base64'));const events:ChatEvent[]=[];
 await runChatAgent({mode:'plan',model:'vision-test',messages:[{role:'user',content:`"${file}"の内容は？`}],allowedWritePaths:[]},root,async body=>{assert.equal(body.wentian_requires_vision,true);assert.equal((body.messages as any[]).at(-1).content[1].image_url.url.startsWith('data:image/png;base64,'),true);return{choices:[{message:{content:'画像確認済み'}}],usage:{total_tokens:100}}},e=>events.push(e),new AbortController().signal);
 assert.equal(events.some(e=>e.name==='read_image'&&e.success===true),true);assert.equal(JSON.stringify(events).includes('base64'),false);
});
