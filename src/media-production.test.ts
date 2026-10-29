import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { MediaService, registerMediaProduction, validateMediaInput, type MediaRunner } from './media-production.js';
import { VideoService } from './video-generation.js';
import { Script } from 'node:vm';
import { mediaProductionHtml } from './media-production-ui.js';

const ready=async()=>({ready:true,message:'試験専用',voices:[],features:Object.fromEntries(['speech','editing','music','sound','transcribe'].map(k=>[k,{ready:true,message:'試験専用'}]))});
// 単体試験のダミー素材です。実際の生成・再生の検証には別の実ワーカー試験を使用します。
const bytes=Buffer.from('RIFF試験専用の音声素材');
const runner:MediaRunner=async(dir,progress)=>{await writeFile(path.join(dir,'output.wav'),bytes);await writeFile(path.join(dir,'output.mp3'),bytes);await writeFile(path.join(dir,'result.json'),JSON.stringify({duration:1,hasAudio:true}));progress(99,'試験完了')};
async function wait(service:MediaService,id:string){for(let n=0;n<200;n++){const j=service.get('owner',id);if(j.status==='succeeded')return;assert.notEqual(j.status,'failed',j.error||'制作失敗');await new Promise(r=>setTimeout(r,10))}assert.fail('制作が完了しません。')}

test('制作設定は任意パスとコマンドを拒否し、音声・トラックの上限を守る',()=>{
 for(const match of mediaProductionHtml.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Script(match[1]));
 assert.equal(validateMediaInput({kind:'speech',text:'こんにちは'}).mediaType,'audio');
 for(const bad of [{kind:'speech',text:''},{kind:'sound',prompt:'波',duration:16},{kind:'music',prompt:'波',duration:31},{kind:'speech',text:'声',command:'cmd.exe'},{kind:'mix',tracks:[]},{kind:'mix',tracks:[{id:'../other'}]},{kind:'transcribe',sourceId:'https://example.com/a.wav'}])assert.throws(()=>validateMediaInput(bad));
});

test('完成素材を永続化し、編集時に複製して元素材削除との競合と所有者越境を防ぐ',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-media-'));let service=await MediaService.open(root,runner,ready);
 try{service.start();const speech=await service.create('owner',{kind:'speech',text:'こんにちは'});await wait(service,speech.id);
 assert.throws(()=>service.get('other',speech.id));await assert.rejects(service.source('other',speech.id,'audio'));
 const mix=await service.create('owner',{kind:'mix',tracks:[{id:speech.id}],duration:2});await wait(service,mix.id);assert.deepEqual(await readFile(path.join(root,mix.id,'track-0.audio')),bytes);await service.remove('owner',speech.id);assert.deepEqual(await readFile(path.join(root,mix.id,'track-0.audio')),bytes);
 await service.close();service=await MediaService.open(root,runner,ready);assert.equal(service.get('owner',mix.id).status,'succeeded');await assert.rejects(service.output('owner',mix.id,'../../request.json'));await service.remove('owner',mix.id);assert.equal(service.list('owner').length,0);
 }finally{await service.close();await rm(root,{recursive:true,force:true})}
});

test('制作上限、待機取消、実行取消、未準備モデルを個別に検査する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-media-queue-'));const slow:MediaRunner=async(_dir,_progress,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('取消')),{once:true}));const service=await MediaService.open(root,slow,ready);
 try{const jobs=await Promise.all(Array.from({length:10},()=>service.create('owner',{kind:'speech',text:'声'}).catch(e=>e)));assert.equal(jobs.filter(j=>j instanceof Error).length,2);const list=service.list('owner').reverse();await service.cancel('owner',list[1].id);assert.equal(service.get('owner',list[1].id).status,'cancelled');service.start();await assert.rejects(service.remove('owner',list[0].id));await service.cancel('owner',list[0].id);
 }finally{await service.close();await rm(root,{recursive:true,force:true})}
 const missing=await MediaService.open(await mkdtemp(path.join(os.tmpdir(),'wentian-media-model-')),runner,async()=>({...await ready(),features:{editing:{ready:true,message:'編集可能'},music:{ready:false,message:'BGM未取得'}}}));try{await assert.rejects(missing.create('owner',{kind:'music',prompt:'piano'}),/BGM未取得/)}finally{await missing.close();await rm(missing.root,{recursive:true,force:true})}
});

test('制作APIは認証、所有者、外部Origin、形式とRangeを検査する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-media-api-')),app=Fastify();const registered=registerMediaProduction(app,{root,runner,diagnose:ready,authorize:(req,reply)=>{const owner=req.headers['x-test-owner'];if(typeof owner==='string')return owner;reply.code(401).send({error:{message:'ログインが必要です。'}})}});const headers={'x-test-owner':'owner'};
 try{assert.equal((await app.inject('/api/media')).statusCode,401);assert.equal((await app.inject({url:'/api/media',headers:{...headers,origin:'https://external.example'}})).statusCode,403);assert.equal((await app.inject({url:'/api/media',headers:{...headers,'x-team-virtual-key':'x'}})).statusCode,403);
 const created=await app.inject({method:'POST',url:'/api/media',headers,payload:{kind:'speech',text:'声'}});assert.equal(created.statusCode,202);const service=await registered.service();service.start();const id=created.json().id;await wait(service,id);
 assert.equal((await app.inject({url:'/api/media/'+id+'/content',headers:{'x-test-owner':'other'}})).statusCode,404);const range=await app.inject({url:'/api/media/'+id+'/content',headers:{...headers,range:'bytes=0-3'}});assert.equal(range.statusCode,206);assert.equal(range.rawPayload.toString(),'RIFF');assert.equal((await app.inject({url:'/api/media/'+id+'/content',headers:{...headers,range:'bytes=-0'}})).statusCode,416);
 const download=await app.inject({url:'/api/media/'+id+'/content?format=mp3&download=1',headers});assert.match(String(download.headers['content-disposition']),/\.mp3/);assert.equal((await app.inject({url:'/api/media/'+id+'/content?format=sqlite',headers})).statusCode,400);
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
});

test('動画生成で選択した音声も所有者検査後に複製する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-video-audio-')),audio=path.join(root,'audio.wav');await writeFile(audio,bytes);const service=await VideoService.open(path.join(root,'videos'),undefined,async()=>({ready:true,message:'試験'}),async(owner)=>{if(owner!=='owner')throw new Error('所有者が異なります。');return audio});
 try{const id='11111111-1111-1111-1111-111111111111';const job=await service.create('owner',{prompt:'風景',audioJobId:id,audioVolume:0.5});assert.deepEqual(await readFile(path.join(root,'videos',job.id,'soundtrack.audio')),bytes);await assert.rejects(service.create('other',{prompt:'風景',audioJobId:id}));await service.cancel('owner',job.id);await service.remove('owner',job.id);
 }finally{await service.close();await rm(root,{recursive:true,force:true})}
});
