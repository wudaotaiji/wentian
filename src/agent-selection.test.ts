import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSelectionConfig } from './agent-selection.js';

test('AI Native運用判断を設定ファイルから読み込む', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wentian-agent-selection-'));
  const configPath = path.join(directory, 'selection.json');
  await writeFile(configPath, JSON.stringify({ fallback: {
    planner: { model: 'custom/planner', timeoutMs: 45_000 },
    repairPlanner: { model: 'custom/repair', timeoutMs: 20_000 },
    roleTimeoutMs: { builder: 700_000, tester: 200_000, verifier: 210_000, reviewer: 220_000 },
    apiFallbackExcludedAgents: ['CRUSH'],
    agentCapabilities: { custom: ['text', 'file_write', 'invalid'] },
  } }));
  const config = loadAgentSelectionConfig(configPath);
  assert.equal(config.planner.model, 'custom/planner');
  assert.equal(config.roleTimeoutMs.builder, 700_000);
  assert.deepEqual(config.apiFallbackExcludedAgents, ['crush']);
  assert.deepEqual(config.agentCapabilities.custom, ['text', 'file_write']);
});

test('不正なAI Native設定を安全な既定値へ正規化する', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wentian-agent-selection-invalid-'));
  const configPath = path.join(directory, 'selection.json');
  await writeFile(configPath, JSON.stringify({ fallback: {
    planner: { model: '', timeoutMs: -1 }, roleTimeoutMs: { builder: 1 }, agentCapabilities: {},
  } }));
  const config = loadAgentSelectionConfig(configPath);
  assert.equal(config.planner.model, 'wentian-auto/all');
  assert.equal(config.planner.timeoutMs, 120_000);
  assert.equal(config.roleTimeoutMs.builder, 600_000);
  assert.ok(Object.keys(config.agentCapabilities).length >= 8);
});

test('Gooseの標準編集能力も利用者が明示した読取制限を上書きしない',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'wentian-goose-capabilities-')),target=path.join(directory,'selection.json');
 assert.ok(loadAgentSelectionConfig(target).agentCapabilities.goose.includes('file_write'));
 await writeFile(target,JSON.stringify({fallback:{agentCapabilities:{goose:['text','file_read','review']}}}));
 assert.deepEqual(loadAgentSelectionConfig(target).agentCapabilities.goose,['text','file_read','review']);
});
