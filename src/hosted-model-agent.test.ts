import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseHostedDecision, runHostedAgent, assertHostedPath } from './hosted-model-agent.js';

test('自然文の操作を推測せず、未知ツール・不正引数・追加フィールドを拒否する', () => {
  for (const raw of ['編集してください', '{"kind":"tool","name":"run_command","arguments":{"command":"echo ok"}}', '{"kind":"tool","name":"write_file","arguments":{"path":"x"}}', '{"kind":"answer","answer":"ok","command":"秘密操作"}']) assert.throws(() => parseHostedDecision(raw));
});
test('両モデルで共通のスキル読込・実ファイル編集・登録試験を実行する', async () => {
  for (const agent of ['ollama','lmstudio'] as const) {
    const workspace = await mkdtemp(path.join(tmpdir(),'wentian-hosted-'));
    await mkdir(path.join(workspace,'.wentian/skills/fixture'),{recursive:true});
    await writeFile(path.join(workspace,'.wentian/skills/fixture/SKILL.md'),'---\nname: fixture\ndescription: 試験用スキル\n---\ninput.txtを読みoutput.txtへ転記します。');
    await writeFile(path.join(workspace,'input.txt'),'試験の実データ');
    await writeFile(path.join(workspace,'check.cjs'),"const fs=require('node:fs');if(fs.readFileSync('output.txt','utf8')!==fs.readFileSync('input.txt','utf8'))process.exit(1);console.log('試験合格');");
    await writeFile(path.join(workspace,'.wentian/acceptance.json'),JSON.stringify({version:1,protectedFiles:['input.txt','check.cjs'],commands:[{id:'check',criterion:'転記内容の一致',executable:process.execPath,args:['check.cjs'],timeoutMs:1000}]}));
    const operations = [
      {kind:'tool',name:'load_skill',arguments:{name:'fixture'}},
      {kind:'tool',name:'read_file',arguments:{path:'input.txt'}},
      {kind:'tool',name:'write_file',arguments:{path:'output.txt',content:'試験の実データ'}},
      {kind:'tool',name:'run_test',arguments:{id:'check'}},
      {kind:'answer',answer:'実ファイルと試験を確認しました。'},
    ];
    let turn=0;
    const answer=await runHostedAgent({agent,model:'fixture',workspace,role:'builder',objective:'入力を転記して試験してください。'}, {infer:async (_options,prompt)=>{
      if(turn===2)assert.ok(prompt.includes('試験の実データ'));
      if(turn===4)assert.ok(prompt.includes('試験合格'));
      return JSON.stringify(operations[turn++]);
    }});
    assert.equal(answer,'実ファイルと試験を確認しました。');
    assert.equal(await readFile(path.join(workspace,'output.txt'),'utf8'),'試験の実データ');
  }
});
test('読取専用役割と保護ファイルの変更、未登録試験を拒否する', async () => {
  const workspace=await mkdtemp(path.join(tmpdir(),'wentian-hosted-denied-'));
  await writeFile(path.join(workspace,'original.txt'),'保持');
  let turn=0;
  await runHostedAgent({agent:'ollama',model:'fixture',workspace,role:'reviewer',objective:'確認'}, {infer:async (_options,prompt)=>{
    if(turn++===0)return JSON.stringify({kind:'tool',name:'write_file',arguments:{path:'original.txt',content:'変更'}});
    assert.ok(prompt.includes('読取専用'));
    return JSON.stringify({kind:'answer',answer:'変更できませんでした。'});
  }});
  assert.equal(await readFile(path.join(workspace,'original.txt'),'utf8'),'保持');
  for(const file of ['../outside.txt','.env','.env.local','.git/config','.wentian/acceptance.json'])await assert.rejects(assertHostedPath(workspace,file));
});
test('隔離コピーへ試験定義をコピーしなくてもホストが確定した計画を引き継ぐ', async () => {
  const workspace=await mkdtemp(path.join(tmpdir(),'wentian-hosted-plan-'));
  await writeFile(path.join(workspace,'check.cjs'),"console.log('引継ぎ試験合格');");
  const plan={version:1 as const,protectedFiles:['check.cjs'],commands:[{id:'check',criterion:'信頼した計画の引継ぎ',executable:process.execPath,args:['check.cjs'],timeoutMs:1000}]};
  let turn=0;
  await runHostedAgent({agent:'lmstudio',model:'fixture',workspace,role:'tester',objective:'登録試験を確認',acceptancePlan:plan},{infer:async (_options,prompt)=>{
    if(turn++===0)return JSON.stringify({kind:'tool',name:'run_test',arguments:{id:'check'}});
    assert.ok(prompt.includes('引継ぎ試験合格'));
    return JSON.stringify({kind:'answer',answer:'実行済み'});
  }});
});
test('保護ファイルの変更と未登録試験を実行せず、失敗した試験を失敗として返す', async () => {
  const workspace=await mkdtemp(path.join(tmpdir(),'wentian-hosted-protected-'));
  await writeFile(path.join(workspace,'check.cjs'),'process.exit(7);');
  const plan={version:1 as const,protectedFiles:['check.cjs'],commands:[{id:'check',criterion:'失敗を検出',executable:process.execPath,args:['check.cjs'],timeoutMs:1000}]};
  const operations=[
    {kind:'tool',name:'write_file',arguments:{path:'check.cjs',content:'process.exit(0);'}},
    {kind:'tool',name:'run_test',arguments:{id:'unknown'}},
    {kind:'tool',name:'run_test',arguments:{id:'check'}},
    {kind:'answer',status:'failed',answer:'試験は失敗しました。'},
  ];
  let turn=0;
  await assert.rejects(runHostedAgent({agent:'ollama',model:'fixture',workspace,role:'builder',objective:'検証',acceptancePlan:plan},{infer:async (_options,prompt)=>{
    if(turn===1)assert.ok(prompt.includes('保護ファイル'));
    if(turn===2)assert.ok(prompt.includes('開始前に設定された試験ID'));
    if(turn===3)assert.ok(prompt.includes('exitCode'));
    return JSON.stringify(operations[turn++]);
  }}), /未完了/);
  assert.equal(await readFile(path.join(workspace,'check.cjs'),'utf8'),'process.exit(7);');
});
test('会話専用の呼出しでは構造化した要求でもツールを実行しない', async () => {
  const workspace=await mkdtemp(path.join(tmpdir(),'wentian-hosted-conversation-'));
  await writeFile(path.join(workspace,'private.txt'),'会話へ取得禁止の内容');
  let turn=0;
  await runHostedAgent({agent:'lmstudio',model:'fixture',workspace,role:'conversation',objective:'会話だけ'},{infer:async (_options,prompt)=>{
    assert.ok(!prompt.includes('会話へ取得禁止の内容'));
    if(turn++===0)return JSON.stringify({kind:'tool',name:'read_file',arguments:{path:'private.txt'}});
    assert.ok(prompt.includes('会話専用の呼出しではツールを実行できません'));
    return JSON.stringify({kind:'answer',answer:'会話の回答'});
  }});
});
test('Builderの自己申告だけでは完了せず、ホストが書込みを確認してから終了する', async () => {
  const workspace=await mkdtemp(path.join(tmpdir(),'wentian-hosted-premature-'));
  let turn=0;
  await runHostedAgent({agent:'lmstudio',model:'fixture',workspace,role:'builder',objective:'成果物を作る'},{infer:async (_options,prompt)=>{
    if(turn++===0)return JSON.stringify({kind:'answer',answer:'完了しました。'});
    if(turn===2){assert.ok(prompt.includes('書込み実績がありません'));return JSON.stringify({kind:'tool',name:'write_file',arguments:{path:'result.txt',content:'検収可能な実ファイル'}});}
    return JSON.stringify({kind:'answer',answer:'実ファイルを作成しました。'});
  }});
  assert.equal(await readFile(path.join(workspace,'result.txt'),'utf8'),'検収可能な実ファイル');
});
