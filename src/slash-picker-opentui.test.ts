import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestRenderer } from '@opentui/core/testing';
import { PassThrough } from 'node:stream';
import { Console } from 'node:console';
import type { WriteStream } from 'node:tty';
import { RGBA, TextareaRenderable, type CapturedSpan, type CliRendererExternalOutputEvent } from '@opentui/core';
import { readOpenTuiDraft } from './terminal-draft.js';
import { slashCommandEntries } from './slash-command.js';
import { selectCliLanguage } from './cli-language.js';
import { terminalInputStatus, type TerminalInputLifecycle } from './terminal-appearance.js';
import { AgentProgress } from './agent-progress.js';
import { terminalTranscript } from './terminal-transcript.js';
import { formatOutputSection, formatConversationSeparator } from './terminal-output.js';
import {selectionMenu,navigateSelection} from './terminal-selection.js';

test('モデル・Agent選択の上下キーが通常履歴へ流れず、選択コマンドを確定する',{skip:!process.versions.bun},async()=>{
 for(const kind of ['model','agent'] as const){
  const output=new PassThrough() as unknown as WriteStream;output.columns=120;output.rows=30;
  const ui=await createTestRenderer({width:120,height:30,screenMode:'split-footer',footerHeight:8});
  const menu=selectionMenu(kind,[{id:'auto',label:'自動',detail:''},{id:'disabled',label:'不可',detail:'',disabled:true},{id:'fixture-id',label:'中文模型・日本語Agent',detail:''}],'auto');
  const result=readOpenTuiDraft(process.stdin,output,'wentian> ',undefined,'',undefined,direction=>navigateSelection(menu,direction),async()=>ui.renderer,{status:['モデル選択・选择智能体']});await Promise.resolve();
  try{await ui.flush();ui.mockInput.pressArrow('down');await ui.flush();const textarea=ui.renderer.root.findDescendantById('wentian-agent-input') as TextareaRenderable;assert.equal(textarea.plainText,`/${kind} fixture-id`);assert.match(ui.captureCharFrame(),/fixture-id/);ui.mockInput.pressEnter();assert.equal(await result,`/${kind} fixture-id`);}
  finally{ui.renderer.destroy();}
 }
});

test('選択中のEscは入力済みの候補も取り消す',{skip:!process.versions.bun},async()=>{
 const output=new PassThrough() as unknown as WriteStream;output.columns=120;output.rows=30;
 const ui=await createTestRenderer({width:120,height:30,screenMode:'split-footer',footerHeight:8});
 const result=readOpenTuiDraft(process.stdin,output,'wentian> ',undefined,'',undefined,()=>'/agent goose',async()=>ui.renderer,{selection:true});await Promise.resolve();
 try{await ui.flush();ui.mockInput.pressArrow('down');await ui.flush();ui.mockInput.pressEscape();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await result,null);}finally{ui.renderer.destroy();}
});

