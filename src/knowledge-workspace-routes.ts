import { exportKnowledgeOffice } from './knowledge-office.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ProjectKnowledgeStore, KnowledgeError, validateProjectId } from './project-knowledge.js';
import { createKnowledgeArtifact, KnowledgeArtifacts, type KnowledgeCompletion } from './knowledge-workflow.js';
import { atomicOrdinaryWrite, assertOrdinaryPath } from './safe-file.js';
import { extractKnowledgeFile } from './knowledge-extraction.js';
import { extractKnowledgePage } from './knowledge-url-collector.js';
import type { KnowledgeResource } from './knowledge-resource.js';

export interface KnowledgeWorkspaceOptions {
  authorize:(req:FastifyRequest,reply:FastifyReply,project:string,write:boolean)=>boolean|Promise<boolean>;
  complete?:(req:FastifyRequest,project:string,model:string)=>KnowledgeCompletion;
  bindGroup?:(req:FastifyRequest,project:string,groupId:string)=>Promise<unknown>;
  meeting?:(req:FastifyRequest,id:string)=>Promise<any>;
}
/** 一般メンバーの資料内対話と、編集者の再保存を分け、作業シェルを公開しません。 */
export function registerKnowledgeWorkspace(app:FastifyInstance,store:ProjectKnowledgeStore,options:KnowledgeWorkspaceOptions){
  const artifacts=new KnowledgeArtifacts(store);
  const guard=async(req:FastifyRequest,reply:FastifyReply,write:boolean)=>{const project=(req.params as any).projectId;try{validateProjectId(project)}catch{return reply.code(400).send({error:{message:'プロジェクトIDが不正です。'}}),false}let allowed=false;try{allowed=await options.authorize(req,reply,project,write)===true}catch{}if(!allowed&&!reply.sent)reply.code(403).send({error:{message:'このプロジェクトを操作する権限がありません。'}});return allowed};
  const run=async(reply:FastifyReply,work:()=>Promise<unknown>)=>{try{return await work()}catch(error){if(reply.sent)return reply;const conflict=error instanceof KnowledgeError&&error.code==='revision_conflict';return reply.code(conflict?409:400).send({error:{message:error instanceof KnowledgeError?error.message:'操作を完了できません。入力・権限・モデルの準備を確認してください。',code:error instanceof KnowledgeError?error.code:'knowledge_workspace_failed'}})}};
  app.get('/v1/project-knowledge/:projectId/index',async(req,reply)=>{if(!await guard(req,reply,false))return reply;return run(reply,()=>store.indexProgress((req.params as any).projectId))});
  app.post('/v1/project-knowledge/:projectId/index/prepare',async(req,reply)=>{if(!await guard(req,reply,true))return reply;return run(reply,()=>store.prepareIndex((req.params as any).projectId))});
  const origin=(req:FastifyRequest)=>`${req.protocol}://${req.headers.host}`;
  app.post('/v1/project-knowledge/:projectId/assistant',async(req,reply)=>{
    if(!await guard(req,reply,false))return reply;
    return run(reply,async()=>{const project=(req.params as any).projectId,input=req.body as any;if(!options.complete)throw new KnowledgeError('回答モデルが未設定です。','model_unavailable');const controller=AbortSignal.timeout(5*60000);const artifact=await createKnowledgeArtifact(store,project,input,options.complete(req,project,input?.model),controller);if(!await guard(req,reply,false))return reply;return artifacts.save(artifact)});
  });
  app.get('/v1/project-knowledge/:projectId/artifacts/:artifactId',async(req,reply)=>{if(!await guard(req,reply,false))return reply;return run(reply,()=>artifacts.get((req.params as any).projectId,(req.params as any).artifactId))});
  app.get('/v1/project-knowledge/:projectId/artifacts/:artifactId/export/:format',async(req,reply)=>{
    if(!await guard(req,reply,false))return reply;return run(reply,async()=>{const{projectId,artifactId,format}=req.params as any;if(!['md','docx','xlsx','pptx'].includes(format))throw new KnowledgeError('出力形式を確認してください。','invalid_workflow');const artifact=await artifacts.get(projectId,artifactId);const bytes=format==='md'?Buffer.from(artifact.body):await exportKnowledgeOffice(artifact,format);return reply.header('cache-control','private,no-store').header('content-disposition','attachment; filename="knowledge-artifact.'+format+'"').type(format==='md'?'text/markdown; charset=utf-8':'application/octet-stream').send(bytes)});
  });
  app.post('/v1/project-knowledge/:projectId/artifacts/:artifactId/publish',async(req,reply)=>{
    if(!await guard(req,reply,true))return reply;
    return run(reply,async()=>{const {projectId,artifactId}=req.params as any;return{documents:await artifacts.publish(projectId,artifactId,origin(req)+`/v1/project-knowledge/${projectId}/artifacts/${artifactId}`,(req.body as any)?.allowUnconfirmed===true)}});
  });
  app.post('/v1/project-knowledge/:projectId/groups/:groupId/bind',async(req,reply)=>{if(!await guard(req,reply,true))return reply;return run(reply,async()=>{if(!options.bindGroup)throw new KnowledgeError('グループ接続が未設定です。','group_unavailable');return options.bindGroup(req,(req.params as any).projectId,(req.params as any).groupId)})});
  app.post('/v1/project-knowledge/:projectId/notes',async(req,reply)=>{if(!await guard(req,reply,true))return reply;return run(reply,()=>{const project=(req.params as any).projectId,input=req.body as any;return store.register(project,{title:input?.title,content:input?.content,url:origin(req)+'/projects?note='+randomBytes(12).toString('hex')})})});
  app.post('/v1/project-knowledge/:projectId/import-files',{bodyLimit:40*1024*1024},async(req,reply)=>{
    if(!await guard(req,reply,true))return reply;
    return run(reply,async()=>{
      const project=(req.params as any).projectId,files=(req.body as any)?.files;
      if(!Array.isArray(files)||!files.length||files.length>20)throw new KnowledgeError('一括追加は1〜20ファイルで指定してください。','invalid_import');
      let size=0;const checked=files.map(file=>{if(!file||typeof file.name!=='string'||!file.name||file.name.length>200||/[\\/\x00-\x1f]/.test(file.name)||typeof file.base64!=='string'||file.base64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)||typeof file.contentType!=='string'||file.contentType.length>200)throw new KnowledgeError('ファイルの形式が不正です。','invalid_import');const bytes=Buffer.from(file.base64,'base64');size+=bytes.length;if(!bytes.length||size>25*1024*1024)throw new KnowledgeError('一括追加は合計25 MiB以内で指定してください。','invalid_import');return{...file,bytes}});
      const warnings:Array<{name:string;message:string}>=[];const documents:unknown[]=[],errors:Array<{name:string;message:string}>=[];
      for(const file of checked){
        if(!await guard(req,reply,true))return reply;
        try{
          const id=randomBytes(12).toString('hex'),url=origin(req)+`/v1/project-knowledge/${project}/files/${id}`;
          const resource:KnowledgeResource={url,bytes:file.bytes,contentType:file.contentType,status:200,headers:{}};
          const type=file.contentType.split(';')[0];
          let content:string;
          if(type.startsWith('text/')||['application/json','application/xml'].includes(type)){const text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);content=type==='text/html'?extractKnowledgePage({url,body:text,contentType:type}).content:text}
          else {const extracted=await extractKnowledgeFile({...resource,url:origin(req)+'/'+encodeURIComponent(file.name)},AbortSignal.timeout(15*60000));content=extracted.content;for(const message of extracted.warnings||[])warnings.push({name:file.name,message})}
          if(!await guard(req,reply,true))return reply;
          const root=path.join(store.root,'files',project);await atomicOrdinaryWrite(path.join(root,id+'.bin'),file.bytes);await atomicOrdinaryWrite(path.join(root,id+'.json'),JSON.stringify({name:file.name,contentType:file.contentType}));
          documents.push(...await store.saveCollectedBundle(project,{title:file.name,url,content},await store.list(project)));
        }catch{errors.push({name:file.name,message:'本文を抽出できませんでした。形式・文字コード・抽出モデルを確認してください。'})}
      }
      return{documents:documents.map((d:any)=>({documentId:d.documentId,title:d.title,url:d.url,revision:d.revision})),errors,warnings,complete:!errors.length&&!warnings.length};
    });
  });
  app.get('/v1/project-knowledge/:projectId/files/:fileId',async(req,reply)=>{
    if(!await guard(req,reply,false))return reply;const {projectId,fileId}=req.params as any;if(!/^[a-f0-9]{24}$/.test(fileId))return reply.code(400).send({error:{message:'ファイルIDが不正です。'}});
    return run(reply,async()=>{const file=path.join(store.root,'files',projectId,fileId+'.bin');await assertOrdinaryPath(file);return reply.header('cache-control','private,no-store').header('content-disposition','attachment; filename="source.bin"').header('x-content-type-options','nosniff').type('application/octet-stream').send(await readFile(file))});
  });
  app.get('/v1/project-knowledge/:projectId/backup',async(req,reply)=>{if(!await guard(req,reply,true))return reply;return run(reply,async()=>reply.header('cache-control','no-store').header('content-disposition','attachment; filename="knowledge-backup.json"').send(await store.backup((req.params as any).projectId)))});
  app.post('/v1/project-knowledge/:projectId/restore',{bodyLimit:50*1024*1024},async(req,reply)=>{if(!await guard(req,reply,true))return reply;return run(reply,()=>store.restore((req.params as any).projectId,req.body))});
  app.post('/v1/project-knowledge/:projectId/meetings/:recordingId/import',async(req,reply)=>{
    if(!await guard(req,reply,true))return reply;
    return run(reply,async()=>{if(!options.meeting)throw new KnowledgeError('会議連携が未設定です。','meeting_unavailable');const {projectId,recordingId}=req.params as any;if(!/^[a-f0-9-]{36}$/.test(recordingId))throw new KnowledgeError('会議IDが不正です。','invalid_import');const row=await options.meeting(req,recordingId);if(!row.complete||!row.segments?.length)throw new KnowledgeError('会議の文字起こし完了を待ってください。','meeting_incomplete');const body=['# 会議資料','話者分離: '+(row.segments.every((s:any)=>s.speaker)?'話者ラベルあり':'未確認（話者名を推測しない）'),'## 文字起こし',...row.segments.map((s:any)=>`[${s.start}–${s.end}秒] ${s.speaker||'話者未確認'}: ${s.text}`),'## 議事録',JSON.stringify(row.minutes||{status:'未確認'},null,2)].join('\n');if(!await guard(req,reply,true))return reply;return{documents:await store.saveCollectedBundle(projectId,{title:'会議 '+recordingId,url:origin(req)+'/api/meetings/recordings/'+recordingId,content:body},await store.list(projectId))}});
  });
  return{artifacts};
}
