/**
 * 実資料・実モデルの検収補助です。Python/PowerShell入口から呼び出します。
 * 本番知識庫を開かず、一時知識庫へ資料を複製して三つの業務を実行します。
 * AI判定は人間の検収と分けて保存し、実画面・Officeレイアウトの合格を捏造しません。
 */
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ProjectKnowledgeStore } from '../src/project-knowledge.js';
import { configuredKnowledgeEmbedder } from '../src/knowledge-embeddings.js';
import { createKnowledgeArtifact, KnowledgeArtifacts, type KnowledgeCompletion } from '../src/knowledge-workflow.js';
import { exportKnowledgeOffice } from '../src/knowledge-office.js';
import { extractKnowledgeFile } from '../src/knowledge-extraction.js';
import { extractKnowledgePage } from '../src/knowledge-url-collector.js';
import { CODEX_KNOWLEDGE_MODEL, codexKnowledgeCompletion } from '../src/codex-knowledge-completion.js';

const args=process.argv.slice(2);
function argument(name:string){const index=args.indexOf(name);if(index<0||!args[index+1])throw new Error('必要な実行引数がありません。');return args[index+1]}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
async function main(){
  const datasetPath=path.resolve(argument('--dataset')),output=path.resolve(argument('--output'));
  const dataset=JSON.parse(await readFile(datasetPath,'utf8'));
  if(dataset.version!==1||!Array.isArray(dataset.materials)||!dataset.materials.length||dataset.materials.length>100||!Array.isArray(dataset.cases)||dataset.cases.length>30)throw new Error('検収データの構造が不正です。');
  const useCases=['grounded-answer','proposal-resave','sync-reanswer'];
  if(useCases.some(name=>!dataset.cases.some((c:any)=>c.useCase===name)))throw new Error('三つの業務の検収ケースを指定してください。');
  for(const row of dataset.cases)if(!useCases.includes(row.useCase)||!['answer','proposal'].includes(row.mode)||typeof row.question!=='string'||!row.question.trim())throw new Error('検収ケースの設定が不正です。');
  const model=process.env.WENTIAN_KNOWLEDGE_ACCEPTANCE_MODEL,base=process.env.WENTIAN_KNOWLEDGE_ACCEPTANCE_BASE_URL;
  if(!model||(model!==CODEX_KNOWLEDGE_MODEL&&!base))throw new Error('検収モデルと接続先を環境変数で設定してください。');
  const endpoint=model===CODEX_KNOWLEDGE_MODEL?undefined:new URL(base!.replace(/\/+$/,'')+'/chat/completions');if(endpoint&&(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.hash))throw new Error('モデルの接続先が不正です。');
  // 出力を新規作成し、過去の検収記録を上書きしません。本文を含むため非公開領域を指定します。
  await mkdir(output,{recursive:false,mode:0o700});
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-real-acceptance-'));
  const report:any={version:1,startedAt:new Date().toISOString(),model,embeddingConfigured:Boolean(configuredKnowledgeEmbedder()),modelCalls:0,materials:[],cases:[],humanAcceptance:'未確認',screenAcceptance:'未確認',officeLayoutAcceptance:'未確認'};
  const codex=model===CODEX_KNOWLEDGE_MODEL?codexKnowledgeCompletion():undefined;
  const complete:KnowledgeCompletion=async(messages,signal)=>{
    report.modelCalls++;
    if(codex)return codex(messages,signal);
    const response=await fetch(endpoint!,{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json',...(process.env.WENTIAN_KNOWLEDGE_ACCEPTANCE_API_KEY?{authorization:'Bearer '+process.env.WENTIAN_KNOWLEDGE_ACCEPTANCE_API_KEY}:{})},body:JSON.stringify({model,messages,stream:false,max_tokens:8192,response_format:{type:'json_object'}})});
    if(!response.ok||!response.body)throw new Error('検収モデルの応答を取得できません。');
    const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8*1024*1024)throw new Error('検収モデルの応答上限を超えました。');parts.push(part.value)}}finally{await reader.cancel()}
    const body=JSON.parse(Buffer.concat(parts).toString('utf8')),choice=body.choices?.[0];if(choice?.finish_reason==='length'||typeof choice?.message?.content!=='string')throw new Error('検収モデルの応答が不完全です。');return choice.message.content;
  };
  const store=new ProjectKnowledgeStore({root,embedder:configuredKnowledgeEmbedder()}),artifacts=new KnowledgeArtifacts(store),sources=new Map<string,any>();
  async function material(row:any){
    if(typeof row.id!=='string'||!/^[a-z0-9-]{1,40}$/.test(row.id)||typeof row.file!=='string'||typeof row.title!=='string'||typeof row.contentType!=='string')throw new Error('検収資料の設定が不正です。');
    const file=path.resolve(path.dirname(datasetPath),row.file),bytes=await readFile(file);if(bytes.length>25*1024*1024)throw new Error('検収資料は25 MiB以内で指定してください。');
    const url=row.url||'https://wentian.invalid/acceptance/'+row.id;
    const extracted=row.contentType.startsWith('text/')?{content:row.contentType==='text/html'?extractKnowledgePage({url,body:bytes.toString('utf8'),contentType:row.contentType}).content:new TextDecoder('utf-8',{fatal:true}).decode(bytes),warnings:[]}:await extractKnowledgeFile({url:'https://wentian.invalid/'+encodeURIComponent(path.basename(file)),contentType:row.contentType,bytes,status:200,headers:{}},AbortSignal.timeout(15*60000));
    const documents=await store.saveCollectedBundle('acceptance',{title:row.title,url,content:extracted.content},await store.list('acceptance'));
    const evidence={id:row.id,sourceHash:hash(bytes),textHash:hash(extracted.content),language:row.language||'未指定',features:row.features||[],documents:documents.map(d=>({id:d.documentId,revision:d.revision,contentHash:d.contentHash})),warnings:extracted.warnings||[]};report.materials.push(evidence);return evidence;
  }
  try{
    for(const row of dataset.materials){if(sources.has(row.id))throw new Error('資料IDが重複しています。');sources.set(row.id,row);await material(row)}
    for(const [index,row]of dataset.cases.entries()){
      const number=String(index+1).padStart(2,'0'),before=await store.list('acceptance');
      try{
        if(row.useCase==='sync-reanswer'){
          if(!row.update||!sources.has(row.update.id)||typeof row.update.file!=='string')throw new Error('更新後の実資料を指定してください。');
          await material({...sources.get(row.update.id),file:row.update.file});
          const after=await store.list('acceptance');if(!after.some(d=>{const old=before.find(b=>b.documentId===d.documentId);return old&&d.revision>old.revision}))throw new Error('資料の改訂を確認できませんでした。');
        }
        const artifact=await createKnowledgeArtifact(store,'acceptance',{question:row.question,mode:row.mode,model},complete,AbortSignal.timeout(15*60000));
        await artifacts.save(artifact);
        await writeFile(path.join(output,number+'-artifact.json'),JSON.stringify(artifact,null,2),{mode:0o600});
        await writeFile(path.join(output,number+'-artifact.md'),artifact.body,{mode:0o600});
        for(const format of ['docx','xlsx','pptx'] as const)await writeFile(path.join(output,number+'-artifact.'+format),await exportKnowledgeOffice(artifact,format),{mode:0o600});
        const published=row.useCase==='proposal-resave'?await artifacts.publish('acceptance',artifact.id,'https://wentian.invalid/results/'+artifact.id,false):[];
        report.cases.push({useCase:row.useCase,artifactId:artifact.id,status:artifact.status,bodyHash:artifact.bodyHash,reviews:artifact.reviews,unresolved:artifact.unresolved,unresolvedReviews:artifact.unresolvedReviews,resavedDocuments:published.map(d=>d.documentId),humanAcceptance:'未確認'});
      }catch(error){
        // 非公開の検収記録には失敗区分だけを残し、モデル応答・接続先・認証情報を記録しません。
        const failureCode=typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:error instanceof Error?error.name:'unknown';
        report.cases.push({useCase:row.useCase,status:'failed',failureCode,message:'処理を完了できません。出典・モデルの構造化応答・検収設定を確認してください。',humanAcceptance:'未確認'});
      }
    }
  }finally{
    report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2),{mode:0o600});await rm(root,{recursive:true,force:true});
  }
  console.log('隔離した検収記録を保存しました。人間による根拠・画面・レイアウトの確認が必要です。');
  if(report.cases.some((c:any)=>c.status!=='ai_reviewed')||report.materials.some((m:any)=>m.warnings.length))process.exitCode=2;
}
main().catch(()=>{console.error('検収を完了できませんでした。実行引数・資料・モデル接続設定を確認してください。');process.exitCode=1});
