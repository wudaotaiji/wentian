import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExternalAgentCommand } from './external-orchestrator.js';
import { buildGroupConversationCommand, conversationRunnerAgents } from './group-agent-responder.js';
import { connectionStatusUpdate } from './agent-connection-maintenance.js';
import { AGENT_CATALOG } from './agent-marketplace.js';
import { buildModelChoices } from './agent-model-selection.js';
import { saveModelPreference } from './agent-model-selection.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExternalAgentStatus } from './external-agents.js';
import type { AgentConnection } from './agent-connection-policy.js';

const connection: AgentConnection = { mode: 'native', model: 'fixture:cloud', status: 'verified', checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), fingerprint: 'fixture', policyHash: 'fixture' };
const agent: ExternalAgentStatus = { id: 'ollama', name: 'Ollama', state: 'needs_recheck', stateLabel: '', note: '', liveState: 'healthy', freshWithin24Hours: true, connection };
test('Ollamaは他CLIやGatewayを経由せず選択したモデルを直接実行する', () => {
  const command = buildGroupConversationCommand('ollama', '質問', process.cwd(), connection)!;
  assert.ok(conversationRunnerAgents.has('ollama'));
  assert.equal(AGENT_CATALOG.find(item => item.id === 'ollama')?.cli, 'ollama');
  assert.equal(command.executable, 'ollama');
  assert.deepEqual(command.args.slice(0, 2), ['run', 'fixture:cloud']);
  assert.ok(command.args[2].includes('質問'));
  assert.ok(buildExternalAgentCommand('ollama', '編集して', process.cwd(), 'builder', { attempt: 0 }, connection)?.args.some(arg => arg.endsWith('hosted-model-agent.ts')));
  assert.equal(buildGroupConversationCommand('ollama', '質問', process.cwd(), { ...connection, mode: 'local' }), undefined);
});
test('直接モデルだけを候補とし、未接続を利用可能にせず、作業合格を偽装しない', async () => {
  const choices = buildModelChoices('ollama', [], [{ id: 'ollama/fixture:cloud' }], [{ model: 'fixture:cloud' }]);
  assert.deepEqual(choices.map(item => item.model), ['fixture:cloud']);
  assert.equal(choices[0].mode, 'native');
  const ready = connectionStatusUpdate(agent, connection);
  assert.equal(ready.state, 'needs_recheck');
  assert.equal(ready.stateLabel, '接続確認済み・作業未検証');
  assert.equal(ready.workEvidence, undefined);
  assert.equal(connectionStatusUpdate(agent, { ...connection, status: 'failed' }).state, 'needs_recheck');

});
test('LM Studioの接続先と信頼済み試験定義を隔離ワーカーへ明示的に引き継ぐ', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'wentian-hosted-options-'));
  const previous=process.env.WENTIAN_AGENT_MODEL_PREFERENCES;
  process.env.WENTIAN_AGENT_MODEL_PREFERENCES=path.join(directory,'preferences.json');
  try {
    saveModelPreference('lmstudio',{source:'other',mode:'native',model:'fixture',baseUrl:'http://127.0.0.1:34567/v1',selectedAt:''});
    const plan={version:1 as const,protectedFiles:['check.cjs'],commands:[{id:'test',criterion:'試験',executable:process.execPath,args:['check.cjs'],timeoutMs:1000}]};
    const command=buildExternalAgentCommand('lmstudio','試験',directory,'tester',{attempt:0},connection,plan)!;
    assert.equal(command.args.at(-1),'http://127.0.0.1:34567/v1');
    assert.deepEqual(JSON.parse(Buffer.from(command.args.at(-2)!,'base64').toString('utf8')),plan);
  } finally {
    if(previous===undefined)delete process.env.WENTIAN_AGENT_MODEL_PREFERENCES;
    else process.env.WENTIAN_AGENT_MODEL_PREFERENCES=previous;
  }
});
