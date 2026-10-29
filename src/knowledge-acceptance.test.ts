import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('実モデル検収補助は隔離データで三業務を記録し、人間未検収を保持する（通信は模擬API）',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-acceptance-runner-'));
 const server=createServer(async(req,res)=>{
  const parts:Buffer[]=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
  const last=body.messages.at(-1).content,input=last.startsWith('{')?JSON.parse(last):{};let result:any;
  if(input.claims)result={reviews:input.claims.map((c:any)=>({id:c.id,verdict:'supported',reason:'隔離試験の資料に一致。'}))};
  else if(input.evidence){const evidence=input.evidence.filter((hit:any)=>hit.title==='規程'||hit.title==='計画');result={title:'試験成果',claims:evidence.map((hit:any,index:number)=>({id:'c'+index,kind:'fact',text:hit.excerpt,citations:[{chunkId:hit.chunkId,quote:hit.excerpt}]})),unresolved:[]}}
  else result={queries:['規程','計画']};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)},finish_reason:'stop'}]}));
 });
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  await writeFile(path.join(root,'rules.txt'),'規程：年間20日。');await writeFile(path.join(root,'updated.txt'),'規程：年間25日。');await writeFile(path.join(root,'plan.txt'),'計画：分期实施。');
  const dataset={version:1,materials:[{id:'rules',file:'rules.txt',title:'規程',contentType:'text/plain',language:'ja'},{id:'plan',file:'plan.txt',title:'計画',contentType:'text/plain',language:'zh'}],cases:[{useCase:'grounded-answer',mode:'answer',question:'規程は？'},{useCase:'proposal-resave',mode:'proposal',question:'計画を作成'},{useCase:'sync-reanswer',mode:'answer',question:'最新の規程は？',update:{id:'rules',file:'updated.txt'}}]};
  await writeFile(path.join(root,'dataset.json'),JSON.stringify(dataset));
  let output='';const code=await new Promise<number|null>((resolve,reject)=>{
   const child=spawn(process.execPath,['--import','tsx','scripts/knowledge-acceptance.ts','--dataset',path.join(root,'dataset.json'),'--output',path.join(root,'result')],{cwd:process.cwd(),windowsHide:true,env:{...process.env,WENTIAN_KNOWLEDGE_ACCEPTANCE_BASE_URL:'http://127.0.0.1:'+(server.address() as any).port,WENTIAN_KNOWLEDGE_ACCEPTANCE_MODEL:'fixture/model',WENTIAN_KNOWLEDGE_EMBEDDING_BASE_URL:'',WENTIAN_KNOWLEDGE_EMBEDDING_MODEL:''},stdio:['ignore','pipe','pipe']});
   child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.once('error',reject);child.once('close',resolve);
  });
  assert.equal(code,0,output);const report=JSON.parse(await readFile(path.join(root,'result','report.json'),'utf8'));
  assert.equal(report.modelCalls,9);assert.equal(report.cases.length,3);assert.ok(report.cases.every((c:any)=>c.status==='ai_reviewed'));assert.ok(report.cases[1].resavedDocuments.length);
  assert.equal(report.humanAcceptance,'未確認');assert.equal(report.screenAcceptance,'未確認');assert.equal(report.materials[2].documents[0].revision,2);
  const answer=await readFile(path.join(root,'result','03-artifact.md'),'utf8');assert.match(answer,/年間25日/);assert.doesNotMatch(answer,/年間20日/);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});
