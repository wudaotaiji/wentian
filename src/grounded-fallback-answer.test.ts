import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateGroundedFallbackAnswer} from './grounded-fallback-answer.js';
import {buildExternalConversationContext,createSequentialExternalFallbackPlan} from './llm-fallback.js';
import {fallbackAgentPlan} from './agent-planner.js';
import {createOrchestrationTask,formatTaskOrchestration,orchestrateExternalTask} from './external-orchestrator.js';
import {withVerifiedWork} from './work-test-fixture.js';

const packet=(patch:any={})=>JSON.stringify({status:'complete',answer:'調査した実装と未確認範囲を説明します。',workspaceRequired:false,assessment:{answersCurrentRequest:true,usesProvidedContext:true},evidence:[],limitations:[],...patch});
test('Web回答は取得済み資料だけを根拠とし、未確認理由を消さない',async()=>{
 const research={context:'時間別予報: 2026-10-24T15:00 気温22度、降水確率10%',sources:['https://example.test/forecast'],retrievedAt:'2026-10-24T01:00:00Z'};
 const webEvidence=[{url:research.sources[0],quote:research.context}];
 const result=await validateGroundedFallbackAnswer(packet({webEvidence}),process.cwd(),false,{required:true,research});assert.equal(result.webEvidence[0].url,research.sources[0]);assert.equal(result.webEvidence[0].retrievedAt,research.retrievedAt);assert.equal(result.webEvidence[0].sha256.length,64);
 await assert.rejects(validateGroundedFallbackAnswer(packet({status:'blocked',answer:'未取得の予報なので確認できません。',limitations:['時間別予報なし']}),process.cwd()),/未取得の予報.*時間別予報なし/);
 await assert.rejects(validateGroundedFallbackAnswer(packet({webEvidence}),process.cwd(),false,{required:true}),/取得できていません/);
 await assert.rejects(validateGroundedFallbackAnswer(packet(),process.cwd(),false,{required:true,research}),/webEvidence/);
 for(const changed of [{url:'https://invented.test/forecast'},{quote:'資料にない架空の予報です。'}])await assert.rejects(validateGroundedFallbackAnswer(packet({webEvidence:[{...webEvidence[0],...changed}]}),process.cwd(),false,{required:true,research}),/一致しません/);
 const task=createOrchestrationTask(createSequentialExternalFallbackPlan({...fallbackAgentPlan('午後の天気'),evidenceSource:'web'},'午後の天気',[],research),process.cwd());
 const display=formatTaskOrchestration(task,[]);assert.match(display,/Web資料/);assert.doesNotMatch(display,/Target:|作業場所と依頼/);
});
test('参考履歴と現在依頼を分け、読取調査へ制作工程や履歴の全文を表示しない',()=>{
 const input='現在の仕組みを説明して',context=buildExternalConversationContext([{role:'user',content:'古い依頼'}],input);
 assert.ok(context.indexOf('</reference_conversation>')<context.indexOf('<current_request>'));assert.ok(context.endsWith(input+'\n</current_request>'));
 const plan=createSequentialExternalFallbackPlan(fallbackAgentPlan(input),input),task=createOrchestrationTask(plan,'C:/workspace');
 const display=formatTaskOrchestration(task,[]);assert.doesNotMatch(display,/Builder|Tester|Staging|Target反映|古い依頼|reference_conversation/);assert.match(display,/調査/);assert.equal(task.responseContract,'grounded_answer');
});
test('未調査の再質問・根拠なし・架空引用・領域外・秘密ファイルを完了にしない',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-grounded-answer-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const line='export const maintenanceMode = "deterministic";';await writeFile(path.join(root,'source.ts'),line+'\n');
 await assert.rejects(validateGroundedFallbackAnswer('请告诉我应检查的项目目录',root));
 await assert.rejects(validateGroundedFallbackAnswer(packet({workspaceRequired:true}),root));
 await assert.rejects(validateGroundedFallbackAnswer(packet({status:'blocked'}),root));
 await assert.rejects(validateGroundedFallbackAnswer(packet(),root,true));
 const evidence=[{path:'source.ts',startLine:1,endLine:1,quote:line}];
 const valid=await validateGroundedFallbackAnswer(packet({workspaceRequired:true,evidence}),root);assert.equal(valid.evidence[0].path,'source.ts');assert.equal(valid.evidence[0].sha256.length,64);
 for(const changed of [{quote:'存在しない実装の引用です。'},{startLine:2,endLine:2},{path:'../source.ts'},{path:'.env'}])await assert.rejects(validateGroundedFallbackAnswer(packet({workspaceRequired:true,evidence:[{...evidence[0],...changed}]}),root));
 assert.equal((await validateGroundedFallbackAnswer(packet(),root)).evidence.length,0,'一般会話にファイル調査を強制しません');
 assert.equal((await validateGroundedFallbackAnswer('途中の表示\n'+packet(),root)).answer,'調査した実装と未確認範囲を説明します。');
 await assert.rejects(validateGroundedFallbackAnswer(packet({evidence:Array(9).fill(evidence[0])}),root),/最大8件/);
 await assert.rejects(validateGroundedFallbackAnswer('x'.repeat(128001),root),/検証上限/);
});
test('直列fallbackは粗い回答を成功扱いせず、検証済みの次候補の回答を採用する',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-grounded-pipeline-'));t.after(()=>rm(root,{recursive:true,force:true}));const agents=['codex','opencode'].map(id=>withVerifiedWork({id,name:id,state:'available' as const,stateLabel:'',note:'',liveState:'healthy' as const,freshWithin24Hours:true}));
 const longAnswer='根拠を確認した説明。'.repeat(2200);
 let calls=0;const result=await orchestrateExternalTask(createSequentialExternalFallbackPlan(fallbackAgentPlan('説明して'),'説明して'),{workspace:root,enabled:true},{readyAgents:async()=>agents,loadSnapshot:async()=>({source:'fixture',agents,cacheFreshWithin24Hours:true,summary:{available:2,candidate:0,needs_recheck:0,unavailable:0,total:2}}),runCommand:async()=>++calls<=2?'请告诉我项目目录':packet({answer:longAnswer}),repairPlanner:async()=>{throw Error('回答検証の失敗を設定変更で回避してはいけません')}});
 assert.equal(result.status,'completed');assert.equal(result.reports[0].success,false);assert.equal(result.reports[0].attempts,2);assert.equal(result.reports[1].success,true);assert.equal(calls,3);assert.doesNotMatch(result.reports[1].output,/assessment|workspaceRequired/);
 assert.equal(result.reports[1].output,longAnswer,'2万文字を超える正常な構造化回答も途中で切断しません');
});

test('共有予算内で残る候補の初回試行を確保し、異なる検証不合格を同一障害にしない',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-grounded-three-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ids=['codex','opencode','kilo'],agents=ids.map(id=>withVerifiedWork({id,name:id,state:'available' as const,stateLabel:'',note:'',liveState:'healthy' as const,freshWithin24Hours:true}));
 const plan=createSequentialExternalFallbackPlan(fallbackAgentPlan('根拠を説明して'),'根拠を説明して');plan.delegation.requestedAgents=ids;
 const called:string[]=[];const result=await orchestrateExternalTask(plan,{workspace:root,enabled:true},{readyAgents:async()=>agents,loadSnapshot:async()=>({source:'fixture',agents,cacheFreshWithin24Hours:true,summary:{available:3,candidate:0,needs_recheck:0,unavailable:0,total:3}}),runCommand:async(_command,options)=>{called.push(options.agent);return options.agent==='codex'?'構造のない回答':options.agent==='opencode'?packet({status:'blocked',answer:'資料を取得できません。'}):packet();}});
 assert.equal(result.status,'completed');assert.deepEqual(called,ids);assert.deepEqual(result.reports.map(report=>report.attempts),[1,1,1]);
});
