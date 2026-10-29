import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMemoryLayer } from './memory-layer.js';
import { compactConversation, isImmovableMessage, pruneOldToolOutputs, type CompactorConversationMessage } from './agent-compactor.js';
import { createGoal, addTodo } from './goal-store.js';

function withTempCwd<T>(setup: (cwd: string) => void, fn: (cwd: string) => Promise<T> | T): Promise<T> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'wentian-mem-'));
  setup(cwd);
  return Promise.resolve(fn(cwd)).finally(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

test('buildMemoryLayer は存在しないファイルでもエラーにならない', async () => {
  await withTempCwd(() => { /* 何も作らない */ }, async cwd => {
    const messages = await buildMemoryLayer({ cwd });
    // runtime context だけは常に入る
    assert.ok(messages.length >= 1);
    assert.ok(messages.some(m => m.metadata?.source === 'runtime'));
  });
});

test('AGENTS.md / SOUL.md / .wentian/memory/*.md を読み source=memory-layer メタを付ける', async () => {
  await withTempCwd(cwd => {
    writeFileSync(path.join(cwd, 'AGENTS.md'), '- テスト\n- ルール', 'utf8');
    writeFileSync(path.join(cwd, 'SOUL.md'), '# 理念\n大切にしたいこと', 'utf8');
    mkdirSync(path.join(cwd, '.wentian', 'memory'), { recursive: true });
    writeFileSync(path.join(cwd, '.wentian', 'memory', '01-overview.md'), '# 概要\nこれは概要', 'utf8');
    writeFileSync(path.join(cwd, '.wentian', 'memory', '02-rules.md'), '# ルール\n禁止事項', 'utf8');
  }, async cwd => {
    const messages = await buildMemoryLayer({ cwd });
    const labels = messages.map(m => m.metadata?.source);
    assert.ok(labels.includes('memory-layer'));
    const merged = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    assert.match(merged, /AGENTS\.md/);
    assert.match(merged, /SOUL\.md/);
    assert.match(merged, /01-overview\.md/);
    assert.match(merged, /02-rules\.md/);
  });
});

test('全メモリメッセージに metadata.immovable=true が付き isImmovableMessage で識別できる', async () => {
  await withTempCwd(cwd => {
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'rule', 'utf8');
  }, async cwd => {
    const messages = await buildMemoryLayer({ cwd });
    for (const m of messages) {
      if (m.metadata?.source === 'memory-layer' || m.metadata?.source === 'goal-context') {
        assert.equal(isImmovableMessage(m), true);
        assert.equal(m.metadata?.immovable, true);
      }
    }
  });
});

test('WENTIAN_SYSTEM_POLICY 環境変数は AGENTS.md より優先される', async () => {
  await withTempCwd(cwd => {
    writeFileSync(path.join(cwd, 'AGENTS.md'), 'agents-from-file', 'utf8');
  }, async cwd => {
    const messages = await buildMemoryLayer({ cwd, env: { WENTIAN_SYSTEM_POLICY: 'env-policy-content' } });
    const merged = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    assert.match(merged, /env-policy-content/);
  });
});

test('Memory Layer は compactConversation で要約化されずそのまま保持される', async () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys', metadata: { immovable: true, source: 'memory-layer' } },
    { role: 'user', content: '依頼1' },
    { role: 'assistant', content: '回答1' },
    { role: 'tool', name: 'run_command', content: 'x'.repeat(20_000) },
    { role: 'user', content: '依頼2' },
    { role: 'assistant', content: '回答2' },
    { role: 'tool', name: 'read_file', content: 'y'.repeat(20_000) },
    { role: 'user', content: '依頼3' },
    { role: 'assistant', content: '回答3' },
    // Memory Layer 由来の追加 system (middle に immovable があるケース)
    { role: 'system', content: 'MEMORY-CONTENT-MUST-SURVIVE', metadata: { immovable: true, source: 'memory-layer' } },
    { role: 'assistant', content: '回答4' },
  ];
  const result = compactConversation(messages, { contextTokens: 8_192, keepTail: 4 });
  const all = JSON.stringify(result.compacted);
  assert.match(all, /MEMORY-CONTENT-MUST-SURVIVE/, 'Memory Layer は要約されずに保持される');
  // 要約マーカーが入っている
  assert.ok(result.compacted.some(m => typeof m.content === 'string' && m.content.includes('Wentian Agent 自動要約')));
});

test('Memory Layer は pruneOldToolOutputs で削除されない', async () => {
  const messages: CompactorConversationMessage[] = [
    { role: 'system', content: 'sys', metadata: { immovable: true, source: 'memory-layer' } },
    { role: 'user', content: '依頼1' },
    { role: 'assistant', content: '回答1' },
    { role: 'tool', name: 'run_command', content: 'x'.repeat(20_000) },
    { role: 'user', content: '依頼2' },
    { role: 'assistant', content: '回答2' },
    // immovable な tool (仮に system message として注入された memory)
    { role: 'system', content: 'MEMORY-MUST-SURVIVE-PRUNE', metadata: { immovable: true, source: 'memory-layer' } },
    { role: 'user', content: '依頼3' },
  ];
  const result = pruneOldToolOutputs(messages);
  const all = JSON.stringify(result.pruned);
  assert.match(all, /MEMORY-MUST-SURVIVE-PRUNE/);
});

test('Memory Layer に Goal context を混ぜると progress が出力される', async () => {
  const goal = await createGoal({ title: 'phase2-test', description: 'Memory Layer 経由で goal context を流す' });
  const todo = await addTodo(goal, { title: '最初のTODO' });
  const messages = await buildMemoryLayer({ cwd: process.cwd(), goal });
  const goalMessage = messages.find(m => m.metadata?.source === 'goal-context');
  assert.ok(goalMessage, 'goal-contextメッセージが存在する');
  const content = typeof goalMessage.content === 'string' ? goalMessage.content : '';
  assert.match(content, new RegExp(goal.id));
  assert.match(content, new RegExp(todo.title));
  assert.match(content, /progress: 0\/1/);
});

test('大きすぎる memory file は切り詰めて読まれる', async () => {
  await withTempCwd(cwd => {
    const huge = 'a'.repeat(200_000);
    writeFileSync(path.join(cwd, 'AGENTS.md'), huge, 'utf8');
  }, async cwd => {
    const messages = await buildMemoryLayer({ cwd });
    const merged = messages.map(m => typeof m.content === 'string' ? m.content : '').join('\n');
    assert.ok(merged.length < 200_000, '200KB全文は入らない');
    assert.match(merged, /省略/);
  });
});
