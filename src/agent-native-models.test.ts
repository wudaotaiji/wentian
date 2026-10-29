import { configuredAgentModels } from './agent-native-models.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { maintenancePythonCommand } from './maintenance-python.js';
import { buildModelChoices } from './agent-model-selection.js';
import { buildExternalAgentCommand,codexResponseText } from './external-orchestrator.js';
import { connectionAllowsExecution } from './agent-connection-policy.js';

test('各Agentの設定からモデル識別子だけを取り出し、ネイティブ選択で認証設定を変更しない',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-native-models-'));
  const sources:Record<string,[string,string]>={
    goose:['AppData/Roaming/Block/goose/config/config.yaml','active_provider: custom\nGOOSE_MODEL: example-model\nAPI_KEY: DO_NOT_PRINT\n'],
    claude:['.claude/settings.json',JSON.stringify({env:{ANTHROPIC_MODEL:'example-model',ANTHROPIC_AUTH_TOKEN:'DO_NOT_PRINT'}})],
    hermes:['.hermes/config.yaml','model:\n  default: example-model\n  provider: custom\n'],
    openclaw:['.openclaw/openclaw.json',JSON.stringify({models:{providers:{custom:{apiKey:'DO_NOT_PRINT',models:[{id:'example-model'}]}}}})],
    codex:['.codex/config.toml','model = "example-model"\nmodel_provider = "custom"\n'],
  };
  const python=maintenancePythonCommand();const exec=promisify(execFile);
  for(const [agent,[relative,body]] of Object.entries(sources)){
    const target=path.join(root,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,body);
    const env={...process.env,CODEX_HOME:path.join(root,'.codex'),PYTHONIOENCODING:'utf-8'};
    const output=await exec(python.executable,[...python.args,'scripts/list-agent-models.py','--agent',agent,'--home',root],{env});
    const models=JSON.parse(output.stdout).models;
    assert.ok(models.some((item:any)=>item.model=== (agent==='openclaw'?'custom/example-model':'example-model')),agent);
    assert.doesNotMatch(output.stdout,/DO_NOT_PRINT|apiKey|AUTH_TOKEN/);
    const applied=await exec(python.executable,[...python.args,'scripts/maintain-agent-connection.py','--agent',agent,'--mode','native','--model','another-model','--home',root,'--report-root',path.join(root,'backups'),'--apply'],{env});
    assert.deepEqual(JSON.parse(applied.stdout).changedFiles,[]);
    assert.equal(await readFile(target,'utf8'),body,'認証・モデルの既定設定を上書きしません');
  }
});

test('設定候補のプロバイダーを保持し、Codexへ非対応のChat Completions候補を渡さない',()=>{
  const choices=buildModelChoices('goose',[],[],[{model:'same',provider:'provider-a'},{model:'same',provider:'provider-b'}]);
  assert.equal(choices.length,2);assert.notEqual(choices[0].id,choices[1].id);
  assert.equal(choices[0].provider,'provider-a');
  assert.deepEqual(buildModelChoices('codex',['account-model'],[{id:'local/model'}]).map(item=>item.model),['account-model']);
});

test('ネイティブランナーは選択したモデルとプロバイダーを渡し、Codexを既存セッションから分離する',()=>{
  const connection={mode:'native' as const,model:'account-model',provider:'native-provider',status:'verified' as const,checkedAt:'',expiresAt:'',fingerprint:'',policyHash:''};
  const codex=buildExternalAgentCommand('codex','確認','C:/isolated','reviewer',{attempt:0},connection)!;
  assert.equal(codex.args[codex.args.indexOf('--model')+1],'account-model');
  assert.equal(codex.args[codex.args.indexOf('--sandbox')+1],'read-only');
  assert.ok(codex.args.includes('--ephemeral'));assert.ok(codex.args.includes('--no-daemon'));
  assert.ok(!codex.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  for(const agent of ['goose','hermes']){
    const command=buildExternalAgentCommand(agent,'確認','C:/isolated','reviewer',{attempt:0},connection)!;
    assert.equal(command.args[command.args.indexOf('--provider')+1],'native-provider');
  }
  const claw=buildExternalAgentCommand('openclaw','確認','C:/isolated','reviewer',{attempt:0},{...connection,model:'provider/model'})!;
  assert.equal(claw.args[claw.args.indexOf('--model')+1],'provider/model');
});

test('Codexの実回答をJSONイベントから抽出し、指示やエラーのエコーを合格にしない',()=>{
  assert.equal(connectionAllowsExecution({id:'codex',registration:'manual'}),false,'CLIの導入だけで実応答成功と扱いません');
  assert.equal(codexResponseText(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'TOKEN'}})),'TOKEN');
  assert.equal(codexResponseText([JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'途中の説明'}}),JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'最終回答'}})].join('\n')),'最終回答');
  assert.throws(()=>codexResponseText(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'echo TOKEN'}})));
  assert.throws(()=>codexResponseText(JSON.stringify({type:'turn.failed',error:{message:'TOKEN'}})));
});


test('モデル設定の読取りも許可された保守専用領域で起動する',async()=>{
  const original=process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT;
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-model-scope-'));process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT=root;
  try {
    const models=await configuredAgentModels('ollama',undefined,async(command,options)=>{
      assert.equal(options.cwd,root);assert.deepEqual(command.args,['list']);
      return 'NAME ID SIZE MODIFIED\nconfigured:model abc 1GB today';
    });assert.deepEqual(models,[{model:'configured:model'}]);
  } finally {if(original===undefined)delete process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT;else process.env.WENTIAN_CONNECTION_WORKSPACE_ROOT=original;}
});
