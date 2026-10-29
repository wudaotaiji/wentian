import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentProgress, formatAgentTodoUpdate, formatTodoPanel, formatWorkingStatus } from './agent-progress.js';
import { PassThrough } from 'node:stream';
import type { WriteStream } from 'node:tty';

test('Agent実行中の経過秒数とEsc案内を表示する', () => {
  assert.equal(formatWorkingStatus(19.9), '• Working (19s • esc to interrupt)');
  assert.equal(formatWorkingStatus(-1), '• Working (0s • esc to interrupt)');
});

test('入力欄と共用する進捗は描画コールバックだけを更新し、ANSIカーソル操作を出力しない',t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const stream=new PassThrough() as unknown as WriteStream;Object.defineProperty(stream,'isTTY',{value:true});
  let output='';stream.on('data',chunk=>{output+=chunk.toString()});
  const activity:string[]=[];
  const progress=new AgentProgress(stream,'test',undefined,'compact',text=>activity.push(text));
  try{progress.start();t.mock.timers.tick(1000);progress.stop();assert.equal(output,'');assert.equal(activity.filter(Boolean).length,5);assert.equal(activity.at(-1),'');}
  finally{progress.stop();}
});

test('待機カーソルは次行先頭に置き、進捗更新と終了時には同じ進捗行へ戻る', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const stream = new PassThrough() as unknown as WriteStream;
  Object.defineProperty(stream, 'isTTY', { value: true });
  let output = '';
  stream.on('data', chunk => { output += chunk.toString(); });
  const progress = new AgentProgress(stream);
  try {
    progress.start();
    assert.ok(output.endsWith('\r\n'));
    t.mock.timers.tick(500);
    assert.equal((output.match(/\r\n/g) || []).length, 3);
    assert.equal((output.match(/\x1b\[1A/g) || []).length, 2);
    progress.stop();
    assert.ok(output.endsWith('\x1b[1A\r\x1b[2K'));
  } finally { progress.stop(); }
});

