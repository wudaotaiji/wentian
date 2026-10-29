import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mediaAgentContext, readMediaCapabilitySnapshot } from './media-agent-capabilities.js';
import { runChatAgent } from './chat-agent.js';

test('制作能力はモデル未準備と区別し、小型モデルを実用品質として案内しない',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-media-context-'));
 try{const options={audioRoot:path.join(root,'audio'),videoRoot:path.join(root,'video'),python:path.join(root,'python')};let snapshot=await readMediaCapabilitySnapshot(options);assert.equal(snapshot.implemented,true);assert.equal(snapshot.models.video.prepared,false);assert.equal(snapshot.pythonPrepared,false);
 await mkdir(options.videoRoot,{recursive:true});await writeFile(options.python,'試験用');await writeFile(path.join(options.videoRoot,'weights.safetensors'),'ready');await writeFile(path.join(options.videoRoot,'wentian-model.json'),JSON.stringify({verificationOnly:true,files:{'weights.safetensors':5}}));snapshot=await readMediaCapabilitySnapshot(options);assert.equal(snapshot.models.video.prepared,true);assert.equal(snapshot.models.video.verificationOnly,true);assert.equal(snapshot.executionDiagnosed,false);
 const context=await mediaAgentContext(snapshot);assert.match(context,/inspect_media_capabilities/);assert.match(context,/実用品質の動画は生成できません/);assert.match(context,/生成・編集の直接実行ツールは現在公開していない/);assert.match(context,/media-studio#examples/);
 await writeFile(path.join(options.videoRoot,'weights.safetensors'),'broken');assert.equal((await readMediaCapabilitySnapshot(options)).models.video.prepared,false);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('Web会話は制作能力・制限をモデルへ通知し、Planでも診断結果を返す',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-media-chat-'));let step=0,diagnosed=false;
 try{const answer=await runChatAgent({mode:'plan',model:'test',messages:[{role:'user',content:'听说你有制作视频音频的能力了？'}],allowedWritePaths:[]},root,async body=>{
  const messages=body.messages as any[],tools=body.tools as any[];assert.match(messages[0].content,/Wentianに実装済みの制作能力/);assert.match(messages[0].content,/verificationOnly/);assert.ok(tools.some(t=>t.function.name==='inspect_media_capabilities'));assert.ok(!tools.some(t=>['write_file','create_media'].includes(t.function.name)));
  if(step++===0)return {choices:[{message:{role:'assistant',tool_calls:[{id:'media-diagnosis',type:'function',function:{name:'inspect_media_capabilities',arguments:'{}'}}]}}],usage:{total_tokens:100}};
  assert.equal(JSON.parse(messages.at(-1).content).media.features.speech.ready,true);return {choices:[{message:{content:'Wentianには音声・動画制作機能があります。制作画面を利用できます。小型動画モデルは検証専用です。'}}],usage:{total_tokens:100}};
 },()=>{},new AbortController().signal,async call=>{assert.equal(call.function.name,'inspect_media_capabilities');diagnosed=true;return JSON.stringify({implemented:true,executionDiagnosed:true,media:{features:{speech:{ready:true}}},video:{ready:true,verificationOnly:true}})});
 assert.equal(diagnosed,true);assert.match(answer,/制作機能があります/);
 }finally{await rm(root,{recursive:true,force:true})}
});
