import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { assertSafeCommand, executeAgentTool, executeDirectAgentCommand, resolveWorkspacePath, kubernetesInspectionArgs } from './agent-tools.js';

test('読み取り専用Kubernetes操作は書込み動詞・秘密情報・追加オプションを受け付けない', () => {
  assert.deepEqual(kubernetesInspectionArgs({ operation: 'top', resource: 'pods', namespace: 'craft', kubeconfig: 'C:\\config', command: 'delete pods' }), ['--kubeconfig', 'C:\\config', '--namespace', 'craft', '--request-timeout=20s', 'top', 'pods']);
  for (const input of [{ operation: 'delete', resource: 'pods' }, { operation: 'get', resource: 'secrets' }, { operation: 'get', resource: 'pods', context: '--exec=evil' }]) assert.throws(() => kubernetesInspectionArgs(input));
});

test('書込み許可なしでも資料を探索でき、ワークスペース外は拒否する', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-discovery-'));
  try {
    await mkdir(path.join(root, 'docs')); await writeFile(path.join(root, 'docs', 'ike-report.md'), '資料');
    const call = (input: unknown) => ({ id: 'list', type: 'function' as const, function: { name: 'list_files', arguments: JSON.stringify(input) } });
    const result = JSON.parse(await executeAgentTool(call({ query: 'ike', depth: 1 }), root, undefined, { allowedWritePaths: [] }));
    assert.deepEqual(result.files, [path.join('docs', 'ike-report.md')]);
    await assert.rejects(executeAgentTool(call({ path: '..' }), root), /ワークスペース外/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ワークスペース作業記録Toolは一時Git Repositoryの履歴・状態だけを読み取る', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wentian-activity-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'isolated baseline'], { cwd: root, windowsHide: true, stdio: 'ignore' });
    await writeFile(path.join(root, 'report.md'), '試験レポート内容');
    const result = JSON.parse(await executeAgentTool({ id: 'activity', type: 'function', function: { name: 'inspect_workspace_activity', arguments: '{}' } }, root));
    assert.equal(result.workspace, root);
    assert.equal(result.root.success, true);
    assert.equal(path.resolve(result.root.output), root);
    assert.equal(result.commits.success, true);
    assert.match(result.commits.output, /isolated baseline/);
    assert.equal(result.status.success, true);
    assert.match(result.status.output, /report\.md/);
    assert.equal(result.diff.success, true);
    assert.match(result.guidance, /list_files/);
    await assert.rejects(executeAgentTool({ id: 'activity-invalid', type: 'function', function: { name: 'inspect_workspace_activity', arguments: '{"command":"Remove-Item"}' } }, root), /引数は不要/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Agent Toolはワークスペース内の相対パスだけを許可する', () => {
  const workspace = path.resolve('workspace-for-test');
  assert.equal(resolveWorkspacePath(workspace, 'docs/readme.md'), path.join(workspace, 'docs', 'readme.md'));
  assert.throws(() => resolveWorkspacePath(workspace, '..\\secret.txt'), /ワークスペース外/);
  assert.equal(resolveWorkspacePath(workspace, path.join(workspace, 'README.md')), path.join(workspace, 'README.md'));
  assert.throws(() => resolveWorkspacePath(workspace, 'C:\\secret.txt'), /ワークスペース外/);
});

test('Agent Toolは読取系コマンドを許可し破壊的コマンドを拒否する', () => {
  assert.doesNotThrow(() => assertSafeCommand('Get-ChildItem src'));
  assert.doesNotThrow(() => assertSafeCommand('git status --short'));
  assert.doesNotThrow(() => assertSafeCommand('Get-ChildItem -Recurse -Depth 2'));
  assert.doesNotThrow(() => assertSafeCommand('Get-ChildItem -Recurse | Select-Object -First 100'));
  assert.throws(() => assertSafeCommand('Get-ChildItem -Path . -Recurse | Select-Object FullName'), /無制限の再帰一覧/);
  assert.throws(() => assertSafeCommand('Remove-Item -Recurse src'), /破壊的/);
  assert.throws(() => assertSafeCommand('git reset --hard'), /破壊的/);
  assert.throws(() => assertSafeCommand('kubectl delete pod sample'), /破壊的/);
  assert.throws(() => assertSafeCommand('Set-Content outside.txt value'), /破壊的/);
});

test('run_commandの巨大な出力はContext送信前に省略する', async () => {
  const result = await executeAgentTool({ id: 'large-output', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: "'A' * 100000" }) } });
  assert.ok(result.length < 100_000);
  assert.match(result, /省略/);
});


test('直接Toolコマンドを識別し、非対象入力を通常会話へ渡す', async () => {
  assert.deepEqual(await executeDirectAgentCommand('こんにちは'), { handled: false });
  const result = await executeDirectAgentCommand(':run Write-Output DIRECT_TOOL_OK');
  assert.equal(result.handled, true);
  assert.match(result.output || '', /DIRECT_TOOL_OK/);
});

test('専用Toolでワークスペース内のファイルを書込み・読取りできる', async () => {
  // OSの一時領域にこのテスト専用ワークスペースを作り、利用者の実ファイルへ影響させません。
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wentian-agent-tool-'));
  try {
    const writeResult = await executeAgentTool({ id: 'write-test', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'notes/result.txt', content: '1行目\n2行目' }) } }, workspace);
    assert.match(writeResult, /notes[\\/]result\.txt/);
    const content = await executeAgentTool({ id: 'read-test', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes/result.txt' }) } }, workspace);
    assert.equal(content, '1行目\n2行目');
  } finally {
    // テスト自身が作成した一時ディレクトリだけを対象として後始末します。
    await rm(workspace, { recursive: true, force: true });
  }
});

test('中断済みSignalではToolを実行しない', async () => {
  const controller = new AbortController();
  controller.abort(new Error('テスト中断'));
  await assert.rejects(() => executeAgentTool({ id: 'abort-test', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'Write-Output NG' }) } }, process.cwd(), controller.signal), /テスト中断/);
});
