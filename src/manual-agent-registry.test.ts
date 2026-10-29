import assert from 'node:assert/strict';
import test from 'node:test';
import { validateManualAgent } from './manual-agent-registry.js';

test('手動外部エージェントの安全な登録値を受理する', () => {
  assert.equal(validateManualAgent({ id: 'my-agent', name: 'My Agent', cli: 'my-agent.cmd' }).cli, 'my-agent.cmd');
});

test('手動外部エージェントのコマンド注入文字を拒否する', () => {
  assert.throws(() => validateManualAgent({ id: 'bad-agent', name: 'Bad', cli: 'agent & whoami' }), /CLI名/);
});
