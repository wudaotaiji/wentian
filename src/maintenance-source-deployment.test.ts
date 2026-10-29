import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deployVerifiedMaintenanceCandidate } from './maintenance-source-deployment.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-deploy-fixture-'));
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wentian-task-'));
  const staging = await mkdtemp(path.join(os.tmpdir(), 'wentian-proposals-'));
  const id = '00000000-0000-4000-8000-000000000001', proposal = path.join(staging, id);
  for (const directory of [path.join(root, 'src'), path.join(workspace, 'src'), proposal]) await mkdir(directory, { recursive: true });
  const source = 'src/agent-native-models.ts', testPath = 'src/example.test.ts';
  await writeFile(path.join(root, source), 'before'); await writeFile(path.join(workspace, source), 'after');
  await writeFile(path.join(workspace, testPath), 'test');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  await writeFile(path.join(proposal, 'verified.json'), JSON.stringify({ version: 1, status: 'candidate_verified', candidateId: id, source, beforeHash: hash('before'), afterHash: hash('after'), test: testPath, testHash: hash('test'), workspace, installRoot: root }));
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root, windowsHide: true });
  await git(['init', '--template=']); await git(['add', '--', source]);
  await git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'disabled-hooks')}`, 'commit', '-m', 'fixture']);
  return { root, staging, id, source, proposal, workspace };
}

test('検証済みの変更を競合検査後に反映し、再起動後もAgent自体は未確認のままにする', async () => {
  const f = await fixture(); const calls: string[] = [];
  const result = await deployVerifiedMaintenanceCandidate({ candidateId: f.id }, f.staging, f.root, {
    authorized: async () => true, healthy: async () => { calls.push('health'); return true; }, stop: async () => { calls.push('stop'); }, start: async () => { calls.push('start'); },
  });
  assert.equal(result.status, 'deployed_pending_agent_verification');
  assert.equal(await readFile(path.join(f.root, f.source), 'utf8'), 'after');
  assert.deepEqual(calls, ['health', 'stop', 'start', 'health']);
});

test('再起動後の検査失敗は元ソースを復元して再起動する', async () => {
  const f = await fixture(); let health = 0, starts = 0;
  const result = await deployVerifiedMaintenanceCandidate({ candidateId: f.id }, f.staging, f.root, {
    authorized: async () => true, healthy: async () => ++health === 1, stop: async () => {}, start: async () => { starts++; },
  });
  assert.equal(result.status, 'rolled_back'); assert.equal(starts, 2);
  assert.equal(await readFile(path.join(f.root, f.source), 'utf8'), 'before');
});

test('利用者が対象を変更した場合は上書きしない', async () => {
  const f = await fixture(); await writeFile(path.join(f.root, f.source), 'user change'); let stopped = false;
  await assert.rejects(deployVerifiedMaintenanceCandidate({ candidateId: f.id }, f.staging, f.root, {
    authorized: async () => true, healthy: async () => true, stop: async () => { stopped = true; }, start: async () => {},
  }));
  assert.equal(stopped, false); assert.equal(await readFile(path.join(f.root, f.source), 'utf8'), 'user change');
});

test('再起動直前の停止要求を尊重し、ソースを復元する', async () => {
  const f = await fixture(); let checks = 0, stopped = false;
  const result = await deployVerifiedMaintenanceCandidate({ candidateId: f.id }, f.staging, f.root, {
    authorized: async () => ++checks < 3, healthy: async () => true, markPending: async () => {},
    stop: async () => { stopped = true; }, start: async () => assert.fail('停止前には起動しません'),
  });
  assert.equal(result.status, 'rolled_back'); assert.equal(stopped, false);
  assert.equal(await readFile(path.join(f.root, f.source), 'utf8'), 'before');
});

test('配備中の利用者変更を復元処理で上書きしない', async () => {
  const f = await fixture();
  const result = await deployVerifiedMaintenanceCandidate({ candidateId: f.id }, f.staging, f.root, {
    authorized: async () => true, healthy: async () => true,
    markPending: async () => { await writeFile(path.join(f.root, f.source), 'user later change'); },
    stop: async () => {}, start: async () => assert.fail('未検証の変更は起動しません'),
  });
  assert.equal(result.status, 'recovery_required');
  assert.equal(await readFile(path.join(f.root, f.source), 'utf8'), 'user later change');
});
