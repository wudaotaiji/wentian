import test from 'node:test';
import assert from 'node:assert/strict';
import { chatFallbackAgents } from './chat-fallback-policy.js';
import type { AgentConnection } from './agent-connection-policy.js';

test('ローカル・リモート・旧free・直接指定は別の外部Agentへ切り替えない', () => {
  for (const model of ['wentian-auto/local','wentian-auto/remote','wentian-auto/free','provider/model']) assert.deepEqual(chatFallbackAgents(model, ['codex'], [], {}), []);
  assert.deepEqual(chatFallbackAgents('wentian-auto/all', ['codex'], [], {}), ['codex']);
  assert.deepEqual(chatFallbackAgents('wentian-auto/all', ['codex'], ['codex'], {}), []);
});

test('無料Agent限定は接続・料金区分・期限・Ready・除外をすべて満たす候補だけ使う', () => {
  const base: AgentConnection = { mode: 'free', model: 'opencode/test-free', status: 'verified', checkedAt: '', expiresAt: new Date(2000).toISOString(), fingerprint: '', policyHash: '' };
  const connections = { opencode: base, codex: { ...base, model: 'gpt-any', mode: 'native' as const }, kilo: { ...base, model: 'kilo/kilo-auto/free', expiresAt: new Date(500).toISOString() } };
  assert.deepEqual(chatFallbackAgents('wentian-auto/free-agents', ['opencode','codex','kilo'], [], connections, 1000), ['opencode']);
  assert.deepEqual(chatFallbackAgents('wentian-auto/free-agents', ['codex'], [], connections, 1000), []);
  assert.deepEqual(chatFallbackAgents('wentian-auto/free-agents', ['opencode'], ['opencode'], connections, 1000), []);
});
