/**
 * 実画面の隔離検収用サーバーです。AIの意味判断・回答品質を検収するものではありません。
 * 利用者設定を読まず、架空資料・構造化された模擬モデル・新規一時知識庫だけを使います。
 * ポートはOS割当、待受はループバック限定です。15分で終了し、本番Daemonを変更しません。
 */
import '../src/test-environment.js';
import Fastify from 'fastify';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerProjectCenter } from '../src/project-center.js';
import { registerProjectKnowledgeRoutes } from '../src/project-knowledge-routes.js';

const outputIndex=process.argv.indexOf('--output');
if(outputIndex<0||!process.argv[outputIndex+1])throw new Error('新規の非公開出力先を指定してください。');
const output=path.resolve(process.argv[outputIndex+1]);
await mkdir(output,{recursive:false});
const root=await mkdtemp(path.join(os.tmpdir(),'wentian-screen-'));
const app=Fastify();
registerProjectCenter(app,()=>true);
app.get('/api/control-center/me',async()=>({user:{id:'fixture',role:'admin'}}));
app.get('/api/team-access/projects',async()=>({projects:[{id:'alpha',name:'隔離検収 / Isolated review / 隔离验收'}]}));
app.get('/api/team-access/projects/alpha/usage',async()=>({project:{id:'alpha',allowedModels:['fixture/model'],members:{fixture:'owner'},canManage:true,spendUsd:0,heldUsd:0},keys:[]}));
app.get('/api/workbench/groups',async()=>({groups:[]}));
registerProjectKnowledgeRoutes(app,()=>true,{root,readPage:async(url)=>({url,extracted:{title:'架空の休暇規程',content:new URL(url).searchParams.get('revision')==='2'?'年間25日。':'年間20日。',links:[]}}),workspace:{complete:()=>async messages=>{
  // 試験のプロトコル段階だけを区別します。自然言語の依頼分類を実装するものではありません。
  const last=messages.at(-1)!.content,input=last.startsWith('{')?JSON.parse(last):{};
  if(input.claims)return JSON.stringify({reviews:input.claims.map((c:any)=>({id:c.id,verdict:'supported',reason:'模擬検証：試験資料を転記。'}))});
  if(input.evidence){const evidence=input.evidence.filter((e:any)=>e.url==='https://example.invalid/rules'||e.url==='https://example.invalid/pay');return JSON.stringify({title:'隔離検収の成果',claims:evidence.map((hit:any,index:number)=>({id:'c'+index,kind:'fact',text:hit.excerpt,citations:[{chunkId:hit.chunkId,quote:hit.excerpt}]})),unresolved:[]})}
  return JSON.stringify({queries:['休暇規程','給与']});
}}});
await app.listen({host:'127.0.0.1',port:0});
const address=app.server.address();if(!address||typeof address==='string')throw new Error('待受を取得できません。');
await writeFile(path.join(output,'server.json'),JSON.stringify({pid:process.pid,origin:`http://127.0.0.1:${address.port}`,root,model:'fixture/model',realModel:false},null,2));
console.log('隔離検収サーバーを開始しました。出力先のserver.jsonを参照してください。');
const close=async()=>{await app.close();process.exit(0)};
process.on('SIGINT',close);process.on('SIGTERM',close);
setTimeout(close,15*60*1000).unref();
