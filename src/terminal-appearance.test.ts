import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTerminalTheme, saveTerminalTheme, terminalThemes, terminalInputHint, terminalInputStatus } from './terminal-appearance.js';
import { parseSlashCommand, filterSlashCommands } from './slash-command.js';

test('入力背景の選択を保存・読戻しし、不正な指定は既存設定を変更しない', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'wentian-input-theme-')), previous=process.env.WENTIAN_TERMINAL_SETTINGS_FILE;
  process.env.WENTIAN_TERMINAL_SETTINGS_FILE=path.join(root,'theme.json');
  t.after(async()=>{if(previous===undefined)delete process.env.WENTIAN_TERMINAL_SETTINGS_FILE;else process.env.WENTIAN_TERMINAL_SETTINGS_FILE=previous;await rm(root,{recursive:true,force:true});});
  assert.equal(readTerminalTheme(),'blue');
  for(const theme of Object.keys(terminalThemes)){await saveTerminalTheme(theme);assert.equal(readTerminalTheme(),theme);}
  await assert.rejects(saveTerminalTheme('unknown'));assert.equal(readTerminalTheme(),'none');
  await writeFile(process.env.WENTIAN_TERMINAL_SETTINGS_FILE,'broken');assert.equal(readTerminalTheme(),'blue');
  assert.deepEqual(parseSlashCommand('/theme green'),{name:'theme',argument:'green'});
  assert.ok(filterSlashCommands('th').some(item=>item.name==='theme'));
});

test('待機表示は設定と前回実行を区別し、二重の入力要求を含まない',()=>{
  const status=terminalInputStatus({model:'wentian-auto/all',forcedAgent:'codex',forcedModel:'configured/model',sessionId:'test-session-1234',images:2,lastExecution:{source:'external',agent:'opencode',elapsedMs:7610}});
  const hint=terminalInputHint({status});
  assert.match(hint,/Agent: codex（強制優先）/);assert.match(hint,/設定モデル: configured\/model/);
  assert.match(hint,/画像: 2/);assert.match(hint,/前回: opencode \/ 7\.6s/);
  assert.match(hint,/Ctrl\+J/);assert.doesNotMatch(hint,/入力してください/);
  const automatic=terminalInputStatus({model:'wentian-auto/all',sessionId:'test',images:0}).join('\n');
  assert.match(automatic,/自動選択.*要求モデル/);assert.match(automatic,/未実行/);
  const local=terminalInputStatus({model:'wentian-auto/local',sessionId:'test',images:0}).join('\n');
  assert.match(local,/要求モデル: wentian-auto\/local（全経路へ自動切替）/);
  const failed=terminalInputStatus({model:'auto',sessionId:'test',images:0,lastStatus:'failed'}).join('\n');
  assert.match(failed,/failed（実行情報なし）/);assert.doesNotMatch(failed,/未実行/);
  let images=0;const live={status:()=>terminalInputStatus({model:'auto',sessionId:'test',images})};
  assert.match(terminalInputHint(live),/画像: 0/);images=1;assert.match(terminalInputHint(live),/画像: 1/);
});
