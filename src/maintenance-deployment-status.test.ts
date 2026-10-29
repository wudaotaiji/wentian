import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { maintenanceDeploymentCutoff, writeMaintenanceDeploymentStatus } from './maintenance-deployment-status.js';
import { connectionStatusUpdate } from './agent-connection-maintenance.js';
import { workIdentity } from './agent-work-policy.js';
import type { ExternalAgentStatus } from './external-agents.js';

test('配備後の古い成功記録は利用可能にせず、変更後の接続と作業を確認する', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-deployment-status-'));
  const previous = process.env.WENTIAN_AI_MAINTENANCE_ROOT; process.env.WENTIAN_AI_MAINTENANCE_ROOT = root;
  t.after(() => { if (previous === undefined) delete process.env.WENTIAN_AI_MAINTENANCE_ROOT; else process.env.WENTIAN_AI_MAINTENANCE_ROOT = previous; });
  const now = Date.now(), at = new Date(now).toISOString(), old = new Date(now - 1000).toISOString(), fresh = new Date(now + 1000).toISOString();
  const agent: ExternalAgentStatus = { id: 'kilo', name: 'Kilo', cli: 'kilo', liveState: 'healthy', state: 'needs_recheck', stateLabel: '', note: '', version: '1', freshWithin24Hours: true };
  const connection = { mode: 'local' as const, model: 'fixture', status: 'verified' as const, checkedAt: old, expiresAt: new Date(now + 60000).toISOString(), fingerprint: 'x', policyHash: 'x', cliVersion: '1' };
  const work = { revision: 1 as const, identity: workIdentity(connection, '1'), status: 'passed' as const, checkedAt: old, expiresAt: new Date(now + 60000).toISOString(), retryAt: at, capabilities: { reading: true }, evidenceDirectory: '', reason: '' };
  await writeMaintenanceDeploymentStatus({ status: 'pending', at, candidateId: 'fixture' });
  assert.equal(maintenanceDeploymentCutoff(), Infinity); assert.equal(connectionStatusUpdate(agent, connection, work).state, 'needs_recheck');
  await writeMaintenanceDeploymentStatus({ status: 'deployed', at, candidateId: 'fixture' });
  assert.equal(connectionStatusUpdate(agent, connection, work).state, 'needs_recheck');
  assert.equal(connectionStatusUpdate(agent, { ...connection, checkedAt: fresh }, { ...work, checkedAt: fresh }).state, 'available');
  await writeMaintenanceDeploymentStatus({ status: 'rolled_back', at, candidateId: 'fixture' });
  assert.equal(maintenanceDeploymentCutoff(), undefined);
  await writeFile(path.join(root, 'deployment-status', 'current.json'), 'invalid');
  assert.equal(maintenanceDeploymentCutoff(), Infinity);
});
