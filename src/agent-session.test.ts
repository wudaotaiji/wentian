import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addTokenUsage, createAgentSession, createSessionId, formatSessionExit, listAgentSessions, loadAgentSession, saveAgentSession } from './agent-session.js';

test('Session IDを日時とランダム末尾で生成する', () => {
  assert.match(createSessionId(new Date('2026-09-04T12:34:56Z')), /^wt-20260904-123456-[a-f0-9]{8}$/);
});

test('Token使用量を集計し、終了時に再開コマンドを表示する', () => {
  const usage = { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 };
  addTokenUsage(usage, { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 4 } });
  assert.deepEqual(usage, { input: 120, cachedInput: 80, output: 15, reasoning: 4, total: 135 });
  const output = formatSessionExit({ version: '1.0', id: 'wt-20260904-123456-abcdef12', createdAt: '', updatedAt: '', workspace: 'C:\\work', model: 'model', messages: [], title: '挨拶', usage });
  assert.match(output, /Token usage: total=135 input=120 \(\+ 80 cached\) output=15 \(reasoning 4\)/);
  assert.match(output, /wentian resume wt-20260904-123456-abcdef12/);
  assert.match(output, /挨拶/);
});

test('会話だけを伏字化して保存し再開できる', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-session-'));
  const previous = process.env.WENTIAN_SESSION_PATH; process.env.WENTIAN_SESSION_PATH = root;
  try {
    const session = await createAgentSession('C:\\work', 'wentian-auto/local');
    await saveAgentSession(session, [{ role: 'user', content: 'api_key=secret-value' }, { role: 'tool', content: 'raw' }, { role: 'assistant', content: '完了' }]);
    const loaded = await loadAgentSession(session.id);
    assert.equal(loaded.messages.length, 2);
    assert.doesNotMatch(await readFile(path.join(root, `${session.id}.json`), 'utf8'), /secret-value|raw/);
    assert.equal((await listAgentSessions())[0].id, session.id);
  } finally { if (previous === undefined) delete process.env.WENTIAN_SESSION_PATH; else process.env.WENTIAN_SESSION_PATH = previous; }
});