// Windowsの本番と同じBunで実行し、ネイティブ描画と実際のキー伝播を検証します。
// Node.jsの通常テストではFFI（外部関数インターフェース / Foreign Function Interface）が利用できないため除外します。
test('OpenTUIの実描画で一覧表示・選択・取消・送信が連携する', { skip: !process.versions.bun }, async t => {
  const previousNoColor=process.env.NO_COLOR, previousTerm=process.env.TERM;
  delete process.env.NO_COLOR;process.env.TERM='xterm-256color';
  t.after(()=>{if(previousNoColor===undefined)delete process.env.NO_COLOR;else process.env.NO_COLOR=previousNoColor;if(previousTerm===undefined)delete process.env.TERM;else process.env.TERM=previousTerm;});
  const ui = await createTestRenderer({ width: 120, height: 30, screenMode: 'split-footer', footerHeight: 8 });
  let historyCalls = 0;
  const output = Object.create(process.stdout); Object.defineProperty(output, 'isTTY', { value: true });
  Object.defineProperty(output, 'columns', { value: 120, writable: true });
  const terminalWrites: string[] = [];
  output.write = (value: string) => { terminalWrites.push(String(value)); return true; };
  const result = readOpenTuiDraft(process.stdin, output, 'wentian> ', undefined, '', undefined,
    () => { historyCalls++; return '以前の入力'; }, async config => {
      // 次の入力待ちへ移る際も、通常出力に残した回答とエラーを消去しない設定を検証します。
      assert.equal(config?.clearOnShutdown, false);
      assert.equal(config?.externalOutputMode, 'capture-stdout');
      assert.equal(config?.consoleMode, 'disabled', '入力・回答を非表示のデバッグ領域へ取り込みません');
      return ui.renderer;
    }, { theme: 'green', status: ['Wentian · Agent: codex（強制優先）', '前回: codex / 5.8s'] });
  await Promise.resolve();
  try {
    await ui.flush();
    const initial = ui.captureCharFrame();
    assert.match(initial, /Agent: codex/); assert.match(initial, /5\.8s/);
    assert.doesNotMatch(initial, /入力してください/);
    assert.match(initial, /メッセージを入力/);
    assert.ok(initial.indexOf('メッセージを入力') < initial.indexOf('Wentian'), '入力欄の下に状態情報を表示します');
    assert.ok(initial.indexOf('メッセージを入力') < initial.indexOf('─'.repeat(120)) && initial.indexOf('─'.repeat(120)) < initial.indexOf('Wentian'), '入力欄と状態欄の間に横幅いっぱいの区切り線を描画します');
    output.columns=80;output.emit('resize');await ui.flush();
    assert.match(ui.captureCharFrame(),/^─{80} *$/m,'端末幅の変更に合わせて区切り線を更新します');
    output.columns=120;output.emit('resize');await ui.flush();
    assert.ok(ui.captureSpans().lines.flatMap(line => line.spans).some(span => span.bg.equals(RGBA.fromHex('#16372e'))), '入力領域を選択した緑色で描画します');
    const statusLine=ui.captureSpans().lines.find(line=>line.spans.map(span=>span.text).join('').includes('Agent: codex'));
    assert.ok(statusLine?.spans.some(span=>span.bg.equals(RGBA.fromHex('#0b211b'))), '状態領域は入力欄と異なる濃い背景色で描画します');
    await ui.mockInput.typeText('/');
    await ui.flush();
    const frame = ui.captureCharFrame();
    assert.match(frame, /> \/status/);
    assert.ok(frame.indexOf('> /status') < frame.indexOf('Wentian'), '候補表示中も状態情報は下側へ保持します');
    // 表示領域に収まらない末尾候補はページ外になるため、登録件数の表示で確認します。
    // `/quit`自体の解析と候補生成はslash-command.test.tsで個別に検証します。
    assert.ok(frame.includes('(1/' + slashCommandEntries.length + ')'));
    // 実際の描画結果で背景色を確認し、移動後に古い選択色が残らないことも検証します。
    const highlighted = () => ui.captureSpans().lines.flatMap(line => line.spans)
      .filter(span => span.bg.equals(RGBA.fromHex('#264f78'))).map(span => span.text).join('');
    assert.match(highlighted(), /> \/status/);
    ui.mockInput.pressArrow('down');
    await ui.flush();
    assert.match(highlighted(), /> \/update/);
    assert.doesNotMatch(highlighted(), /\/status/);
    ui.mockInput.pressTab();
    const textarea = ui.renderer.root.findDescendantById('wentian-agent-input') as TextareaRenderable;
    assert.equal(textarea.plainText, '/update');
    assert.equal(historyCalls, 0);
    textarea.setText('/');
    ui.mockInput.pressEscape();
    // 単独EscとAlt修飾シーケンスの判別待ち時間を越えてから次のキーを送ります。
    await new Promise(resolve => setTimeout(resolve, 100));
    ui.mockInput.pressArrow('up');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(textarea.plainText, '以前の入力');
    assert.equal(historyCalls, 1);
    textarea.setText('/st');
    ui.mockInput.pressEnter();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(textarea.plainText, '/status');
    ui.mockInput.pressEnter();
    assert.equal(await result, '/status');
    assert.doesNotMatch(ui.captureCharFrame(), /メッセージを入力|Wentian|\/status|─{10}/, '送信後は区切り線を含む入力領域だけを消去します');
    assert.deepEqual(terminalWrites.slice(-2), ['\x1b7', '\x1b8\r'], '入力領域先頭のカーソルを破棄前後で保存・復元し、空行を履歴へ残しません');
  } finally {
    ui.renderer.destroy();
  }
});

