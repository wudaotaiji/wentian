import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { saveStudyArtifacts, withStudyArtifacts } from './study/artifacts.js';
import { registerStudyConversation } from './study/conversation.js';
import { executeChatTool } from './chat-agent.js';
import { registerStartupForge } from './startup-forge.js';
import { AgentGroupStore, type GroupResponder } from './agent-group.js';

test('書斎の指定ルートへ保存・再確認し、既存成果を上書きせずNotebookを未実行にする', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-study-artifact-'));
 try {
  const first=await saveStudyArtifacts(root,[{name:'業務報告.md',content:'# 今日の報告\n確認できる資料がありません。'}]);
  const second=await saveStudyArtifacts(root,[{name:'業務報告.md',content:'# 別版'}]);
  assert.notEqual(first[0].path,second[0].path);assert.match(await readFile(first[0].path,'utf8'),/今日の報告/);
  assert.ok(first[0].url.startsWith('/study/jupyter/lab/tree/artifacts/chat/'));
  const notebook={nbformat:4,nbformat_minor:5,metadata:{},cells:[{cell_type:'code',source:['print(1)'],metadata:{trusted:true},outputs:[{text:'未確認の出力'}],execution_count:1}]};
  const saved=await saveStudyArtifacts(root,[{name:'分析.ipynb',content:JSON.stringify(notebook)}]);
  const parsed=JSON.parse(await readFile(saved[0].path,'utf8'));assert.deepEqual(parsed.cells[0].outputs,[]);assert.equal(parsed.cells[0].execution_count,null);
  for(const name of ['../escape.md','C:\\escape.md','.private.md','script.py'])await assert.rejects(saveStudyArtifacts(root,[{name,content:'test'}]));
  await assert.rejects(saveStudyArtifacts(root,[{name:'bad.ipynb',content:'{}'}]));
  await assert.rejects(saveStudyArtifacts(root,[{name:'a.md',content:'a'},{name:'a.md',content:'b'}]));
 } finally {await rm(root,{recursive:true,force:true});}
});

test('通常Chatは選択モデル・予算を維持し、実保存後だけ成果物のパスを返す',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-study-chat-')),app=Fastify();let calls=0;
 registerStudyConversation(app,{root:async()=>root,authorize:(req,reply)=>{if(req.headers.authorization==='Bearer test')return true;reply.code(401).send({error:'認証が必要です。'});return false;},complete:async body=>{
  calls++;assert.equal(body.model,'mock/model');assert.equal(body.stream,false);assert.deepEqual(body.wentian_budget,{maxTokens:1000});
  assert.match((body.messages as any[])[0].content,/捏造/);
  return {choices:[{message:{content:JSON.stringify({reply:'本文を作成しました。',files:[{name:'report.md',content:'# 作業報告\n利用者が提供した事実に基づきます。'}]})}}]};
 }});
 try {
  const payload={model:'mock/model',messages:[{role:'user',content:'今天的工作报告放到我的书房里'}],wentian_budget:{maxTokens:1000}};
  assert.equal((await app.inject({method:'POST',url:'/api/study/conversation',payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/study/conversation',headers:{authorization:'Bearer test',origin:'https://outside.invalid'},payload})).statusCode,403);
  const res=await app.inject({method:'POST',url:'/api/study/conversation',headers:{authorization:'Bearer test'},payload});assert.equal(res.statusCode,200,res.body);
  const content=JSON.parse(res.body.split('\n')[0].slice(6)).choices[0].delta.content;assert.match(content,/artifacts/);assert.equal(calls,1);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

test('群は固定キーワードで判断せず構造化AI結果を保存し、選定処理を再帰させない',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-study-group-'));let calls=0;
 const wrapped=withStudyArtifacts(async(_m,_messages,context)=>{calls++;return context?.studyPlanning?JSON.stringify({reply:'資料',files:[{name:'研究.md',content:'# 検証計画'}]}):'検証計画をまとめました。';},async()=>root);
 try{
  const result=await wrapped({name:'担当',role:'研究',model:'mock/model'},[{role:'user',content:'この結果を使える形にして'}],{groupId:'test',usedAgents:[]});assert.match(String(result),/研究.md/);assert.equal(calls,2);
  await wrapped({name:'担当',role:'研究',model:'mock/model'},[],{groupId:'test',usedAgents:[],topicSelection:true});assert.equal(calls,3);
  const call={id:'1',type:'function' as const,function:{name:'save_study_artifact',arguments:JSON.stringify({name:'act.md',content:'# 実行成果'})}};
  await assert.rejects(executeChatTool(call,{mode:'plan',model:'mock',messages:[],allowedWritePaths:[],studyRoot:root},root,new AbortController().signal));
  const saved=JSON.parse(await executeChatTool(call,{mode:'act',model:'mock',messages:[],allowedWritePaths:[],studyRoot:root},root,new AbortController().signal));assert.equal(await readFile(saved[0].path,'utf8'),'# 実行成果');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('Forgeの完成した計画も書斎へ保存し、進行記録に実パスを残す',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-study-forge-')),app=Fastify(),groups=new AgentGroupStore(root);
 try{
  const group=await groups.create('検証',[]);
  const respond:GroupResponder=async()=>JSON.stringify({name:'検証事業',proposition:'価値仮説を試す',customers:'利用者',validation:'確認する',risks:['未確認'],team:[{name:'担当',role:'調査'}],tasks:[{id:'a',title:'調査',owner:'担当',description:'根拠を確認する',deliverable:'報告',acceptance:'根拠あり',dependsOn:[]}]});
  registerStartupForge(app,root,groups,respond,async()=>path.join(root,'custom-notebooks'));
  const url='/api/workbench/groups/'+group.id+'/forge';
  assert.equal((await app.inject({method:'POST',url:url+'/plan',payload:{brief:'検証を進める'}})).statusCode,200);
  let state:any;for(let i=0;i<100;i++){state=(await app.inject(url)).json().state;if(state?.status!=='planning')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(state.status,'ready');const receipt=state.events.find((e:any)=>e.message.startsWith('📄 '));assert.ok(receipt);assert.match(await readFile(receipt.message.slice(3),'utf8'),/検証事業/);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
