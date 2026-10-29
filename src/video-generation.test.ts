import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { VideoService, VideoError, registerVideoGeneration, validateVideoInput, type VideoRunner } from './video-generation.js';
import { videoGenerationHtml } from './video-generation-ui.js';
import { navigationRail } from './navigation-ui.js';

const input={prompt:'海辺をゆっくり移動する',width:256,height:256,frames:9,fps:8,steps:2,seed:42};
const ready=async()=>({ready:true,message:'試験用エンジン'});
// 単体試験用MP4ヘッダーです。推論成功や再生成功の証拠には使用しません。
const fixture=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(64)]);
const runner:VideoRunner=async(dir,_input,progress)=>{progress(50,'試験処理中');await writeFile(path.join(dir,'output.mp4'),fixture)};
async function waitFor(service:VideoService,owner:string,id:string,status:string){for(let n=0;n<100;n++){if(service.get(owner,id).status===status)return;await new Promise(resolve=>setTimeout(resolve,10))}assert.equal(service.get(owner,id).status,status)}

test('動画設定は解像度・時間・画像容量を検査し、任意の実行設定を拒否する',()=>{
 assert.equal(validateVideoInput(input).seed,42);
 for(const bad of [{...input,width:257},{...input,frames:10},{...input,steps:100},{...input,seed:-1},{...input,prompt:''},{...input,command:'cmd.exe'},{...input,image:'https://example.com/test.png'},{...input,image:'data:image/png;base64,YWJj'}])assert.throws(()=>validateVideoInput(bad),VideoError);
 assert.match(videoGenerationHtml,/動画を生成/);assert.match(videoGenerationHtml,/<video|createElement\('video'\)/);assert.match(navigationRail(),/href="\/videos"/);
});

test('動画の生成結果を保存し、所有者境界・永続化・削除を守る',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-video-test-'));let service:VideoService|undefined;
 try{service=await VideoService.open(root,runner,ready);const job=await service.create('owner',input);assert.equal(service.list('other').length,0);assert.throws(()=>service!.get('other',job.id),/見つかりません/);service.start();await waitFor(service,'owner',job.id,'succeeded');assert.equal(service.get('owner',job.id).progress,100);assert.deepEqual(await readFile((await service.output(job.id)).file),fixture);
 await assert.rejects(VideoService.open(root,runner,ready),/別のプロセス/);await service.close();service=await VideoService.open(root,runner,ready);assert.equal(service.get('owner',job.id).status,'succeeded');await service.remove('owner',job.id);assert.equal(service.list('owner').length,0);
 }finally{await service?.close();await rm(root,{recursive:true,force:true})}
});

test('完成した動画を元条件のまま改善再生成し、元ファイルを保持する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-video-retry-'));
 const service=await VideoService.open(root,runner,ready);
 try{service.start();const original=await service.create('owner',input);await waitFor(service,'owner',original.id,'succeeded');const source=await service.output(original.id);const retry=await service.retry('owner',original.id);assert.notEqual(retry.id,original.id);assert.equal(retry.input.prompt,input.prompt);await waitFor(service,'owner',retry.id,'succeeded');assert.deepEqual(await readFile(source.file),fixture);await assert.rejects(service.retry('other',original.id),/見つかりません/);}finally{await service.close();await rm(root,{recursive:true,force:true})}
});

test('生成は逐次実行し、待機中・実行中の取消と上限を守る',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-video-queue-'));let concurrent=0,max=0;
 const slow:VideoRunner=async(_dir,_input,_progress,signal)=>{concurrent++;max=Math.max(max,concurrent);try{await new Promise<void>((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('取消')),{once:true})})}finally{concurrent--}};
 const service=await VideoService.open(root,slow,ready);
 try{const jobs=await Promise.all(Array.from({length:12},()=>service.create('owner',input).catch(e=>e)));assert.equal(jobs.filter(j=>j instanceof VideoError).length,4);const accepted=service.list('owner').reverse();service.start();await waitFor(service,'owner',accepted[0].id,'running');await assert.rejects(service.remove('owner',accepted[0].id),/取り消し/);await service.cancel('owner',accepted[1].id);assert.equal(service.get('owner',accepted[1].id).status,'cancelled');await service.cancel('owner',accepted[0].id);await waitFor(service,'owner',accepted[0].id,'cancelled');assert.equal(max,1);
 }finally{await service.close();await rm(root,{recursive:true,force:true})}
});

test('再起動時の生成中を成功扱いにせず、未準備環境では受け付けない',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-video-recovery-'));let service=await VideoService.open(root,runner,ready);
 try{const job=await service.create('owner',input);await service.close();const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(root,'videos.sqlite'));db.prepare('UPDATE jobs SET value=? WHERE id=?').run(JSON.stringify({...job,status:'running'}),job.id);db.close();service=await VideoService.open(root,runner,async()=>({ready:false,message:'モデル未準備'}));assert.equal(service.get('owner',job.id).status,'failed');await assert.rejects(service.create('owner',input),/モデル未準備/);
 }finally{await service.close();await rm(root,{recursive:true,force:true})}
});

test('動画APIは認証・外部Origin・Range再生・ダウンロードを検査する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-video-routes-')),app=Fastify();
 const registered=registerVideoGeneration(app,{root,runner,diagnose:ready,authorize:(req,reply)=>{const owner=req.headers['x-test-owner'];if(typeof owner==='string')return owner;reply.code(401).send({error:{message:'ログインが必要です。'}});}});
 try{
 assert.equal((await app.inject('/api/videos')).statusCode,401);assert.equal((await app.inject({url:'/api/videos',headers:{'x-test-owner':'owner',origin:'https://external.example'}})).statusCode,403);assert.equal((await app.inject({url:'/api/videos',headers:{'x-test-owner':'owner','x-team-virtual-key':'x'}})).statusCode,403);
 const created=await app.inject({method:'POST',url:'/api/videos',headers:{'x-test-owner':'owner'},payload:input});assert.equal(created.statusCode,202);const service=await registered.service();service.start();const job=created.json();await waitFor(service,'owner',job.id,'succeeded');
 assert.equal((await app.inject({url:'/api/videos/'+job.id+'/content',headers:{'x-test-owner':'other'}})).statusCode,404);
 assert.equal((await app.inject({method:'POST',url:'/api/videos/'+job.id+'/retry',headers:{'x-test-owner':'other'},payload:{}})).statusCode,404);
 const retried=await app.inject({method:'POST',url:'/api/videos/'+job.id+'/retry',headers:{'x-test-owner':'owner'},payload:{}});assert.equal(retried.statusCode,202);assert.notEqual(retried.json().id,job.id);await waitFor(service,'owner',retried.json().id,'succeeded');assert.deepEqual(await readFile((await service.output(job.id)).file),fixture);
 const partial=await app.inject({url:'/api/videos/'+job.id+'/content',headers:{'x-test-owner':'owner',range:'bytes=0-11'}});assert.equal(partial.statusCode,206);assert.equal(partial.rawPayload.length,12);assert.equal(partial.headers['content-range'],'bytes 0-11/'+fixture.length);
 assert.equal((await app.inject({url:'/api/videos/'+job.id+'/content',headers:{'x-test-owner':'owner',range:'bytes=99999-'}})).statusCode,416);
 const download=await app.inject({url:'/api/videos/'+job.id+'/content?download=1',headers:{'x-test-owner':'owner'}});assert.match(String(download.headers['content-disposition']),/attachment/);assert.equal(download.headers['cache-control'],'private, no-store');assert.deepEqual(download.rawPayload,fixture);
 }finally{await app.close();await rm(root,{recursive:true,force:true})}
});
