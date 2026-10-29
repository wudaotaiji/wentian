import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listSkills, loadSkill, installSkill, parseSkill } from './skills.js';
import { verifyDelivery, validateAcceptance } from './delivery-verification.js';
import { saveOnboardingProvider, onboardingProviderFile } from './onboarding.js';
import { loadProviderFile } from './config.js';
import { createGoal, addTodo, isGoalFinished, loadGoal, requestGoalPause } from './goal-store.js';
import { runGoalLoop } from './goal-loop.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-v060-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('Skillは実際に発見・読み込みでき、上書きと不正な定義を拒否する', async () => fixture(async root => {
  const source = path.join(root, 'sample.md');
  await writeFile(source, '---\nname: sample\ndescription: Sample instructions\n---\nRead actual files.');
  const installed = await installSkill(source, root);
  assert.equal(installed.name, 'sample');
  assert.match(await loadSkill('sample', root, root), /Read actual files/);
  assert.ok((await listSkills(root, root)).some(skill => skill.name === 'verified-delivery'));
  await assert.rejects(installSkill(source, root), /EEXIST/);
  await assert.rejects(loadSkill('../sample', root, root), /見つかりません/);
  assert.throws(() => parseSkill('name: bad', source));
}));

test('不正なSkillを除外し、プロジェクト定義をユーザー定義より優先する', async () => fixture(async root => {
  const workspace = path.join(root, 'project'), home = path.join(root, 'home');
  for (const [base, body] of [[workspace, 'project'], [home, 'home']]) {
    await mkdir(path.join(base, '.wentian/skills/sample'), { recursive: true });
    await writeFile(path.join(base, '.wentian/skills/sample/SKILL.md'), `---\nname: sample\ndescription: ${body}\n---\n${body}`);
  }
  await mkdir(path.join(workspace, '.agents/skills/broken'), { recursive: true });
  await writeFile(path.join(workspace, '.agents/skills/broken/SKILL.md'), 'invalid');
  const skills = await listSkills(workspace, home);
  assert.equal(skills.find(s => s.name === 'sample')?.description, 'project');
  assert.ok(!skills.some(s => s.name === 'broken'));
}));

test('成果検証は実ファイルの内容を検査し、不足・空・未設定を区別する', async () => fixture(async root => {
  await writeFile(path.join(root, 'result.md'), 'Verified result');
  const passed = await verifyDelivery(root, [{ path: 'result.md', contains: 'Verified' }]);
  assert.equal(passed.status, 'passed'); assert.match(passed.evidence[0].sha256!, /^[0-9a-f]{64}$/);
  assert.equal((await verifyDelivery(root, [{ path: 'result.md', contains: 'missing' }])).status, 'failed');
  assert.equal((await verifyDelivery(root, [{ path: 'missing.md' }])).status, 'failed');
  await writeFile(path.join(root, 'empty.md'), '');
  assert.equal((await verifyDelivery(root, [{ path: 'empty.md' }])).status, 'failed');
  assert.equal((await verifyDelivery(root, [])).status, 'pending');
  assert.throws(() => validateAcceptance([{ path: '../outside' }]));
}));

test('初回接続設定は既存Providerを維持し、キーを含む設定を保存する', async () => fixture(async root => {
  const file = path.join(root, 'providers.json');
  await writeFile(file, JSON.stringify([{ id: 'existing', baseUrl: 'http://localhost:1234/v1' }]));
  await saveOnboardingProvider({ baseUrl: 'https://example.com/v1', apiKey: 'test-only', scope: 'remote' }, file);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.providers.length, 2); assert.equal(saved.providers[0].id, 'existing');
  assert.equal(saved.providers[1].apiKey, 'test-only');
  await assert.rejects(saveOnboardingProvider({ baseUrl: 'file:///secret', scope: 'remote' }, file));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).providers.length, 2);
}));

test('初回接続のキーは通常設定に書き込まず、再起動時にローカル設定から復元できる', async () => fixture(async root => {
  const previous = process.env.WENTIAN_INSTALL_ROOT; process.env.WENTIAN_INSTALL_ROOT = root;
  try {
    const file = path.join(root, 'providers.json'); await writeFile(file, '{"providers":[]}');
    await saveOnboardingProvider({ baseUrl: 'http://localhost:1234/v1', apiKey: 'fixture-secret', scope: 'local' });
    assert.equal(await readFile(file, 'utf8'), '{"providers":[]}');
    assert.equal(path.dirname(onboardingProviderFile()), path.join(root, '.wentian'));
    assert.equal(loadProviderFile(onboardingProviderFile())[0].apiKey, 'fixture-secret');
  } finally { if (previous === undefined) delete process.env.WENTIAN_INSTALL_ROOT; else process.env.WENTIAN_INSTALL_ROOT = previous; }
}));

test('Goalは自己申告だけでは完了せず、実成果があれば検証を保存して完了する', async () => fixture(async root => {
  const previous = process.env.WENTIAN_GOAL_PATH; process.env.WENTIAN_GOAL_PATH = path.join(root, 'goals');
  try {
    const goal = await createGoal({ title: 'verified', description: 'test' });
    await addTodo(goal, { title: 'create output', acceptance: [{ path: 'output.md', contains: 'expected' }] });
    const result = await runGoalLoop(goal.id, { cwd: root, server: 'http://unused', model: 'mock', forceWeb: false,
      runOneTodo: async () => ({ ok: true, summary: 'I completed everything!' }),
    });
    assert.equal(result.reason, 'paused'); assert.equal(result.goal.todos[0].verification?.status, 'failed');
    assert.equal(isGoalFinished(result.goal), false);
    const good = await createGoal({ title: 'good', description: 'test' });
    await addTodo(good, { title: 'create output', acceptance: [{ path: 'output.md', contains: 'expected' }] });
    const completed = await runGoalLoop(good.id, { cwd: root, server: 'http://unused', model: 'mock', forceWeb: false,
      runOneTodo: async () => { await writeFile(path.join(root, 'output.md'), 'expected result'); return { ok: true }; },
    });
    assert.equal(completed.reason, 'completed');
    assert.equal((await loadGoal(good.id)).todos[0].verification?.status, 'passed');
  } finally { if (previous === undefined) delete process.env.WENTIAN_GOAL_PATH; else process.env.WENTIAN_GOAL_PATH = previous; }
}));

test('ステップ実行中の一時停止要求は進捗保存で消えず、次のタスクを実行しない', async () => fixture(async root => {
  const previous = process.env.WENTIAN_GOAL_PATH; process.env.WENTIAN_GOAL_PATH = path.join(root, 'goals');
  try {
    const goal = await createGoal({ title: 'pause', description: 'test' });
    await addTodo(goal, { title: 'first', acceptance: [{ path: 'done.md' }] });
    await addTodo(goal, { title: 'second', acceptance: [{ path: 'done.md' }] });
    let calls = 0;
    const result = await runGoalLoop(goal.id, { cwd: root, server: 'http://unused', model: 'mock', forceWeb: false,
      runOneTodo: async () => { calls++; await requestGoalPause(goal.id); await writeFile(path.join(root, 'done.md'), 'done'); return { ok: true }; },
    });
    assert.equal(calls, 1); assert.equal(result.reason, 'paused'); assert.equal(result.goal.todos[0].status, 'done');
  } finally { if (previous === undefined) delete process.env.WENTIAN_GOAL_PATH; else process.env.WENTIAN_GOAL_PATH = previous; }
}));
