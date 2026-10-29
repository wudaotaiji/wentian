import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AGENT_CATALOG, agentExecutableCandidates, agentVersionCommand, probeAgentCli, installPlan, issueInstallApproval } from './agent-marketplace.js';

test('Windows PATHからcmdとexeの直接探索候補を生成する', () => {
  const candidates = agentExecutableCandidates('opencode', { PATH: 'C:\\Tools;C:\\Users\\tester\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' });
  assert.ok(candidates.some(value => value.toLowerCase().endsWith('opencode.cmd')));
  assert.ok(candidates.some(value => value.toLowerCase().endsWith('opencode.exe')));
});

test('人気度候補カタログは10件以上あり安全な固定インストール定義を持つ', () => {
  assert.ok(AGENT_CATALOG.length >= 10);
  const ids = new Set(AGENT_CATALOG.map(agent => agent.id));
  assert.equal(ids.size, AGENT_CATALOG.length);
  const plan = installPlan('crush');
  assert.equal(plan.executable, 'winget.exe');
  assert.ok(plan.arguments.includes('charmbracelet.crush'));
});

test('未対応エージェントの自動インストールを拒否する', () => {
  assert.throws(() => installPlan('continue'), /対応していません/);
  assert.equal(installPlan('hermes').method,'uv');
  assert.equal(installPlan('goose').method,'github');
  assert.throws(() => issueInstallApproval('unknown'), /登録されていない/);
});

test('Windowsのnpm .cmdは引用符連結せずcallの引数配列で起動する', () => {
  const executable = 'C:\\Users\\tester name\\AppData\\Roaming\\npm\\opencode.cmd';
  assert.deepEqual(agentVersionCommand(executable, 'win32', 'C:\\Windows\\System32\\cmd.exe'), {
    executable: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/c', 'call', executable, '--version'],
  });
  assert.deepEqual(agentVersionCommand('/usr/local/bin/opencode', 'linux'), { executable: '/usr/local/bin/opencode', args: ['--version'] });
});


test('版番号を表示して終了しないCLIは正常扱いせず子プロセスごと停止する',{skip:process.platform!=='win32',timeout:25000},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-probe-timeout-'));
  const original=process.env.WENTIAN_AGENT_SELECTION_CONFIG,originalPath=process.env.PATH;
  try {
    const script=path.join(root,'hanging.cjs'),pidFile=path.join(root,'child.pid'),shim=path.join(root,'probe.cmd');
    await writeFile(script,`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.log('1.0.0');setInterval(()=>{},1000);`);
    await writeFile(shim,`@"${process.execPath}" "${script}"\r\n`);
    const config=path.join(root,'selection.json');await writeFile(config,JSON.stringify({fallback:{probeTimeoutMs:5000}}));process.env.WENTIAN_AGENT_SELECTION_CONFIG=config;
    process.env.PATH=root+path.delimiter+(originalPath||'');
    const result=await probeAgentCli({cli:'probe'});
    assert.equal(result.liveState,'probe_failed');assert.match(result.probeError||'',/制限時間/);
    const pid=Number(await readFile(pidFile,'utf8'));
    assert.throws(()=>process.kill(pid,0),'版番号表示後に残ったCLI本体も停止する必要があります。');
  } finally {
    if(original===undefined)delete process.env.WENTIAN_AGENT_SELECTION_CONFIG;else process.env.WENTIAN_AGENT_SELECTION_CONFIG=original;
    process.env.PATH=originalPath;
    await rm(root,{recursive:true,force:true});
  }
});
