import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { MailOperationsService, registerMailOperations } from './mail-operations.js';
import { MailTrainingService } from './mail-training.js';
import { MailTaxonomyStore } from './mail-taxonomy.js';
import { createMailCategoryProposer } from './mail-ai.js';

test('AI接続は正式な自動選択モデル名で直接推論し、実モデル名と失敗を返す',async()=>{
  let request:any;
  const propose=createMailCategoryProposer(async payload=>{request=payload;return {statusCode:200,json:()=>({choices:[{message:{content:'{"suggestions":[]}'}}],wentian:{resolved_model:'provider/model'}})};});
  const result=await propose({subject:'test',body:'data',instruction:'',categories:[]});
  assert.equal(request.model,process.env.WENTIAN_MAIL_PROPOSAL_MODEL||'wentian-auto/all');
  assert.equal(request.wentian_execution_mode,'direct');assert.equal(result.model,'provider/model');
  const failed=createMailCategoryProposer(async()=>({statusCode:503,json:()=>({error:{message:'利用不可'}})}));
  await assert.rejects(failed({subject:'test',body:'data',instruction:'',categories:[]}),/利用不可/);
});

/** 本番メールを変更せず、永続化・AI判断・同時編集の境界を検証します。 */
async function fixture(propose?: any) {
  const root = await mkdtemp(path.join(os.tmpdir(),'mail-taxonomy-'));
  const training = new MailTrainingService(path.join(root,'training'));
  const service = new MailOperationsService(path.join(root,'mail'),training,{propose});
  const source = service.saveSource({name:'分類検証',type:'archive'},'test');
  const message = (await service.ingest(source.id,Buffer.from('From: test@example.invalid\r\nSubject: Support incident\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPassword: fixture-secret\nInfrastructure incident follow-up\n'))).message;
  return {root,service,training,message,async close(){await service.close();await rm(root,{recursive:true,force:true});}};
}

test('自由分類を保存・改名してもIDが維持され、再起動後のレビューと学習へ渡せる',async()=>{
  const f=await fixture();try{
    const added=await f.service.saveCategory({revision:0,name:'営業 / 保守 / 障害対応',profileKind:'other'},'test');
    const item=added.category;
    const message=f.service.review(f.message.id,{revision:f.message.revision,labelPath:item.path,profileKind:'other',fields:{}},'test');
    await f.service.trainingExample(message.id,'classification','test');
    const renamed=await f.service.saveCategory({revision:1,path:item.path,name:'保守 / 障害報告',profileKind:'other'},'test');
    assert.deepEqual(renamed.category.path,item.path);
    assert.equal(new MailTaxonomyStore(f.training.taxonomy.file).category(item.path).name,'保守 / 障害報告');
    assert.equal((await f.training.status()).examples.classification,1);
    await assert.rejects(f.service.saveCategory({revision:1,name:'古い更新',profileKind:'other'},'test'),/別の画面/);
    await assert.rejects(f.training.importExamples('classification',[{mail_id:'unknown',subject:'test',reviewed:true,label_path:['unknown']}]),/存在しない/);
  }finally{await f.close();}
});

test('AIが新分類を自動追加し判断を保存するが、確認済み教師例は捏造しない',async()=>{
  let prompt:any;
  const f=await fixture(async(input:any)=>{prompt=input;return {model:'fixture-ai',content:JSON.stringify({suggestions:[{name:'保守 / 障害対応',profileKind:'other',reason:'障害への対応を報告するメールです。'}]})};});try{
    const result=await f.service.classifyWithAI(f.message.id,{revision:f.message.revision},'test');
    assert.equal(result.classificationOrigin,'ai');assert.equal(result.classificationModel,'fixture-ai');
    assert.equal(result.status,'analyzed');assert.equal(result.reviewedBy,null);assert.equal(result.score,null);
    assert.equal(f.training.taxonomy.category(result.labelPath).name,'保守 / 障害対応');
    assert.ok(!prompt.body.includes('fixture-secret'));assert.ok(prompt.body.includes('[REDACTED]'));
    await assert.rejects(f.service.trainingExample(result.id,'classification','test'),/人が確認/);
    await assert.rejects(f.service.classifyWithAI(result.id,{revision:f.message.revision},'test'),/別の操作/);
  }finally{await f.close();}
});

test('AI推論中に人が修正した内容を上書きせず、不正なAI応答を成功扱いにしない',async()=>{
  let release:any,started:any;
  const ready=new Promise<void>(resolve=>started=resolve),waiting=new Promise<string>(resolve=>release=resolve);
  const f=await fixture(async()=>{started();return {model:'fixture-ai',content:await waiting};});try{
    const pending=f.service.classifyWithAI(f.message.id,{revision:f.message.revision},'test');
    await ready;
    f.service.review(f.message.id,{revision:f.message.revision,labelPath:['spam'],profileKind:'other',fields:{}},'human');
    release(JSON.stringify({suggestions:[{name:'迷惑メール',labelPath:['spam'],profileKind:'other',reason:'迷惑な宣伝です。'}]}));
    await assert.rejects(pending,/別の操作/);
    assert.equal(f.service.repository.require('message',f.message.id).reviewedBy,'human');
    f.service.dependencies.propose=async()=>({content:'not-json',model:'fixture-ai'});
    const current=f.service.repository.require('message',f.message.id);
    await assert.rejects(f.service.classifyWithAI(current.id,{revision:current.revision},'test'),/正しい分類提案/);
    assert.equal(f.service.repository.require('message',current.id).revision,current.revision);
  }finally{await f.close();}
});

test('分類追加とAI判断のAPIへ認証・同一オリジン検証を適用する',async()=>{
  const f=await fixture(),app=Fastify();try{
    registerMailOperations(app,(_req,reply)=>{reply.code(401).send({error:{message:'認証が必要です。'}});return false;},f.service);
    assert.equal((await app.inject({method:'POST',url:'/api/mail-operations/taxonomy',payload:{revision:0,name:'test',profileKind:'other'}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/mail-operations/messages/'+f.message.id+'/ai-classify',payload:{revision:f.message.revision}})).statusCode,401);
  }finally{await app.close();await rm(f.root,{recursive:true,force:true});}
});