test('OpenTUIの入力欄・状態欄・コマンド候補を英語と中国語で実描画する',{skip:!process.versions.bun},async()=>{
 try{
  for(const [locale,placeholder,label]of [['en','Enter a message','Configured model'],['zh','请输入消息','配置模型']]){
   selectCliLanguage(locale);
   const ui=await createTestRenderer({width:120,height:30,screenMode:'split-footer',footerHeight:8});
   const output=Object.create(process.stdout);Object.defineProperty(output,'isTTY',{value:true});output.write=()=>true;
   const result=readOpenTuiDraft(process.stdin,output,'wentian> ',undefined,'',undefined,undefined,async()=>ui.renderer,{status:()=>terminalInputStatus({model:'auto',forcedAgent:'codex',forcedModel:'gpt-test',sessionId:'test',images:0})});
   await Promise.resolve();
   try{
    await ui.flush();const frame=ui.captureCharFrame();assert.ok(frame.includes(placeholder));assert.ok(frame.includes(label));
    await ui.mockInput.typeText('/language');await ui.flush();
    const candidates=ui.captureCharFrame();
    if(locale==='en')assert.doesNotMatch(candidates,/[\u3040-\u30ff\u3400-\u9fff]/);
    if(locale==='zh')assert.doesNotMatch(candidates,/[\u3040-\u30ff]/);
    const textarea=ui.renderer.root.findDescendantById('wentian-agent-input') as TextareaRenderable;
    textarea.setText('你好');ui.mockInput.pressEnter();assert.equal(await result,'你好');
   }finally{ui.renderer.destroy();}
  }
 }finally{selectCliLanguage('ja');}
});

