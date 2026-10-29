import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cliLanguage, cliText, configuredCliLanguage, activeCliLanguage, configureCliLanguage, selectCliLanguage, saveCliLanguage } from './cli-language.js';
import { terminalInputStatus, terminalInputHint } from './terminal-appearance.js';
import { formatMarkdownAnswer, formatOutputSection } from './terminal-output.js';
import { formatConversationExecution, conversationTurnPrompt } from './conversation-turn.js';
import { responseLanguage } from './agent-context.js';
import { slashCommandHelp, parseSlashCommand } from './slash-command.js';
import { SlashPicker } from './slash-picker.js';
import { checkStartupUpdate } from './startup-update.js';

test('CLIの明示言語・保存・UI・回答指示を三言語で統一し、入力と回答本文は保持する',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wentian-cli-language-'));
 const keys=['WENTIAN_CLI_SETTINGS_FILE','WENTIAN_CLI_LANGUAGE','WENTIAN_RESPONSE_LANGUAGE'] as const;
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 process.env.WENTIAN_CLI_SETTINGS_FILE=path.join(root,'language.json');delete process.env.WENTIAN_CLI_LANGUAGE;delete process.env.WENTIAN_RESPONSE_LANGUAGE;
 try{
  assert.equal(configuredCliLanguage(),undefined);assert.equal(cliLanguage(),'ja');
  process.env.WENTIAN_CLI_LANGUAGE='en';assert.equal(cliLanguage(),'en');assert.equal(activeCliLanguage(),undefined);assert.equal(responseLanguage('任意の入力'),'ja');delete process.env.WENTIAN_CLI_LANGUAGE;
  for(const [language,title,placeholder,modelLabel] of [['ja','入力','メッセージを入力…','設定モデル'],['en','Input','Enter a message…','Configured model'],['zh','输入','请输入消息…','配置模型']]){
   assert.deepEqual(configureCliLanguage(['agent','--language',language,'--','--language','en']),['agent','--','--language','en']);
   assert.equal(cliLanguage(),language);assert.equal(responseLanguage('任意の入力'),language);
   const status=terminalInputStatus({model:'requested/model',forcedAgent:'codex',forcedModel:'configured/model',sessionId:'test-session',images:2});
   assert.ok(status.join('\n').includes(modelLabel+': configured/model'));
   assert.ok(terminalInputHint({status}).includes('Ctrl+J'));
   assert.ok(formatOutputSection('input','你好！ /language ja').includes('╭─ '+title));
   assert.ok(formatOutputSection('input','你好！ /language ja').includes('你好！ /language ja'));
   assert.ok(formatMarkdownAnswer('原文：こんにちは！').includes('原文：こんにちは！'));
   assert.equal(cliText('メッセージを入力…'),placeholder);
   assert.ok(formatConversationExecution({source:'external',agent:'codex',configuredModel:'configured/model',elapsedMs:7800}).includes(modelLabel+': configured/model'));
   const help=slashCommandHelp(),picker=new SlashPicker();picker.update('/');
   if(language==='en')assert.doesNotMatch(help+picker.render()+status.join('\n'),/[\u3040-\u30ff\u3400-\u9fff]/);
   if(language==='zh')assert.doesNotMatch(help+picker.render()+status.join('\n'),/[\u3040-\u30ff]/);
   assert.ok(help.includes('/language [ja|en|zh]'));
   assert.ok(conversationTurnPrompt().includes('設定言語: '+language));
   const logs:string[]=[];
   await checkStartupUpdate({check:async()=>({relation:'current',currentVersion:'0.6.0',updateAvailable:false,canApply:false}) as any,emit:text=>logs.push(text)});
   assert.equal(logs[1],cliText('Wentian {0} は最新です。','0.6.0'));
   await saveCliLanguage(language);assert.equal(JSON.parse(await readFile(process.env.WENTIAN_CLI_SETTINGS_FILE!,'utf8')).language,language);
  }
  assert.equal(cliText('現在のモデル: {0}','user/{1}'), '当前模型：user/{1}');
  assert.deepEqual(parseSlashCommand('/language en'),{name:'language',argument:'en'});
  await assert.rejects(saveCliLanguage('fr'));assert.equal(cliLanguage(),'zh');
  assert.throws(()=>configureCliLanguage(['agent','--language']),/ja/);
  process.env.WENTIAN_RESPONSE_LANGUAGE='en';assert.equal(responseLanguage('你好'),'en');
 }finally{
  selectCliLanguage('ja');for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  await rm(root,{recursive:true,force:true});
 }
});