test('TTYのWorking表示へ左から右のANSIグラデーションを適用する', () => {
  const originalTerm = process.env.TERM;
  const originalNoColor = process.env.NO_COLOR;
  process.env.TERM = 'xterm-256color';
  delete process.env.NO_COLOR;
  const stream = new PassThrough() as unknown as WriteStream;
  Object.defineProperty(stream, 'isTTY', { value: true });
  const output: Buffer[] = []; stream.on('data', chunk => output.push(Buffer.from(chunk)));
  const progress = new AgentProgress(stream); progress.start(); progress.stop();
  const written = Buffer.concat(output).toString('utf8');
  assert.ok((written.match(/\x1b\[1;38;5;/g) || []).length > 10);
  if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm;
  if (originalNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = originalNoColor;
});

test('Codex風TODOパネルを4状態で整形する', () => {
  const panel = formatTodoPanel('Wentian Agent', [
    { id: 'a', label: 'Plannerで構造化実行計画を作成', status: 'completed', detail: 'intent=web_research' },
    { id: 'b', label: '外部Agentへ委譲', status: 'in_progress', detail: 'agents=claude,goose' },
    { id: 'c', label: 'LLMへ依頼を送信', status: 'pending', detail: 'model=qwen2.5:7b' },
    { id: 'd', label: '中断された処理', status: 'failed', detail: 'aborted by Esc' },
  ]);
  assert.equal(panel, [
    '# Todos · Wentian Agent',
    '[✓] Plannerで構造化実行計画を作成  intent=web_research',
    '[•] 外部Agentへ委譲  agents=claude,goose',
    '[ ] LLMへ依頼を送信  model=qwen2.5:7b',
    '[!] 中断された処理  aborted by Esc',
  ].join('\n'));
});

test('AgentProgressでTODO追加・更新・完了がパネル再描画を伴って反映される', () => {
  const stream = new PassThrough() as unknown as WriteStream;
  const output: Buffer[] = [];
  stream.on('data', chunk => output.push(Buffer.from(chunk)));
  const logged: string[] = [];
  const progress = new AgentProgress(stream, 'Wentian Agent', text => logged.push(text), 'verbose');
  const todoPlan = progress.addTodo('Plannerで構造化実行計画を作成', 'in_progress');
  assert.equal(progress.snapshot().length, 1);
  assert.equal(progress.snapshot()[0].status, 'in_progress');
  progress.startTodo(todoPlan.id, 'intent=web_research');
  progress.completeTodo(todoPlan.id, 'intent=web_research');
  const todoDelegate = progress.addTodo('外部Agentへ委譲', 'in_progress');
  progress.completeTodo(todoDelegate.id, 'status=completed');
  const written = Buffer.concat(output).toString('utf8');
  assert.match(written, /# Todos · Wentian Agent/);
  assert.match(written, /\[✓\] Plannerで構造化実行計画を作成/);
  assert.match(written, /\[✓\] 外部Agentへ委譲/);
  assert.equal(logged.some(line => /\[✓\] Planner/.test(line)), false);
  progress.stop();
});

test('最終Todoの完了表示後に回答を出力し、回答を最後の表示にする', () => {
  const stream = new PassThrough() as unknown as WriteStream;
  const output: Buffer[] = [];
  stream.on('data', chunk => output.push(Buffer.from(chunk)));
  const progress = new AgentProgress(stream, 'Wentian Agent', undefined, 'verbose');
  const todoAsk = progress.addTodo('LLMへ依頼を送信', 'in_progress', 'wentian-auto/local');

  progress.completeTodoThenLog(todoAsk.id, '回答を受信', '你好！我是 Wentian Agent。');

  const written = Buffer.concat(output).toString('utf8').replace(/\r\x1b\[2K/g, '');
  assert.ok(written.indexOf('[✓] LLMへ依頼を送信  回答を受信') < written.indexOf('你好！我是 Wentian Agent。'));
  assert.ok(written.endsWith('  ╰─\n'));
  assert.match(written, /╭─ 回答\n  │ 你好！我是 Wentian Agent。/);
});

test('実行担当Agentと既知のモデルをTODO見出しへ反映する', () => {
  const stream = new PassThrough() as unknown as WriteStream;
  const output: Buffer[] = []; stream.on('data', chunk => output.push(Buffer.from(chunk)));
  const progress = new AgentProgress(stream, 'Wentian Agent', undefined, 'verbose');
  progress.addTodo('外部Agentへ委譲', 'in_progress');
  progress.setExecutionIdentity('kilo', 'kilo/kilo-auto/free');
  assert.equal(progress.title(), 'Kilo · kilo/kilo-auto/free');
  assert.match(Buffer.concat(output).toString('utf8'), /# Todos · Kilo · kilo\/kilo-auto\/free/);
});

test('Compact Modeは中間出力を畳み、Ctrl+T操作でTranscriptを展開する', () => {
  const stream = new PassThrough() as unknown as WriteStream;
  const output: Buffer[] = []; stream.on('data', chunk => output.push(Buffer.from(chunk)));
  const progress = new AgentProgress(stream, 'Wentian Agent', undefined, 'compact');
  const todo = progress.addTodo('Planner', 'in_progress');
  progress.log('• Called Planner AI\n  └ request');
  progress.completeTodo(todo.id, '完了');
  assert.doesNotMatch(Buffer.concat(output).toString('utf8'), /Called Planner AI/);
  progress.toggleTranscript();
  assert.match(Buffer.concat(output).toString('utf8'), /Called Planner AI/);
  assert.match(progress.summary(), /… \+2 lines \(ctrl \+ t to view transcript\)/);
});

test('Task分解はCompact Modeでも最初から表示する', () => {
  const stream = new PassThrough() as unknown as WriteStream;
  const output: Buffer[] = []; stream.on('data', chunk => output.push(Buffer.from(chunk)));
  const progress = new AgentProgress(stream, 'Wentian Agent', undefined, 'compact');
  progress.announce('## Task breakdown\n- Target: C:\\mywork\\temp');
  assert.match(Buffer.concat(output).toString('utf8'), /Task breakdown/);
  assert.match(progress.transcriptText(), /C:\\mywork\\temp/);
});

test('担当AgentごとのTodo状態をCompact Modeでも即時表示する', () => {
  const stream = new PassThrough() as unknown as WriteStream;
  const output: Buffer[] = []; stream.on('data', chunk => output.push(Buffer.from(chunk)));
  const progress = new AgentProgress(stream, 'Wentian Agent', undefined, 'compact');
  progress.announceAgentTodo('opencode', 'Target確認とSnapshot作成', 'completed', 'target=C:\\mywork\\temp');
  progress.announceAgentTodo('claude', '隔離Staging Workspace準備', 'in_progress', 'role=builder');
  const written = Buffer.concat(output).toString('utf8');
  assert.match(written, /# Todos · Opencode\n\[✓\] Target確認/);
  assert.match(written, /# Todos · Claude\n\[•\] 隔離Staging/);
  assert.match(formatAgentTodoUpdate('kilo', { label: 'Builder実装', status: 'failed', detail: 'failure=timeout' }), /\[!\].*failure=timeout/);
});
