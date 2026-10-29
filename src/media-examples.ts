import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** 保存したサンプル（Examples）は管理者間で共用し、制作ジョブとは別に保持します。 */
export function registerMediaExamples(app:FastifyInstance,authorize:(req:FastifyRequest,reply:FastifyReply)=>string|undefined,root=fileURLToPath(new URL('../examples/media',import.meta.url))){
 const listing=async()=>{try{return JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8')).examples as Array<{id:string;title:string;type:string;description:string;files:Record<string,string>}>}catch{return []}};
 app.get('/api/media/examples',async(req,reply)=>authorize(req,reply)?{examples:await listing()}:reply);
 app.get('/api/media/examples/:id/content',async(req,reply)=>{
  if(!authorize(req,reply))return reply;const example=(await listing()).find(e=>e.id===(req.params as any).id),format=(req.query as any).format||(example?.type==='video'?'mp4':example?.type==='audio'?'wav':'txt'),name=example?.files[format];
  if(!name||! /^[a-z0-9-]+\.(wav|mp3|mp4|txt|srt|json)$/.test(name))return reply.code(404).send({error:{message:'サンプルが見つかりません。'}});
  const file=path.join(root,name),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||await realpath(file)!==path.join(await realpath(root),name))return reply.code(404).send({error:{message:'サンプルが不正です。'}});
  let start=0,end=stat.size-1;reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff').header('accept-ranges','bytes').type(({wav:'audio/wav',mp3:'audio/mpeg',mp4:'video/mp4',txt:'text/plain; charset=utf-8',srt:'application/x-subrip',json:'application/json'} as Record<string,string>)[format]);
  if(req.headers.range){const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!match||!match[1]&&!match[2])return reply.code(416).header('content-range',`bytes */${stat.size}`).send();start=match[1]?Number(match[1]):Math.max(0,stat.size-Number(match[2]));end=match[1]&&match[2]?Math.min(end,Number(match[2])):end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=stat.size||end<start)return reply.code(416).header('content-range',`bytes */${stat.size}`).send();reply.code(206).header('content-range',`bytes ${start}-${end}/${stat.size}`);}
  if((req.query as any).download==='1')reply.header('content-disposition',`attachment; filename="${name}"`);return reply.header('content-length',end-start+1).send(createReadStream(file,{start,end}));
 });
}
