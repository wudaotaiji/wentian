import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTaskWorkspace, publishTaskWorkspace } from './task-workspace.js';
import { captureArtifactSnapshot, compareArtifactSnapshots } from './artifact-evidence.js';
import { orchestrateExternalTask } from './external-orchestrator.js';
import { validateAgentPlan } from './agent-planner.js';
import type { ExternalAgentStatus } from './external-agents.js';
import { executeAgentTool } from './agent-tools.js';
import { runDirectTask } from './direct-task.js';
import { withVerifiedWork } from './work-test-fixture.js';

test('未コミット・未追跡を複製し、制作とresetが原本の内容・Git状態を変えない', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-source-'));
  let isolated: string | undefined;
  const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  try {
    git(source, ['init', '--template=', '--initial-branch=main']);
    git(source, ['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(source, 'app.txt'), '確定済み');
    await writeFile(path.join(source, '.gitignore'), 'private.txt\n');
    git(source, ['add', '.']);
    git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgSign=false', 'commit', '-m', '初期状態']);
    await writeFile(path.join(source, 'app.txt'), '人間の編集中');
    await writeFile(path.join(source, '新規 file.txt'), '未追跡');
    await writeFile(path.join(source, 'private.txt'), 'コピー対象外');
    const head = git(source, ['rev-parse', 'HEAD']);
    const status = git(source, ['status', '--porcelain']);
    const workspace = await createTaskWorkspace(source);
    isolated = workspace.directory;
    assert.equal(await readFile(path.join(isolated, 'app.txt'), 'utf8'), '人間の編集中');
    assert.equal(await readFile(path.join(isolated, '新規 file.txt'), 'utf8'), '未追跡');
    await assert.rejects(readFile(path.join(isolated, 'private.txt')), { code: 'ENOENT' });
    assert.equal(git(isolated, ['status', '--porcelain']), '');
    // 外部Agentの制作を模擬し、差分の対象が専用作業場所であることを確認します。
    await writeFile(path.join(isolated, 'app.txt'), 'Agentの変更');
    const evidence = compareArtifactSnapshots(workspace.baseline, await captureArtifactSnapshot(isolated));
    assert.deepEqual(evidence.changes.map(item => item.path), ['app.txt']);
    assert.equal(await readFile(path.join(source, 'app.txt'), 'utf8'), '人間の編集中');
    // 一時リポジトリだけに復旧を実行します。原本の未コミット変更は保持されます。
    git(isolated, ['reset', '--hard', workspace.baselineSha]);
    assert.equal(await readFile(path.join(isolated, 'app.txt'), 'utf8'), '人間の編集中');
    assert.equal(git(source, ['rev-parse', 'HEAD']), head);
    assert.equal(git(source, ['status', '--porcelain']), status);
    assert.equal(await readFile(path.join(source, 'app.txt'), 'utf8'), '人間の編集中');
  } finally {
    // このテストで作った一時ディレクトリのみを片付けます。
    if (isolated) await rm(isolated, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('Git管理外もSnapshotを作成し、原本を直接変更しない', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-source-'));
  let isolated: string | undefined;
  try {
    await writeFile(path.join(source, 'keep.txt'), '保持');
    const workspace = await createTaskWorkspace(source);
    isolated = workspace.directory;
    assert.equal(await readFile(path.join(isolated, 'keep.txt'), 'utf8'), '保持');
    assert.equal(await readFile(path.join(source, 'keep.txt'), 'utf8'), '保持');
  } finally { if (isolated) await rm(isolated, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); }
});

test('非Git Targetへ追加成果物を反映し、制作中の競合は拒否する', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-publish-'));
  let isolated: string | undefined;
  try {
    await writeFile(path.join(source, 'keep.txt'), '開始時点');
    const workspace = await createTaskWorkspace(source); isolated = workspace.directory;
    await writeFile(path.join(isolated, 'game.html'), '<canvas></canvas>');
    const evidence = compareArtifactSnapshots(workspace.baseline, await captureArtifactSnapshot(isolated));
    const published = await publishTaskWorkspace(workspace, evidence.changes);
    assert.equal(published.status, 'published');
    assert.equal(await readFile(path.join(source, 'game.html'), 'utf8'), '<canvas></canvas>');
    await writeFile(path.join(isolated, 'keep.txt'), 'Agent変更');
    await writeFile(path.join(source, 'keep.txt'), '利用者変更');
    const conflictEvidence = compareArtifactSnapshots(workspace.baseline, await captureArtifactSnapshot(isolated));
    assert.equal((await publishTaskWorkspace(workspace, conflictEvidence.changes)).status, 'conflict');
    assert.equal(await readFile(path.join(source, 'keep.txt'), 'utf8'), '利用者変更');
  } finally { if (isolated) await rm(isolated, { recursive: true, force: true }); await rm(source, { recursive: true, force: true }); }
});

test('通常の制作経路で全担当へ専用cwdを渡し、成果物と台帳を検収待ちとして返す', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-source-'));
  // 利用者のAgent設定・検証記録を読まず、この試験専用の空ファイルへ隔離します。
  const agentEnvNames = ['WENTIAN_AGENT_EXCLUSIONS_FILE','WENTIAN_AGENT_REGISTRATIONS_FILE','WENTIAN_AGENT_MANAGEMENT_FILE','WENTIAN_AGENT_CONNECTION_CACHE','WENTIAN_AGENT_WORK_CACHE','WENTIAN_AGENT_PERFORMANCE_FILE'] as const;
  const previousAgentEnv = agentEnvNames.map(name => process.env[name]);
  for (const name of agentEnvNames) process.env[name] = path.join(source, `${name}.json`);
  let isolated: string | undefined;
  try {
    execFileSync('git', ['init', '--template=', source], { stdio: 'pipe' });
    await writeFile(path.join(source, 'app.txt'), '原本');
    await writeFile(path.join(source, 'criteria.txt'), 'app.txtが成果物になること');
    await mkdir(path.join(source, '.wentian'));
    await writeFile(path.join(source, '.wentian', 'acceptance.json'), JSON.stringify({
      version: 1, protectedFiles: ['criteria.txt'], commands: [{ id: 'content', criterion: 'app.txtの内容一致', executable: process.execPath,
        args: ['-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("app.txt","utf8"),"成果物")'], timeoutMs: 5000 }],
    }));
    const agents: ExternalAgentStatus[] = ['kilo', 'goose', 'crush'].map(id => withVerifiedWork({ id, name: id, state: 'available' as const, stateLabel: '', note: '', freshWithin24Hours: true, liveState: 'healthy' as const }));
    // 制作試験では実装と最終検証に異なる確定モデルを使います。動的な無料モデルは独立性を保証できません。
    for (const agent of agents) {
      agent.connection!.model = `fixture/${agent.id}`;
      Object.assign(agent, withVerifiedWork(agent));
    }
    const roles: string[] = [];
    const result = await orchestrateExternalTask(validateAgentPlan({ intent: 'delegate_external', operation: 'write', required_capabilities: ['file_write'], tools: ['write_file'], delegation: { enabled: true } }, 'ファイルを実装して\n書き込み範囲: .'), { workspace: source, enabled: true }, {
      loadSnapshot: async () => ({ source: 'テスト', cacheFreshWithin24Hours: true, agents, summary: { total: 3, available: 3, candidate: 0, needs_recheck: 0, unavailable: 0 } }),
      readyAgents: async () => agents,
      runCommand: async (command, options) => {
        assert.notEqual(options.cwd, source);
        assert.ok(command.args.some(arg => arg.includes(options.cwd)));
        isolated = options.cwd;
        roles.push(options.role);
        if (options.role === 'builder') await writeFile(path.join(options.cwd, 'app.txt'), '成果物');
        else assert.equal(await readFile(path.join(options.cwd, 'app.txt'), 'utf8'), '成果物');
        return '実ファイルと検証結果を確認しました。\nWENTIAN_ROLE_RESULT: PASS';
      },
    });
    assert.deepEqual(roles, ['builder', 'tester', 'verifier']);
    assert.equal(result.status, 'completed');
    assert.equal(result.acceptance?.status, 'passed');
    assert.equal(result.acceptance?.commands[0].exitCode, 0);
    assert.equal(result.workspace?.directory, isolated);
    assert.equal(await readFile(path.join(source, 'app.txt'), 'utf8'), '成果物');
    assert.equal(result.publication?.status, 'published');
    assert.deepEqual(result.evidence?.changes.map(change => change.path), ['app.txt']);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.task.workspace, isolated);
    assert.equal(manifest.result.workspace.source, await import('node:fs/promises').then(fs => fs.realpath(source)));
  } finally {
    agentEnvNames.forEach((name, index) => {
      const previous = previousAgentEnv[index];
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    });
    if (isolated) await rm(isolated, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('Git無視対象の明示指定とツール書込みを事前拒否し、原本を維持する', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-ignored-'));
  try {
    execFileSync('git', ['init', '--template=', source], { stdio: 'pipe' });
    await writeFile(path.join(source, '.gitignore'), 'private.txt\n');
    await writeFile(path.join(source, 'private.txt'), '維持する内容');
    const plan = validateAgentPlan({}, 'private.txtを修正してください。\n編集対象: private.txt');
    let executed = false;
    const result = await runDirectTask(plan, source, async () => { executed = true; return '実行されない'; });
    assert.equal(executed, false);
    assert.equal(result.outcome.status, 'failed');
    assert.match(result.outcome.reason || '', /Git無視対象/);
    await assert.rejects(() => executeAgentTool({ id: 'ignored', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'private.txt', content: '変更しない' }) } }, source, undefined, { allowedWritePaths: ['.'] }), /Git無視対象/);
    assert.equal(await readFile(path.join(source, 'private.txt'), 'utf8'), '維持する内容');
  } finally { await rm(source, { recursive: true, force: true }); }
});


test('保守の隔離コピーは指定した専用領域内に作り原本を変更しない',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'wentian-maintenance-scope-'));
  try {
    const source=path.join(root,'source');await mkdir(source);await writeFile(path.join(source,'input.txt'),'検証入力');
    const workspace=await createTaskWorkspace(source,root);
    assert.equal(path.dirname(workspace.directory),root);
    assert.notEqual(workspace.directory,source);
    await writeFile(path.join(workspace.directory,'input.txt'),'隔離変更');
    assert.equal(await readFile(path.join(source,'input.txt'),'utf8'),'検証入力');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('受入設定がなくても明示Targetへ成果物を反映し、要検収として返す', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'wentian-direct-publish-'));
  try {
    const plan = validateAgentPlan({}, 'index.htmlを作成してください。');
    plan.allowedWritePaths = ['.'];
    const result = await runDirectTask(plan, source, async workspace => {
      await writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>game</title>');
      return 'index.htmlを作成しました。';
    });
    assert.equal(result.outcome.status, 'needs_review');
    assert.match(result.outcome.reason || '', /変更は反映済みです/);
    assert.equal(await readFile(path.join(source, 'index.html'), 'utf8'), '<!doctype html><title>game</title>');
  } finally { await rm(source, { recursive: true, force: true }); }
});