test('処理中も入力欄とカーソルを保持し、次の下書き・中断・回答表示後の再送信ができる',{skip:!process.versions.bun},async t=>{
 const previousNoColor=process.env.NO_COLOR,previousTerm=process.env.TERM;delete process.env.NO_COLOR;process.env.TERM='xterm-256color';
 t.after(()=>{if(previousNoColor===undefined)delete process.env.NO_COLOR;else process.env.NO_COLOR=previousNoColor;if(previousTerm===undefined)delete process.env.TERM;else process.env.TERM=previousTerm;});
 const stream=new PassThrough();stream.resume();
 const output=Object.assign(stream,{isTTY:true,columns:100,rows:30,getColorDepth:()=>24}) as unknown as WriteStream;
 const ui=await createTestRenderer({stdout:output,width:100,height:30,screenMode:'split-footer',footerHeight:9,externalOutputMode:'capture-stdout',exitOnCtrlC:false});
 const transcriptSpans:CapturedSpan[]=[];ui.renderer.on('external_output',(event:CliRendererExternalOutputEvent)=>transcriptSpans.push(...event.snapshot.getSpanLines().flatMap(line=>line.spans)));
 const lifecycle:TerminalInputLifecycle={};let creations=0,interrupts=0;
 const transcriptOutput=terminalTranscript(output,lifecycle);
 const presentation={lifecycle,status:['Wentian fixture','Session fixture']};
 const factory=async(config: Parameters<typeof import('@opentui/core').createCliRenderer>[0])=>{assert.equal(config?.consoleMode,'disabled');creations++;return ui.renderer};
 const first=readOpenTuiDraft(process.stdin,output,'wentian> ',undefined,'',undefined,undefined,factory,presentation);
 const progress=new AgentProgress(transcriptOutput,'fixture',undefined,'compact',text=>lifecycle.controller?.activity(text));
 try{
  await Promise.resolve();await ui.flush();
  const textarea=ui.renderer.root.findDescendantById('wentian-agent-input') as TextareaRenderable;
  await ui.mockInput.typeText('first request');ui.mockInput.pressEnter();assert.equal(await first,'first request');await ui.flush();
  assert.ok(lifecycle.controller);assert.ok(textarea.focused);assert.equal(textarea.plainText,'');
  // 本番CLIと同じConsole経路で、入力・回答・失敗理由が通常出力へ到達することを確認します。
  const transcriptConsole=new Console({stdout:transcriptOutput,stderr:transcriptOutput});
  transcriptConsole.log(formatOutputSection('input','你好！日本語・中文・👩‍💻',true));
  transcriptConsole.log(formatOutputSection('answer','回答: 東京の天気を確認します。',true));transcriptConsole.error('Agent応答に失敗しました: 会話モデルへ接続できず、回答を取得できませんでした。');
  transcriptConsole.log(formatConversationSeparator(100,true));
  await ui.flush();const transcript=ui.externalOutput.takeText();
  for(const expected of ['╭─ 入力','你好！日本語・中文・👩‍💻','回答: 東京の天気を確認します。','会話モデルへ接続できず、回答を取得できませんでした。','─'.repeat(100)])assert.ok(transcript.includes(expected),transcript);
  assert.ok(!transcript.includes('\x1b'),transcript);
  assert.ok(transcriptSpans.some(span=>span.text.includes('入力')&&span.fg.equals(RGBA.fromIndex(6))),'入力枠をシアンで描画します');
  assert.ok(transcriptSpans.some(span=>span.text.includes('╰─')&&span.fg.equals(RGBA.fromIndex(6))),'入力枠の下端もシアンで描画します');
  assert.ok(transcript.split('\n').some(line=>line==='─'.repeat(100)),'上側の区切り線を第1列から端末幅いっぱいに描画します');
  assert.ok(transcriptSpans.some(span=>span.text.includes('回答')&&span.fg.equals(RGBA.fromIndex(2))),'回答枠を緑で描画します');
  const longText='日本語の文章と中文长句、👩‍💻、é。'.repeat(20);
  transcriptConsole.log(longText);await ui.flush();
  assert.equal(ui.externalOutput.takeText().replace(/\s/g,''),longText.replace(/\s/g,''),'全角・結合文字・絵文字を行末でも失いません');
  assert.ok(textarea.focused);
  progress.start();await ui.flush();
  const activityColors=ui.captureSpans().lines.flatMap(line=>line.spans).filter(span=>span.fg.intent==='indexed').map(span=>span.fg.slot);
  assert.ok(new Set(activityColors).size>2,'進捗を複数色のグラデーションで描画します');
  progress.stop();lifecycle.controller!.activity('Working 0');await ui.flush();
  await ui.mockInput.typeText('next draft');await ui.flush();
  const cursor=ui.renderer.getCursorState(),cursorFromBottom=cursor.y-ui.renderer.footerHeight;
  for(let i=1;i<=4;i++){
   lifecycle.controller!.activity('Working '+i);await ui.flush();
   const current=ui.renderer.getCursorState();assert.equal(current.x,cursor.x);assert.equal(current.y,cursor.y);assert.ok(textarea.focused);
   assert.ok(ui.captureCharFrame().includes('next draft'));assert.ok(ui.captureCharFrame().includes('Working '+i),ui.captureCharFrame());
  }
  // 処理中のEnterは二重実行せず、次の下書きも消しません。
  ui.mockInput.pressEnter();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(textarea.plainText,'next draft');
  lifecycle.interrupt=()=>{interrupts++};ui.mockInput.pressEscape();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(interrupts,1);
  ui.mockInput.pressKey('c',{ctrl:true});await ui.flush();assert.equal(interrupts,2);assert.equal(textarea.plainText,'next draft');
  progress.announce('fixture answer');await ui.flush();assert.ok(ui.externalOutput.takeText().includes('fixture answer'));assert.equal(textarea.plainText,'next draft');assert.ok(textarea.focused);
  // split-footerのローカル座標は高さに従って変わるため、端末下端からの物理位置を比較します。
  assert.equal(ui.renderer.getCursorState().x,cursor.x);assert.equal(ui.renderer.getCursorState().y-ui.renderer.footerHeight,cursorFromBottom);
  progress.stop();
  const second=readOpenTuiDraft(process.stdin,output,'wentian> ',undefined,'',undefined,undefined,factory,presentation);await Promise.resolve();await ui.flush();
  assert.equal(creations,1,'送信・処理・次の入力で描画器を作り直しません');
  assert.equal(textarea.plainText,'next draft');
  for(let i=0;i<5;i++)ui.mockInput.pressArrow('left');
  await ui.flush();lifecycle.controller!.insertText('音声');await ui.flush();
  assert.equal(textarea.plainText,'next 音声draft');assert.ok(textarea.focused);
  let voiceStops=0;lifecycle.voiceStop=()=>{voiceStops++};ui.mockInput.pressKey('r',{ctrl:true});await ui.flush();
  assert.equal(voiceStops,1);assert.equal(textarea.plainText,'next 音声draft');
  ui.mockInput.pressEnter();assert.equal(await second,'next 音声draft');
  ui.externalOutput.clear();
  for(const width of [24,80,120]) {
   ui.renderer.resize(width,30);output.columns=width;output.emit('resize');await ui.flush();
   transcriptConsole.log(longText);await ui.flush();
   assert.equal(ui.externalOutput.takeText().replace(/\s/g,''),longText.replace(/\s/g,''),`幅${width}でも日本語・中文を欠落させません`);
   assert.ok(textarea.focused);
  }
  process.env.NO_COLOR='1';transcriptSpans.length=0;
  transcriptConsole.log(formatOutputSection('input','色無効',true));await ui.flush();
  assert.ok(transcriptSpans.every(span=>span.fg.intent!=='indexed'),'NO_COLORでは会話の色指定を外します');
  progress.start();await ui.flush();
  assert.ok(ui.captureSpans().lines.flatMap(line=>line.spans).every(span=>span.fg.intent!=='indexed'),'NO_COLORでは進捗のグラデーションも外します');
  progress.stop();
  lifecycle.controller!.close();assert.equal(lifecycle.controller,undefined);
 }finally{progress.stop();lifecycle.controller?.close();ui.renderer.destroy();}
});
