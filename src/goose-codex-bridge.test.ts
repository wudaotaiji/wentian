import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {maintenancePythonCommand} from './maintenance-python.js';
import {buildExternalAgentCommand} from './external-orchestrator.js';
import {prepareGooseCodexBridge} from './goose-codex-bridge.js';

test('Gooseの公式CLI連携はモデルを保持し、会話と作業の権限を分ける',()=>{
 const connection={mode:'native' as const,model:'new-model',provider:'codex',status:'pending' as const,checkedAt:'',expiresAt:'',fingerprint:'',policyHash:''};
 for(const role of ['builder','tester','verifier','reviewer'] as const){
  const command=buildExternalAgentCommand('goose','検査','isolated',role,{attempt:0},connection)!;
  assert.deepEqual(command.gooseCodex,{model:'new-model',role});assert.ok(!command.args.includes('--with-builtin'));
 }
 const conversation=buildExternalAgentCommand('goose','[Wentian LLM fallback] 応答','isolated','builder',{attempt:0},connection)!;
 assert.equal(conversation.gooseCodex?.role,'reviewer');
});

test('子CLIの起動引数をGooseから受け取らず、親が明示したモデル・標準入力だけを使う',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'wentian-goose-bridge-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const fixture=path.join(directory,'child.mjs');
 await writeFile(fixture,"let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({args:process.argv.slice(2),input}));");
 const command=[process.execPath,fixture,'--no-daemon','--ask-for-approval','never','exec','--skip-git-repo-check','--ephemeral','--sandbox','read-only','--cd',directory,'--json','--model','selected-model','-'];
 const python=maintenancePythonCommand();const exec=promisify(execFile);
 const env={...process.env,WENTIAN_GOOSE_CODEX_COMMAND:JSON.stringify(command),PYTHONIOENCODING:'utf-8'};
 const pending=exec(python.executable,[...python.args,'scripts/run-goose-codex.py','--yolo','--model','ignored-model'],{env});pending.child.stdin!.end('隔離した入力');
 const result=JSON.parse((await pending).stdout);assert.equal(result.input,'隔離した入力');assert.equal(result.args[result.args.indexOf('--model')+1],'selected-model');assert.ok(!result.args.includes('--yolo'));
 const invalid=exec(python.executable,[...python.args,'scripts/run-goose-codex.py'],{env:{...env,WENTIAN_GOOSE_CODEX_COMMAND:JSON.stringify([...command.slice(0,-1),'--yolo','-'])}});invalid.child.stdin!.end();await assert.rejects(invalid);
 const bridge=await prepareGooseCodexBridge({executable:command[0],args:command.slice(1)});t.after(bridge.cleanup);assert.equal(JSON.parse(bridge.env.WENTIAN_GOOSE_CODEX_COMMAND)[0],process.execPath);
 if(process.platform==='win32'){
  const ps=exec('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/run-goose-codex.ps1'],{env:{...env,WENTIAN_MAINTENANCE_PYTHON:python.executable}});ps.child.stdin!.end('PowerShell入口');assert.equal(JSON.parse((await ps).stdout).input,'PowerShell入口');
 }
});
